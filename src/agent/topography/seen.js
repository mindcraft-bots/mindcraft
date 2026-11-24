/**
 * Reports which chunks the bot has loaded ("seen") and no longer has loaded to the terrain service,
 * so queries can treat unseen chunks as unexplored and show chunks the bot has left as it last saw
 * them (last-seen map). Batched (<= 1 POST per interval), fire-and-forget, never throws.
 *
 * Protocol (POST /seen): { agent, dimension, chunks: [[cx,cz]...] (loaded), unloaded: [[cx,cz]...],
 * replace?: true }. With `replace` the `chunks` list is the complete loaded set, which resyncs the
 * service: sent on the first flush, after any failed POST (the service may have restarted), after a
 * respawn / dimension change, on disconnect (empty) and every `resyncMs` as a heartbeat (the service
 * treats a silent agent as having unloaded everything).
 *
 * Within a batch the last event per chunk wins, so a chunk that loaded and then unloaded before the
 * flush is sent as unloaded (and still counts as seen); repeat loads are never suppressed.
 */
import settings from '../settings.js';
import { getServiceUrl, normalizeDimension, terrainAgentName, serviceHeaders } from './service.js';

const MAX_PER_POST = 2000;
const BACKOFF_MS = 15000;
const RESPAWN_RESCAN_MS = 1000;
const INITIAL_RESCAN_MS = 1500;

function cfg(agent, key, fallback) {
    return agent?.prompter?.profile?.[key] ?? settings[key] ?? fallback;
}

export class SeenReporter {
    constructor(agent, { intervalMs = 2000, fetchImpl = null, resyncMs = 30000 } = {}) {
        this.agent = agent;
        this.intervalMs = intervalMs;
        this.fetchImpl = fetchImpl;
        this.resyncMs = resyncMs;
        this.pending = new Map(); // dimension -> Map("cx,cz" -> { op: 'load'|'unload', n })
        this.loaded = new Map();  // dimension -> Set("cx,cz"): what the bot has loaded right now
        this.resyncAll = true;    // the first flush is a full resync
        this.seq = 0;
        this.lastFlush = 0;
        this.timer = null;
        this.resyncTimer = null;
        this.initTimer = null;
        this.bot = null;
        this.inflight = null;
        this.blockedUntil = 0;
        this.posts = 0;
    }

    /** Stop heartbeat / delayed-rescan timers (disconnect, reconnect, tests). */
    stop() {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        if (this.resyncTimer) { clearInterval(this.resyncTimer); this.resyncTimer = null; }
        if (this.initTimer) { clearTimeout(this.initTimer); this.initTimer = null; }
    }

    enabled() {
        return cfg(this.agent, 'cartography_enabled', false) !== false && cfg(this.agent, 'topography_seen_only', true) !== false;
    }

    dimension() {
        return normalizeDimension(this.agent?.bot?.game?.dimension) ?? 'minecraft:overworld';
    }

    _record(dimension, key, op) {
        let ops = this.pending.get(dimension);
        if (!ops) this.pending.set(dimension, ops = new Map());
        ops.set(key, { op, n: ++this.seq });
        let loaded = this.loaded.get(dimension);
        if (!loaded) this.loaded.set(dimension, loaded = new Set());
        if (op === 'load') loaded.add(key); else loaded.delete(key);
        this._schedule();
    }

    addChunk(cx, cz, dimension = this.dimension()) {
        if (!Number.isFinite(cx) || !Number.isFinite(cz)) return;
        this._record(dimension, `${cx},${cz}`, 'load');
    }

    removeChunk(cx, cz, dimension = this.dimension()) {
        if (!Number.isFinite(cx) || !Number.isFinite(cz)) return;
        this._record(dimension, `${cx},${cz}`, 'unload');
    }

    /** Chunk keys (``"cx,cz"``) this reporter currently believes are loaded. */
    loadedKeys(dimension = this.dimension()) {
        return [...(this.loaded.get(dimension) ?? [])];
    }

