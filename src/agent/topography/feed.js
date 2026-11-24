/**
 * Bot-fed chunk forwarding: `POST /chunk_raw` plus the seen ledger in one module.
 *
 * Owns `chunkColumnLoad` / `chunkColumnUnload` / `blockUpdate`. Nothing in an
 * event handler awaits the network: loads are queued, block changes are debounced
 * into the same queue, and a small pump serialises at most 4 chunks per turn
 * from `bot.world.getColumn` (a chunk that is no longer loaded is skipped).
 *
 * Contract (cartography-service docs/CONTRACT.md, `POST /chunk_raw`): names, not state ids; single-value
 * sections have no `data`; indirect containers are `packed` with their own bit
 * width; direct containers are converted to a local name palette and sent as
 * `u16`. Sections that are entirely air are omitted. Biomes ride along.
 *
 * Failure is always non-fatal: a failed batch is retried once, a second failure
 * drops it and sets the resync flag, and at most one warning is printed a minute.
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';
import settings from '../settings.js';
import { getServiceUrl, serviceHeaders } from './service.js';
import { SeenReporter } from './seen.js';

const gzip = promisify(zlib.gzip);

const MAX_QUEUE = 4096;
const BATCH = 4;
const MAX_INFLIGHT = 2;
const DEBOUNCE_MS = 2000;
const MAX_DELAY_MS = 10000;
const REFORWARD_MS = 5000;
const TICK_MS = 1000;
const TIMEOUT_MS = 5000;
const GZIP_OVER = 8192;
const WARN_EVERY_MS = 60000;

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

function cfg(agent, key, fallback) {
    return agent?.prompter?.profile?.[key] ?? settings[key] ?? fallback;
}

export class Feed {
    constructor(agent, { fetchImpl = null, now = () => Date.now(), seen = null } = {}) {
        this.agent = agent;
        this.fetchImpl = fetchImpl;
        this.now = now;
        this.seen = seen ?? new SeenReporter(agent);
        this.bot = null;
        this.queue = new Map();     // "cx,cz" -> {cx, cz, attempts}
        this.dirty = new Map();     // "cx,cz" -> {first, last}
        this.lastSent = new Map();  // "cx,cz" -> timestamp
        this.names = new Map();     // state id -> name
        this.biomeNames = new Map();
        this.inflight = 0;
        this.resync = false;
        this.timer = null;
        this.resyncTimer = null;
        this.warnAt = 0;
        this.pumpScheduled = false;
        this.sent = 0;
        this.failed = 0;
    }

    enabled() {
        if (cfg(this.agent, 'cartography_enabled', false) === false)
            return false;
        return cfg(this.agent, 'topography_feed', 'bot') !== 'off';
    }

    attach(bot, seen = null) {
        this.stop();
        this.bot = bot;
        if (seen)
            this.seen = seen;
        if (!this.seen)
            throw new Error('Feed needs a SeenReporter');
        const feedOn = this.enabled();
        // One module owns the chunk events; the reporter still owns the heartbeat,
        // respawn rescan and the POST /seen batches. With the feed off, the
        // reporter attaches exactly as it does on its own.
        this.seen.attach(bot, { chunkEvents: !feedOn });
        if (!feedOn) return;
        bot.on('chunkColumnLoad', (point) => {
            if (this.bot !== bot) return;
            try {
                const cx = Math.floor(point.x / 16);
                const cz = Math.floor(point.z / 16);
                this.seen.addChunk(cx, cz);
                this._enqueue(cx, cz);
            } catch { /* never throw from an event */ }
        });
        bot.on('chunkColumnUnload', (point) => {
            if (this.bot !== bot) return;
            try {
                const cx = Math.floor(point.x / 16);
                const cz = Math.floor(point.z / 16);
                const key = `${cx},${cz}`;
                this.queue.delete(key);
                this.dirty.delete(key);
                this.seen.removeChunk(cx, cz);
            } catch { /* never throw from an event */ }
        });
        bot.on('blockUpdate', (oldBlock, newBlock) => {
            if (this.bot !== bot) return;
            try {
                if (!newBlock?.position) return;
                if (oldBlock?.stateId === newBlock.stateId) return; // door toggles / fluid levels
                const cx = Math.floor(newBlock.position.x / 16);
                const cz = Math.floor(newBlock.position.z / 16);
                this._markDirty(cx, cz);
            } catch { /* never throw from an event */ }
        });
        bot.on('respawn', () => {
            if (this.bot !== bot) return;
            this.resync = true;
            this._resyncSoon();
        });
        bot.on('end', () => {
            if (this.bot !== bot) return;
            this.stop();
        });
        this.timer = setInterval(() => {
            try { this._tick(); } catch { /* never throw */ }
        }, TICK_MS);
        this.timer.unref?.();
        this.resync = true;
        this._resyncSoon();
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.resyncTimer) { clearTimeout(this.resyncTimer); this.resyncTimer = null; }
        this.queue.clear();
        this.dirty.clear();
    }

    _resyncSoon() {
        // Give a freshly spawned bot a moment to populate its columns.
        if (this.resyncTimer) clearTimeout(this.resyncTimer);
        this.resyncTimer = setTimeout(() => {
            this.resyncTimer = null;
            try { this._resync(); } catch { /* never throw */ }
        }, 1500);
        this.resyncTimer.unref?.();
    }

    _resync() {
        if (!this.enabled()) return;
        this.resync = true;
        const columns = this.bot?.world?.getColumns?.() ?? [];
        for (const column of columns) {
            // mineflayer returns chunk coordinates as strings ("-12"), so coerce before the finite check.
            const cx = Number(column?.chunkX), cz = Number(column?.chunkZ);
            if (Number.isFinite(cx) && Number.isFinite(cz))
                this.queue.set(`${cx},${cz}`, { cx, cz, attempts: 0 });
        }
        // A replace:true seen report is the matching ledger resync.
        this.seen?._heartbeat?.().catch?.(() => {});
        this._pump();
    }

    _markDirty(cx, cz) {
        if (!Number.isFinite(cx) || !Number.isFinite(cz)) return;
        const key = `${cx},${cz}`;
        const now = this.now();
        const entry = this.dirty.get(key);
        if (entry) entry.last = now;
        else this.dirty.set(key, { first: now, last: now });
    }

    _enqueue(cx, cz) {
        if (!this.enabled()) return;
        const key = `${cx},${cz}`;
        const now = this.now();
        if (now - (this.lastSent.get(key) ?? -Infinity) < REFORWARD_MS) return;
        if (this.queue.has(key)) return;
        if (this.queue.size >= MAX_QUEUE) {
            const oldest = this.queue.keys().next().value;
            if (oldest !== undefined) this.queue.delete(oldest);
            this.resync = true;
        }
        this.queue.set(key, { cx, cz, attempts: this.queue.get(key)?.attempts ?? 0 });
        this._pump();
    }

    _tick() {
        const now = this.now();
        for (const [key, entry] of [...this.dirty]) {
            if (now - entry.last >= DEBOUNCE_MS || now - entry.first >= MAX_DELAY_MS) {
                this.dirty.delete(key);
                const [cx, cz] = key.split(',').map(Number);
                this._enqueue(cx, cz);
            }
        }
        this._pump();
    }

    _pump() {
        if (this.pumpScheduled) return;
        if (!this.enabled() || !this.bot || this.inflight >= MAX_INFLIGHT || this.queue.size === 0) return;
        this.pumpScheduled = true;
        setImmediate(() => {
            this.pumpScheduled = false;
            this._sendBatch().catch(() => { /* never throws into the bot */ });
        });
    }

    async _sendBatch() {
        if (this.inflight >= MAX_INFLIGHT || this.queue.size === 0) return;
        const batch = [];
        for (const [key, entry] of this.queue) {
            if (batch.length >= BATCH) break;
            this.queue.delete(key);
            batch.push(entry);
        }
        if (batch.length === 0) return;
        const chunks = [];
        for (const entry of batch) {
            try {
                const payload = this.serialize(entry.cx, entry.cz);
                if (payload) chunks.push(payload);
            } catch { /* skip a chunk that cannot be serialised */ }
        }
        if (chunks.length === 0) {
            this._pump();
            return;
        }
        const body = JSON.stringify({
            agent: this.agent.name,
            dimension: 'minecraft:overworld',
            format: 1,
            chunks,
        });
        let raw = Buffer.from(body, 'utf8');
        const headers = serviceHeaders({ 'Content-Type': 'application/json' });
        if (raw.length > GZIP_OVER) {
            raw = await gzip(raw);
            headers['Content-Encoding'] = 'gzip';
        }
        this.inflight++;
        try {
            const doFetch = this.fetchImpl ?? globalThis.fetch;
            const response = await doFetch(`${getServiceUrl()}/chunk_raw`, {
                method: 'POST',
                headers,
                body: raw,
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            this.sent += batch.length;
            const now = this.now();
            for (const entry of batch) {
                this.lastSent.set(`${entry.cx},${entry.cz}`, now);
                if (this.lastSent.size > 20000) {
                    const oldest = this.lastSent.keys().next().value;
                    if (oldest !== undefined) this.lastSent.delete(oldest);
                }
            }
            if (this.resync) {
                // first success after a failure: everything loaded is re-sent
                this.resync = false;
                this.seen?._heartbeat?.().catch?.(() => {});
            }
        } catch (error) {
            this._onFailure(batch, error);
        } finally {
            this.inflight--;
            if (this.queue.size > 0) this._pump();
        }
    }

    _onFailure(batch, error) {
        this.failed++;
        let retry = false;
        for (const entry of batch) {
            const key = `${entry.cx},${entry.cz}`;
            if ((entry.attempts ?? 0) < 1) {
                entry.attempts = (entry.attempts ?? 0) + 1;
                this.queue.set(key, entry);
                retry = true;
            }
        }
        this.resync = true;
        const now = this.now();
        if (now - this.warnAt >= WARN_EVERY_MS) {
            this.warnAt = now;
            console.warn(`[topography] chunk feed unavailable (${error?.message ?? error}); map updates will resync`);
        }
        if (retry) this._pump();
    }

    // ---- serialisation (no network, bounded work per chunk) ----
    _blockName(id) {
        if (this.names.has(id)) return this.names.get(id);
        const entry = this.bot?.registry?.blocksByStateId?.[id];
        const raw = entry?.name;
        const name = raw ? (String(raw).includes(':') ? String(raw) : `minecraft:${raw}`) : `unknown:${id}`;
        this.names.set(id, name);
        if (this.names.size > 50000) this.names.clear();
        return name;
    }

    _biomeName(id) {
        if (this.biomeNames.has(id)) return this.biomeNames.get(id);
        const entry = this.bot?.registry?.biomes?.[id];
        const raw = entry?.name;
        const name = raw ? (String(raw).includes(':') ? String(raw) : `minecraft:${raw}`) : `unknown:${id}`;
        this.biomeNames.set(id, name);
        return name;
    }

    _containerNames(container) {
        if (container?.value !== undefined)
            return [this._blockName(container.value)];
        if (Array.isArray(container?.palette))
            return container.palette.map(id => this._blockName(id));
        return null; // direct: unknown until read
    }

    _encodeContainer(container, entries, namer, what) {
        if (!container)
            return null;
        // Single value
        if (container.value !== undefined) {
            const name = namer(container.value);
            if (what === 'blocks' && AIR.has(name))
                return null;
            return { palette: [name] };
        }
        // Indirect: its own bit width, palette names + packed data
        if (Array.isArray(container.palette) && container.data) {
            const names = container.palette.map(id => namer(id));
            if (names.every(name => AIR.has(name)) && what === 'blocks')
                return null;
            const bits = container.data.bitsPerValue;
            if (!Number.isFinite(bits) || bits <= 0)
                return { palette: names };
            const data = Buffer.from(container.data.data.buffer, container.data.data.byteOffset, container.data.data.byteLength);
            return {
                palette: names,
                enc: 'packed',
                bits,
                data: data.toString('base64'),
            };
        }
        // Direct: read entries, build a local name palette, send u16 indices
        if (container.data && typeof container.get === 'function') {
            const names = [];
            const indexByName = new Map();
            const indices = new Array(entries);
            let allAir = true;
            for (let i = 0; i < entries; i++) {
                const name = namer(container.get(i));
                let index = indexByName.get(name);
                if (index === undefined) {
                    index = names.length;
                    names.push(name);
                    indexByName.set(name, index);
                }
                indices[i] = index;
                if (!AIR.has(name)) allAir = false;
            }
            if (allAir && what === 'blocks') return null;
            const raw = Buffer.alloc(entries * 2);
            for (let i = 0; i < entries; i++) raw.writeUInt16LE(indices[i], i * 2);
            return { palette: names, enc: 'u16', data: raw.toString('base64') };
        }
        return null;
    }

    /** Serialise one loaded column per the service contract (`POST /chunk_raw`); null when not loaded. */
    serialize(cx, cz) {
        const column = this.bot?.world?.getColumn?.(cx, cz);
        if (!column || !Number.isFinite(column.minY) || !Number.isFinite(column.worldHeight))
            return null;
        const firstY = column.minY >> 4;
        const sections = [];
        const sectionCount = Math.min(column.sections?.length ?? 0, 64);
        for (let i = 0; i < sectionCount; i++) {
            const container = column.sections[i]?.data;
            const encoded = this._encodeContainer(container, 4096, id => this._blockName(id), 'blocks');
            if (!encoded) continue;
            sections.push({ y: firstY + i, ...encoded });
        }
        const biomes = [];
        const biomeCount = Math.min(column.biomes?.length ?? 0, 64);
        for (let i = 0; i < biomeCount; i++) {
            const container = column.biomes[i]?.data;
            const encoded = this._encodeContainer(container, 64, id => this._biomeName(id), 'biomes');
            if (!encoded) continue;
            biomes.push({ y: firstY + i, ...encoded });
        }
        const chunk = {
            cx, cz,
            min_y: column.minY,
            height: column.worldHeight,
            sections,
        };
        if (biomes.length > 0) chunk.biomes = biomes;
        return chunk;
    }
}