    _schedule() {
        if (this.timer) return;
        const now = Date.now();
        const delay = Math.max(0, this.lastFlush + this.intervalMs - now, this.blockedUntil - now);
        this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, delay);
        this.timer.unref?.();
    }

    /** Replace what we think is loaded with the bot's actual columns (after respawn / dimension change). */
    async _rescan(bot) {
        const columns = await Promise.resolve(bot.world?.getColumns?.());
        if (!Array.isArray(columns)) return;
        const dimension = this.dimension();
        for (const dim of this.loaded.keys()) this.loaded.set(dim, new Set());
        const set = new Set();
        for (const c of columns) if (Number.isFinite(Number(c?.chunkX)) && Number.isFinite(Number(c?.chunkZ))) set.add(`${Number(c.chunkX)},${Number(c.chunkZ)}`);
        this.loaded.set(dimension, set);
        this.resyncAll = true;
        this._schedule();
    }

    attach(bot, { chunkEvents = true } = {}) {
        this.stop();
        this.bot = bot;
        // a reconnect gives a new bot: whatever the old one had loaded is gone
        for (const dim of this.loaded.keys()) this.loaded.set(dim, new Set());
        this.pending.clear();
        this.resyncAll = true;
        if (chunkEvents) {
            bot.on('chunkColumnLoad', (point) => {
                if (this.bot !== bot) return; // stale bot after a reconnect
                try { this.addChunk(Math.floor(point.x / 16), Math.floor(point.z / 16)); } catch { /* never throw */ }
            });
            bot.on('chunkColumnUnload', (point) => {
                if (this.bot !== bot) return;
                try { this.removeChunk(Math.floor(point.x / 16), Math.floor(point.z / 16)); } catch { /* never throw */ }
            });
        }
        // death / respawn / dimension change: the loaded set may have been rebuilt without unload events
        bot.on('respawn', () => {
            if (this.bot !== bot) return;
            try {
                const t = setTimeout(() => this._heartbeat(), RESPAWN_RESCAN_MS);
                t.unref?.();
            } catch { /* never throw */ }
        });
        // disconnect: nothing stays loaded (best effort; the service also times out a silent agent)
        bot.on('end', () => {
            if (this.bot !== bot) return;
            try {
                this.stop();
                this.bot = null;
                for (const dim of this.loaded.keys()) this.loaded.set(dim, new Set());
                this.resyncAll = true;
                this.blockedUntil = 0;
                this.flush().catch(() => {});
            } catch { /* never throw */ }
        });
        if (this.resyncMs > 0) {
            // Heartbeats are also a full column rescan: chunks that were already loaded when
            // attach() ran (or that never fired chunkColumnLoad) must not stay frozen forever.
            this.resyncTimer = setInterval(() => { this._heartbeat(); }, this.resyncMs);
            this.resyncTimer.unref?.();
            // The first rescan races world load; run it again shortly after spawn.
            this.initTimer = setTimeout(() => { this.initTimer = null; this._heartbeat(); }, INITIAL_RESCAN_MS);
            this.initTimer.unref?.();
        }
        // chunks already loaded before we attached
        Promise.resolve().then(async () => {
            const columns = await Promise.resolve(bot.world?.getColumns?.());
            for (const c of columns ?? []) this.addChunk(Number(c.chunkX), Number(c.chunkZ));
        }).catch(() => {});
    }

    /** Re-read the bot's real columns, then resync. Fixes chunks missed by attach-time events. */
    async _heartbeat() {
        const bot = this.bot;
        if (!bot) return;
        try { await this._rescan(bot); } catch { /* keep the previous set */ }
        this.resyncAll = true;
        this._schedule();
    }

    flush() {
        if (this.inflight) return this.inflight;
        this.inflight = this._flush().finally(() => { this.inflight = null; });
        return this.inflight;
    }

    async _flush() {
        this.lastFlush = Date.now();
        if (!this.enabled()) { this.pending.clear(); return 0; }
        const resyncAll = this.resyncAll;
        this.resyncAll = false; // anything that happens while we post sets it again
        const dimensions = new Set(this.pending.keys());
        if (resyncAll) for (const dim of this.loaded.keys()) dimensions.add(dim);
        let total = 0;
        for (const dimension of dimensions) {
            const ops = this.pending.get(dimension) ?? new Map();
            const entries = [...ops.entries()];
            const resync = resyncAll;
            const unloads = entries.filter(([, v]) => v.op === 'unload').slice(0, MAX_PER_POST);
            const loads = resync ? entries.filter(([, v]) => v.op === 'load')
                : entries.filter(([, v]) => v.op === 'load').slice(0, Math.max(0, MAX_PER_POST - unloads.length));
            const toPair = (k) => k.split(',').map(Number);
            const chunks = resync ? [...(this.loaded.get(dimension) ?? [])].map(toPair) : loads.map(([k]) => toPair(k));
            const body = {
                agent: terrainAgentName(this.agent) ?? this.agent.name, dimension,
                chunks, unloaded: unloads.map(([k]) => toPair(k)),
            };
            if (resync) body.replace = true;
            if (!resync && !chunks.length && !body.unloaded.length) continue;
            try {
                const doFetch = this.fetchImpl ?? fetch;
                const res = await doFetch(`${getServiceUrl()}/seen`, {
                    method: 'POST', headers: serviceHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(3000),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                this.posts++;
                total += loads.length + unloads.length;
                // forget what was sent unless the chunk changed state while the request was in flight
                const current = this.pending.get(dimension);
                for (const [k, v] of [...loads, ...unloads]) {
                    if (current?.get(k)?.n === v.n) current.delete(k);
                }
                if (current && !current.size) this.pending.delete(dimension);
            } catch {
                // service down or older: keep everything queued, resync on recovery, back off so we never spam
                this.resyncAll = true;
                this.blockedUntil = Date.now() + BACKOFF_MS;
                break;
            }
        }
        if (this.pending.size) this._schedule();
        return total;
    }
}
