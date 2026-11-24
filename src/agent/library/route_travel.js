/**
 * Map-based long-range travel for `!goToCoordinates` / `!goToRememberedPlace`.
 *
 * Asks the topography service for a route over everything this bot has seen (`GET /route`), then walks it
 * one waypoint at a time with the ordinary pathfinder (`skills.goToPosition`), replanning at each waypoint
 * so newly seen terrain feeds in. The route walks by itself and hands control back to the model at notable
 * moments, decided by cheap code checks only (no LLM): see HANDBACK below. Returns `null` whenever the
 * caller should just do what it did before (topography off, near target, service unavailable).
 *
 * Landforms are perception only and are never written to memory. A bridge is recorded as an observed place
 * only when the bot actually walks it end to end.
 */
import settings from '../settings.js';
import { getServiceUrl, getDimension, isOverworld, serviceHeaders } from '../topography/service.js';

// ---- tunables ----
export const NEAR_DISTANCE = 96;          // blocks: with a y and a loaded target chunk, plain pathing is used below this
export const FAR_FALLBACK_DISTANCE = 96;  // when chunk-loaded state is unknown, anything farther than this is "far"
export const ROUTE_TIMEOUT_MS = 4000;     // the service is bounded to 1.5 s of search
export const WAYPOINT_REACHED = 3;        // horizontal blocks: closer than this counts as already there
export const LEG_CLOSENESS = 2;           // closeness for intermediate legs
export const MAX_LEGS = 80;
export const MAX_CONSECUTIVE_FAILS = 2;
export const FRONTIER_WAIT_MS = 2500;     // let chunk data catch up before replanning at the edge of the map
export const MAX_FRONTIER_RETRIES = 2;
export const LEG_TIMEOUT_MS = 45000;      // a leg that makes no progress for this long is ended
export const SHORE_LEG_TIMEOUT_MS = 20000; // reaching the water's edge, then replanning into shore mode
export const SHORE_BUDGET = 150;          // blocks of shore walked without progress before trying the other side
export const SHORE_PROGRESS = 8;          // blocks the straight-line distance to the target must drop to count
export const SHORE_TRIP_MAX = 600;        // blocks of shore-following per trip, both sides together
export const MAX_UNSTUCK_RESUMES = 2;     // routed trips resumed after Mindcraft's unstuck mode, per trip
export const UNSTUCK_REPEAT_RADIUS = 10;  // stuck again this close to an earlier stuck spot: hand back
const UNSTUCK_ACTION = 'mode:unstuck';
export const HANDBACK = {
    damageDrop: 2,                        // health points lost since the last check
    lowHealth: 8,
    lowFood: 6,
    playerNear: 16,                       // blocks
    placeRadius: 40,                      // known place / settlement proximity
    recentVisitMs: 30 * 60 * 1000,        // a place visited within this is not announced
    nightLongTrip: 150,                   // blocks still to go before night counts as a reason to stop
    nightStart: 12542,
    nightEnd: 23459,
    rerouteExtra: 48,                     // blocks longer than expected ...
    rerouteFactor: 1.4,                   // ... and this much longer, counts as a substantial reroute
    watchIntervalMs: 1000,
    settlementCheckMs: 5000,              // how often the settlement lookup may run during a trip
};
const BRIDGE_ENDPOINT_RADIUS = 4;
const SILENT_PLACE = /^bridge near /i;

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Interruption on develop is the `bot.interrupt_code` flag (ActionManager.stop sets it). */
const interrupted = bot => Boolean(bot.interrupt_code);

function cfg(agent, key, fallback) {
    return agent?.prompter?.profile?.[key] ?? settings[key] ?? fallback;
}

export function routingEnabled(agent) {
    if (cfg(agent, 'cartography_enabled', false) === false) return false;
    return cfg(agent, 'topography_routing', true) !== false;
}

const hdist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const round = n => Math.round(n);

/** True when the target is outside loaded chunks (or no better knowledge: farther than FAR_FALLBACK_DISTANCE). */
export function isFarTarget(bot, x, z) {
    const pos = bot?.entity?.position;
    if (!pos) return false;
    const loaded = bot.world?.getColumn?.(Math.floor(x) >> 4, Math.floor(z) >> 4);
    if (loaded !== undefined) return !loaded;
    return hdist(pos.x, pos.z, x, z) > FAR_FALLBACK_DISTANCE;
}

/** Should this go through the router? (Gate only; the service may still decline.) */
export function shouldRoute(agent, target) {
    const debug = cfg(agent, 'topography_debug', false);
    const no = (why) => {
        if (debug) console.log(`[route] shouldRoute=false (${why}) target=${target?.x},${target?.y},${target?.z}`);
        return false;
    };
    if (!routingEnabled(agent)) return no('routing disabled');
    if (!isOverworld(agent)) return no('not overworld');
    const pos = agent?.bot?.entity?.position;
    if (!pos || !Number.isFinite(target?.x) || !Number.isFinite(target?.z)) return no('no position or coords');
    if (hdist(pos.x, pos.z, target.x, target.z) < WAYPOINT_REACHED) return no('already there');
    if (target.y === null || target.y === undefined || !Number.isFinite(target.y)) return true;
    const loaded = agent.bot?.world?.getColumn?.(Math.floor(target.x) >> 4, Math.floor(target.z) >> 4);
    const dist = hdist(pos.x, pos.z, target.x, target.z);
    // a loaded target is plain-pathed only when it is near; a loaded but distant one still routes
    const far = isFarTarget(agent.bot, target.x, target.z) || (Boolean(loaded) && dist >= NEAR_DISTANCE);
    if (debug) console.log(`[route] shouldRoute=${far} target chunk (${Math.floor(target.x) >> 4},${Math.floor(target.z) >> 4}) loaded=${loaded === undefined ? 'undefined' : Boolean(loaded)} dist=${round(dist)}`);
    return far;
}

// ---- service access ----
export async function fetchRoute(agent, from, to, { fetchImpl = globalThis.fetch, timeoutMs = ROUTE_TIMEOUT_MS, shore = null, shoreFrom = null } = {}) {
    const q = new URLSearchParams({ x: String(Math.floor(from.x)), z: String(Math.floor(from.z)),
        x2: String(Math.floor(to.x)), z2: String(Math.floor(to.z)), agent: String(agent.name) });
    const dimension = getDimension(agent);
    if (dimension) q.set('dimension', dimension);
    if (shore) q.set('shore', String(shore));
    if (Number.isFinite(shoreFrom)) q.set('shore_from', String(shoreFrom));
    const response = await fetchImpl(`${getServiceUrl()}/route?${q}`, { signal: AbortSignal.timeout(timeoutMs), headers: serviceHeaders() });
    if (!response.ok) throw new Error(`route HTTP ${response.status}`);
    const data = await response.json();
    if (data.unavailable) throw new Error(`route unavailable: ${data.unavailable}`);
    if (!data.status || !Array.isArray(data.waypoints)) throw new Error('malformed route');
    return data;
}

async function fetchSettlementInside(agent, pos, { fetchImpl = globalThis.fetch } = {}) {
    const q = new URLSearchParams({ x: String(Math.floor(pos.x)), z: String(Math.floor(pos.z)), radius: '64', agent: String(agent.name) });
    const response = await fetchImpl(`${getServiceUrl()}/settlements?${q}`, { signal: AbortSignal.timeout(800), headers: serviceHeaders() });
    if (!response.ok) return null;
    const data = await response.json();
    return (data?.settlements ?? []).find(s => s?.inside) ?? null;
}

async function defaultGoTo(bot, x, y, z, closeness) {
    const skills = await import('./skills.js');
    return await skills.goToPosition(bot, x, y, z, closeness);
}

function defaultDeps() {
    return {
        fetchRoute,
        goTo: defaultGoTo,
        now: () => Date.now(),
        sleep: defaultSleep,
        nearbyPlaces: (agent, pos, radius) => agent.memory?.placesNear?.(pos.x, pos.z, radius) ?? [],
        settlementInside: fetchSettlementInside,
        log: (bot, message) => { if (bot) bot.output = `${bot.output ?? ''}${message}\n`; },
    };
}

// ---- trip bookkeeping ----
class Trip {
    constructor(agent, target, closeness, label, deps, resume = null) {
        this.agent = agent;
        this.resume = resume;       // {count, spots, overrides}: unstuck resumes so far on this trip
        this.bot = agent.bot;
        this.target = target;
        this.closeness = closeness;
        this.label = label;
        this.deps = deps;
        this.start = { x: this.bot.entity.position.x, z: this.bot.entity.position.z };
        this.startedAt = deps.now();
        this.legs = 0;
        this.walked = 0;
        this.phrases = [];          // ordered, unique: what the route did
        this.detours = new Set();
        this.bridges = new Map();   // id -> {a,b,length, entered: 'a'|'b'|null, ok: bool}
        this.recorded = new Set();
        this.announced = new Set(); // places/settlements/players already handed back for
        this.lastHealth = this.bot.health;
        this.lastPlanDistance = null;
        this.lastPlanComplete = false;
        this.lastLegLength = 0;
        this.lastSettlementCheck = -Infinity;
        this.chatted = null;        // speaker who spoke during the trip
        this.alert = null;          // set by the watcher while a leg runs
        // shore-following: the side chosen for this trip and the current episode
        this.shoreSide = null;
        this.shoreTurned = false;
        this.shoreTotal = 0;
        this.shore = null;          // {entryRemaining, walked, best, walkedAtBest}
    }
    phrase(text) { if (!this.phrases.includes(text)) this.phrases.push(text); }
    report() {
        const parts = [...this.phrases];
        const pos = this.bot.entity.position;
        const walked = round(this.walked);
        const head = parts.length ? parts.join(', ') : 'walked a straight route';
        return `${head} (${walked} blocks over ${this.legs} leg${this.legs === 1 ? '' : 's'}; now at (${round(pos.x)}, ${round(pos.z)}))`;
    }
}

function noteWaypoint(trip, wp) {
    switch (wp.kind) {
        case 'path': trip.phrase('followed a path'); break;
        case 'crest': trip.phrase(`crossed a high point (y=${wp.y})`); break;
        case 'shore':
            if (wp.swim) trip.phrase(`crossed about ${wp.swim} blocks of water`);
            break;
        case 'shore_follow':
            break;   // the shore-episode phrase covers it
        default:
    }
}

function noteDetours(trip, plan) {
    for (const d of plan.detours ?? []) {
        if (trip.detours.has(d.around)) continue;
        trip.detours.add(d.around);
        trip.phrase(d.around === 'water' ? 'went around the water' : 'went around a cliff');
    }
}

function trackBridges(trip, plan) {
    for (const b of plan.bridges ?? []) {
        if (!trip.bridges.has(b.id)) trip.bridges.set(b.id, { ...b, entered: null, ok: true });
    }
}

/** After a leg ends at (x, z): note bridge entry/exit; return the bridge crossed end to end, if any. */
function bridgeProgress(trip, x, z, legOk) {
    let crossed = null;
    for (const b of trip.bridges.values()) {
        const nearA = hdist(x, z, b.a.x, b.a.z) <= BRIDGE_ENDPOINT_RADIUS;
        const nearB = hdist(x, z, b.b.x, b.b.z) <= BRIDGE_ENDPOINT_RADIUS;
        if (!legOk && b.entered) { b.entered = null; continue; }   // a failed leg on the deck breaks the crossing
        if (b.entered && nearA && b.entered === 'b') crossed = b;
        else if (b.entered && nearB && b.entered === 'a') crossed = b;
        else if (nearA && !b.entered) b.entered = 'a';
        else if (nearB && !b.entered) b.entered = 'b';
        if (crossed === b) b.entered = null;
    }
    return crossed;
}

function bridgeName(b) {
    return `bridge near (${round((b.a.x + b.b.x) / 2)},${round((b.a.z + b.b.z) / 2)})`;
}

/** The bot walked this bridge end to end: say so in the trip report and keep it as an observed place. */
function recordBridge(trip, b) {
    const memory = trip.agent.memory;
    trip.phrase(`crossed the bridge (${b.length} blocks)`);
    const name = bridgeName(b);
    if (trip.recorded.has(name)) return;
    trip.recorded.add(name);
    if (!memory?.enabled || memory.lookup?.(name)) return;
    memory.rememberHere?.(name, (b.a.x + b.b.x) / 2, b.deck_y ?? b.a.y, (b.a.z + b.b.z) / 2);
}

// ---- hand-back checks (cheap, synchronous unless noted) ----
function vitalsReason(trip) {
    const bot = trip.bot;
    const health = bot.health;
    if (Number.isFinite(health)) {
        if (Number.isFinite(trip.lastHealth) && trip.lastHealth - health >= HANDBACK.damageDrop) {
            trip.lastHealth = health;
            return `you took damage (health ${round(health)}/20)`;
        }
        trip.lastHealth = Math.max(health, trip.lastHealth ?? health);
        if (health <= HANDBACK.lowHealth && !trip.announced.has('low_health')) {
            trip.announced.add('low_health'); // once per trip, so a bot that cannot heal is not stuck in a loop
            return `your health is low (${round(health)}/20)`;
        }
    }
    if (Number.isFinite(bot.food) && bot.food <= HANDBACK.lowFood && !trip.announced.has('low_food')) {
        trip.announced.add('low_food');
        return `you are hungry (food ${round(bot.food)}/20)`;
    }
    return null;
}

function playerReason(trip) {
    if (trip.chatted) { const who = trip.chatted; trip.chatted = null; return `${who} spoke to you`; }
    const bot = trip.bot;
    const pos = bot.entity.position;
    for (const [name, p] of Object.entries(bot.players ?? {})) {
        if (name === bot.username || name === trip.agent.name) continue;
        const e = p?.entity;
        if (!e?.position || trip.announced.has(`player:${name}`)) continue;
        if (hdist(pos.x, pos.z, e.position.x, e.position.z) <= HANDBACK.playerNear) {
            trip.announced.add(`player:${name}`);
            return `${name} is nearby`;
        }
    }
    return null;
}

function nightReason(trip, remaining) {
    if (trip.announced.has('night')) return null;
    const t = trip.bot.time?.timeOfDay;
    const night = Number.isFinite(t) ? (t >= HANDBACK.nightStart && t < HANDBACK.nightEnd) : trip.bot.time?.isDay === false;
    if (night && remaining >= HANDBACK.nightLongTrip) {
        trip.announced.add('night');
        return `night has fallen with about ${round(remaining)} blocks still to go`;
    }
    return null;
}

async function placeReason(trip, pos) {
    const deps = trip.deps;
    let places;
    try { places = deps.nearbyPlaces(trip.agent, pos, HANDBACK.placeRadius) ?? []; } catch { places = []; }
    const now = deps.now();
    const recent = p => p.lastVisitTs && now - p.lastVisitTs < HANDBACK.recentVisitMs;
    for (const p of places) {
        const key = `place:${p.name}`;
        if (trip.announced.has(key) || SILENT_PLACE.test(p.name)) continue;
        trip.announced.add(key);
        if (recent(p)) continue;
        return `you are entering ${p.name}, ${p.visited ? 'a known place you have not visited recently' : 'a place you have only heard of'}`;
    }
    let inside = null;
    if (now - trip.lastSettlementCheck >= HANDBACK.settlementCheckMs) {
        trip.lastSettlementCheck = now;
        try { inside = await deps.settlementInside(trip.agent, pos); } catch { inside = null; }
    }
    if (inside) {
        const key = `settlement:${inside.id ?? `${inside.center?.x},${inside.center?.z}`}`;
        if (!trip.announced.has(key)) {
            trip.announced.add(key);
            const known = places.some(p => recent(p) && inside.center && hdist(p.x, p.z, inside.center.x, inside.center.z) <= 48);
            if (!known) return `you are entering a ${inside.kind ?? 'settlement'}${inside.building_count ? ` of about ${inside.building_count} buildings` : ''} you have not visited recently`;
        }
    }
    return null;
}

function resumeHint(trip) {
    const t = trip.target;
    if (trip.label) return `call !goToRememberedPlace("${trip.label}")`;
    const y = Number.isFinite(t.y) ? round(t.y) : (t.knownY ?? null);
    return y === null ? `call !goToCoordinates with x=${round(t.x)}, z=${round(t.z)} (and the ground y)`
        : `call !goToCoordinates(${round(t.x)}, ${y}, ${round(t.z)}, ${trip.closeness})`;
}

const FINISH_MAX_CHARS = 480;

/** Clip a model-facing result to 480 chars, shortening only the trip report in the middle. */
function clipResult(trip, text) {
    if (text.length <= FINISH_MAX_CHARS) return text;
    const report = trip.report();
    const marker = `Trip so far: ${report}. `;
    const at = text.indexOf(marker);
    if (at >= 0) {
        const head = `${text.slice(0, at)}Trip so far: `;
        const tail = text.slice(at + marker.length);
        const budget = FINISH_MAX_CHARS - head.length - tail.length - 1;
        if (budget > 8) {
            const short = report.length > budget ? `${report.slice(0, budget - 1)}…` : report;
            return `${head}${short}. ${tail}`.slice(0, FINISH_MAX_CHARS);
        }
    }
    return `${text.slice(0, FINISH_MAX_CHARS - 1)}…`;
}

/**
 * develop's ActionManager ignores an action's return value and reports
 * `bot.output` (clipped to 500 chars by getBotOutputSummary), so the final text
 * is written there and also returned for tests and direct callers.
 */
function logEnd(trip, status, code) {
    if (cfg(trip.agent, 'topography_debug', false)) {
        console.log(`[route] end status=${status} code=${code ?? '-'} legs=${trip.legs} walked=${round(trip.walked)}`);
    }
}

function finish(trip, status, text, code) {
    logEnd(trip, status, code);
    const clipped = clipResult(trip, String(text ?? ''));
    if (trip.bot) trip.bot.output = `${clipped}\n`;
    return { status, text: clipped, code };
}

function handBack(trip, status, code, why, extra = '') {
    const pos = trip.bot.entity.position;
    const left = round(hdist(pos.x, pos.z, trip.target.x, trip.target.z));
    const text = `Stopped on the way to (${round(trip.target.x)}, ${round(trip.target.z)}): ${why}. `
        + `Trip so far: ${trip.report()}. About ${left} blocks to go${extra ? `. ${extra}` : ''}. To resume, ${resumeHint(trip)}.`;
    // An interrupted action reports nothing on develop: no output, no experience log.
    if (status === 'cancelled') {
        logEnd(trip, status, code);
        resumeAfterUnstuck(trip.agent, trip.target,
            { closeness: trip.closeness, label: trip.label, resume: trip.resume });
        return { status, text, code };
    }
    logTrip(trip, `trip towards (${round(trip.target.x)},${round(trip.target.z)}) stopped: ${why}; ${trip.report()}`);
    return finish(trip, status, text, code);
}

function logTrip(trip, text) {
    try { trip.agent.memory?.logExperience?.(text); } catch { /* experience logging never breaks travel */ }
}

// ---- main ----
/**
 * Travel toward `target` ({x, y|null, z}) by routed legs.
 * @returns {Promise<object|null>} a tool result, or null to let the caller use plain pathfinding.
 */
export async function routedTravel(agent, target, { closeness = 2, label = null, deps: overrides = {}, resume = null } = {}) {
    const deps = { ...defaultDeps(), ...overrides };
    if (!shouldRoute(agent, target)) return null;
    const bot = agent.bot;
    const trip = new Trip(agent, target, closeness, label, deps,
        { count: resume?.count ?? 0, spots: resume?.spots ?? [], overrides });
    if (resume?.count) trip.phrase(`resumed after getting stuck${resume.count > 1 ? ` (${resume.count} times)` : ''}`);
    let plan = null;
    let finished = false;
    let fails = 0;
    let frontierRetries = 0;
    let frontierRepeats = 0;
    let lastFrontier = null;

    const onChat = username => { if (username && username !== bot.username && username !== agent.name) trip.chatted = username; };
    bot.on?.('chat', onChat);
    bot.on?.('whisper', onChat);
    const detachChat = () => { bot.removeListener?.('chat', onChat); bot.removeListener?.('whisper', onChat); };

    try {
        for (let leg = 0; leg < MAX_LEGS; leg++) {
            if (interrupted(bot)) return handBack(trip, 'cancelled', 'interrupted', 'you were interrupted');
            const pos = bot.entity.position;
            const rem = hdist(pos.x, pos.z, target.x, target.z);
            if (cfg(agent, 'topography_debug', false)) console.log(`[route] loop ${leg} at (${Math.round(pos.x)},${Math.round(pos.z)})`);

            const shoreOpts = { shore: trip.shoreSide ?? 'auto' };
            if (trip.shore) shoreOpts.shoreFrom = trip.shore.entryRemaining;
            try {
                plan = await deps.fetchRoute(agent, pos, target, shoreOpts);
            } catch (error) {
                if (trip.legs === 0) return null; // nothing walked yet: behave exactly as before
                deps.log(bot, `Route service unavailable (${error?.message ?? error}); continuing with plain pathfinding.`);
                return null;
            }
            if (interrupted(bot)) return handBack(trip, 'cancelled', 'interrupted', 'you were interrupted');
            if (cfg(agent, 'topography_debug', false)) {
                const shore = plan.shore ? `${plan.shore.side}/${plan.shore.end}` : '-';
                const first = plan.waypoints[0], last = plan.waypoints[plan.waypoints.length - 1];
                const where = wp => wp ? `${Math.round(wp.x)},${wp.y},${Math.round(wp.z)}/${wp.kind}` : '-';
                console.log(`[route] ${plan.status}${plan.reason ? `/${plan.reason}` : ''} blocked_by=${plan.blocked_by ?? '-'} shore=${shore} wps=${plan.waypoints.length} rem=${plan.remaining ?? '-'} first=${where(first)} last=${where(last)}`);
            }
            noteDetours(trip, plan);
            trackBridges(trip, plan);
            if (leg === 0) bridgeProgress(trip, pos.x, pos.z, true); // standing at a bridge end counts as entering it
            if (target.y == null && plan.target?.known && Number.isFinite(plan.target.y)) target.knownY = plan.target.y;

            // shore episode bookkeeping: a plan with `shore` means the service picked a shoreline
            if (plan.shore) {
                if (!trip.shore) {
                    trip.shore = { entryRemaining: rem, walked: 0, best: rem, walkedAtBest: 0 };
                    if (trip.shoreSide === null) trip.shoreSide = plan.shore.side;
                    trip.phrase('followed the shoreline to find a way around the water');
                }
            } else {
                trip.shore = null;
            }

            // substantial reroute: the new plan is much longer than what was left of the old one
            // (never while following a shore: the detour is the point)
            if (!plan.shore && trip.lastPlanComplete && trip.lastPlanDistance !== null && Number.isFinite(plan.distance)) {
                const expected = Math.max(0, trip.lastPlanDistance - trip.lastLegLength);
                if (plan.distance > expected + HANDBACK.rerouteExtra && plan.distance > expected * HANDBACK.rerouteFactor) {
                    trip.lastPlanDistance = plan.distance;
                    return handBack(trip, 'partial', 'rerouted', `newly seen terrain forced a substantially longer route (now about ${plan.distance} blocks, expected about ${round(expected)})`);
                }
            }
            trip.lastPlanDistance = plan.shore ? null : (plan.distance ?? null);
            trip.lastPlanComplete = plan.status === 'complete';

            if (plan.status === 'blocked') {
                return handBack(trip, 'blocked', 'route_blocked', plan.reason === 'start_unexplored'
                    ? 'the map has no data for where you stand yet'
                    : 'no way forward is known from here');
            }
            const waypoints = plan.waypoints.filter(w => hdist(pos.x, pos.z, w.x, w.z) >= WAYPOINT_REACHED || w.kind === 'target');
            const wp = waypoints[0];
            const lastWp = waypoints[waypoints.length - 1];
            const remaining = plan.status === 'complete' ? (plan.distance ?? 0) : (plan.distance ?? 0) + (plan.remaining ?? 0);

            const currentRem = () => {
                const p = bot.entity.position;
                return hdist(p.x, p.z, target.x, target.z);
            };
            // Give up on this side: flip once per trip, otherwise hand back honestly.
            const endShoreSide = () => {
                if (!trip.shoreTurned && trip.shoreTotal < SHORE_TRIP_MAX) {
                    trip.shoreTurned = true;
                    trip.shoreSide = trip.shoreSide === 'left' ? 'right' : 'left';
                    trip.shore = trip.shore
                        ? { entryRemaining: trip.shore.entryRemaining, walked: 0, best: currentRem(), walkedAtBest: 0 }
                        : null;
                    trip.phrase('turned back to try the other way along the shore');
                    frontierRetries = 0;
                    return null;
                }
                return handBack(trip, 'blocked', 'water_blocked',
                    `water blocks the way; followed the shore both ways for ${round(trip.shoreTotal)} blocks without finding a way across`);
            };

            if (!wp) {
                if (plan.status === 'complete') break; // already at the target cell: finish below
                if (plan.shore && plan.shore.end === 'frontier' && frontierRetries++ < MAX_FRONTIER_RETRIES) {
                    await deps.sleep(FRONTIER_WAIT_MS);
                    continue;
                }
                if (plan.shore) {
                    const outcome = endShoreSide();
                    if (!outcome) continue;
                    return outcome;
                }
                // partial and nowhere to go: at the frontier
                if (frontierRetries++ < MAX_FRONTIER_RETRIES) { await deps.sleep(FRONTIER_WAIT_MS); continue; }
                return handBack(trip, 'partial', 'frontier', 'you are at the edge of the explored map',
                    `The target lies ${plan.reason === 'blocked' ? 'beyond ground the map says is blocked' : 'in unexplored country'}; look around or explore toward it`);
            }

            // vitals are checked before and after every leg; the watcher below also stops a leg early
            const isFinal = wp.kind === 'target';
            const legTargetY = isFinal && Number.isFinite(target.y) ? target.y : wp.y + 1;
            const legCloseness = isFinal ? closeness : LEG_CLOSENESS;
            const from = { x: pos.x, z: pos.z };
            trip.alert = null;
            const stopWatch = startWatcher(trip);
            const debug = cfg(agent, 'topography_debug', false);
            if (debug) console.log(`[route] leg ${wp.kind} to (${Math.round(wp.x)},${wp.z}) from (${Math.round(pos.x)},${Math.round(pos.z)})`);
            let ok;
            let legTimer = null;
            let timedOut = false;
            try {
                ok = await Promise.race([
                    deps.goTo(bot, wp.x, legTargetY, wp.z, legCloseness),
                    new Promise(resolve => {
                        legTimer = setTimeout(() => {
                            timedOut = true;
                            try { bot.pathfinder?.stop?.(); } catch { /* ignore */ }
                            if (debug) console.log(`[route] leg timeout ${wp.kind} at (${Math.round(wp.x)},${wp.z})`);
                            resolve(false);
                        }, deps.legTimeoutMs ?? (wp.kind === 'shore' ? SHORE_LEG_TIMEOUT_MS : LEG_TIMEOUT_MS));
                    }),
                ]);
            } finally {
                if (legTimer) clearTimeout(legTimer);
                stopWatch();
            }
            trip.legs++; // counted before the ownership check so a cut-short trip is still reported
            const after = bot.entity.position;
            const moved = hdist(from.x, from.z, after.x, after.z);
            if (debug) console.log(`[route] leg end ok=${ok} timedOut=${timedOut} moved=${moved.toFixed(1)} at (${Math.round(after.x)},${Math.round(after.z)})`);
            if (timedOut) {
                if (wp.kind === 'shore') {
                    ok = true;   // we are at the water's edge; the next plan can trace the shore
                } else if (wp.kind === 'shore_follow' && trip.shore) {
                    trip.shore.walked += SHORE_BUDGET;   // this shore cannot be walked here: try the other side
                }
            }
            trip.walked += moved;
            trip.lastLegLength = moved;
            if (interrupted(bot)) return handBack(trip, 'cancelled', 'interrupted', 'you were interrupted');
            if (!ok && !trip.alert) {
                if (moved < 2) fails++; else fails = 0;
                if (fails >= MAX_CONSECUTIVE_FAILS) {
                    return handBack(trip, 'blocked', 'route_blocked', `the pathfinder could not get from here to the next waypoint (${round(wp.x)}, ${round(wp.z)})`);
                }
            } else fails = 0;
            if (ok) noteWaypoint(trip, wp);

            const crossed = bridgeProgress(trip, after.x, after.z, !!ok);
            if (crossed) recordBridge(trip, crossed);

            // shore mode: count the leg, notice real progress, and stop this side when it is spent
            if (plan.shore && trip.shore) {
                trip.shore.walked += moved;
                trip.shoreTotal += moved;
                const nowRem = hdist(after.x, after.z, target.x, target.z);
                if (nowRem <= trip.shore.best - SHORE_PROGRESS) {
                    trip.shore.best = nowRem;
                    trip.shore.walkedAtBest = trip.shore.walked;
                }
                const spent = trip.shore.walked - trip.shore.walkedAtBest;
                const atEnd = wp === lastWp && (plan.shore.end === 'dead_end' || plan.shore.end === 'loop');
                if (spent >= SHORE_BUDGET || trip.shoreTotal >= SHORE_TRIP_MAX || atEnd) {
                    const outcome = endShoreSide();
                    if (!outcome) continue;
                    return outcome;
                }
            }

            if (isFinal && ok) {
                finished = true;
                const report = trip.report();
                logTrip(trip, `walked to (${round(target.x)},${round(target.z)}): ${report}`);
                return finish(trip, 'ok', `You have reached (${round(target.x)}, ${Number.isFinite(target.y) ? round(target.y) : round(wp.y + 1)}, ${round(target.z)}). Trip: ${report}.`);
            }
            if (wp.kind === 'frontier' && ok) {
                // at the edge of the explored map: give new chunks a moment to reach the service, then replan
                const repeated = lastFrontier && hdist(wp.x, wp.z, lastFrontier.x, lastFrontier.z) < 8;
                frontierRepeats = repeated ? frontierRepeats + 1 : 0;
                lastFrontier = { x: wp.x, z: wp.z };
                if (frontierRepeats >= MAX_FRONTIER_RETRIES) {
                    return handBack(trip, 'partial', 'frontier', 'you reached the edge of the explored map',
                        'The target lies in country you have not seen; look around or explore toward it');
                }
                await deps.sleep(FRONTIER_WAIT_MS);
            }

            // hand-back moments, most urgent first
            if (debug) console.log('[route] hand-back checks');
            const reason = trip.alert
                ?? vitalsReason(trip)
                ?? playerReason(trip)
                ?? (await placeReason(trip, after))
                ?? nightReason(trip, remaining);
            if (debug) console.log(`[route] checks done reason=${reason ?? '-'}`);
            if (reason) return handBack(trip, 'partial', 'handback', reason);
        }
        // fell out of the loop: either the cell is reached (break) or the leg cap
        const pos = bot.entity.position;
        if (hdist(pos.x, pos.z, target.x, target.z) <= Math.max(closeness, WAYPOINT_REACHED) + 4 || plan?.status === 'complete') {
            const y = Number.isFinite(target.y) ? target.y : (plan?.target?.y ?? null);
            if (interrupted(bot)) return handBack(trip, 'cancelled', 'interrupted', 'you were interrupted');
            const ok = y === null ? true : await deps.goTo(bot, target.x, y, target.z, closeness);
            if (ok) {
                finished = true;
                logTrip(trip, `walked to (${round(target.x)},${round(target.z)}): ${trip.report()}`);
                return finish(trip, 'ok', `You have reached (${round(target.x)}, ${y === null ? '?' : round(y)}, ${round(target.z)}). Trip: ${trip.report()}.`);
            }
        }
        return handBack(trip, 'partial', 'leg_limit', `the trip has taken ${MAX_LEGS} legs without arriving`);
    } catch (error) {
        if (!finished && trip.legs > 0) logTrip(trip, `trip towards (${round(target.x)},${round(target.z)}) was cut short: ${trip.report()}`);
        throw error;
    } finally {
        detachChat();
    }
}

/** While a leg runs, notice damage/low vitals quickly and stop the pathfinder so control comes back promptly. */
function startWatcher(trip) {
    const bot = trip.bot;
    const timer = setInterval(() => {
        if (trip.alert) return;
        const reason = vitalsReason(trip);
        if (!reason) return;
        trip.alert = reason;
        try { bot.pathfinder?.stop?.(); } catch { /* ignore */ }
    }, HANDBACK.watchIntervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}

/** Resolve the model-facing text of a routed result (or null when the caller should go on as before). */
export async function routeOrNull(agent, target, opts = {}) {
    try {
        return await routedTravel(agent, target, opts);
    } catch (error) {
        if (error?.code === 'timeout' || error?.code === 'interrupted' || agent?.bot?.interrupt_code || error?.name === 'AbortError') {
            if (agent?.bot?.interrupt_code || error?.code === 'interrupted') {
                resumeAfterUnstuck(agent, target, { closeness: opts.closeness ?? 2, label: opts.label ?? null,
                    resume: { count: opts.resume?.count ?? 0, spots: opts.resume?.spots ?? [], overrides: opts.deps ?? {} } });
            }
            throw error;
        }
        console.warn('[route] failed, using plain pathfinding:', error?.message || error);
        return null;
    }
}

// ---- resuming after Mindcraft's unstuck mode ----
/**
 * Mindcraft's `unstuck` mode (modes.js) cancels the running action, and `!goToCoordinates` is not
 * resumable, so stock Mindcraft asks the model to restart the trip (and it sometimes stops instead).
 * With routing on, and only when the action was stopped by `mode:unstuck`, this registers a one-shot
 * Mindcraft resume: once unstuck is done (and the agent idle) the trip is re-planned from the new
 * position, and its result is sent to the model as a system message. At most MAX_UNSTUCK_RESUMES per
 * trip; stuck again within UNSTUCK_REPEAT_RADIUS of an earlier stuck spot hands back as before.
 * Any other interruption (`!stop`, combat, a player, death) is untouched.
 * @returns {boolean} true when a resume was registered (the stock re-prompt is then skipped).
 */
export function resumeAfterUnstuck(agent, target, { closeness = 2, label = null, resume = null } = {}) {
    const actions = agent?.actions;
    if (!actions || actions.interruptedBy !== UNSTUCK_ACTION) return false;
    if (!routingEnabled(agent)) return false;
    const pos = agent.bot?.entity?.position;
    if (!pos || !Number.isFinite(target?.x) || !Number.isFinite(target?.z)) return false;
    const ctx = resume ?? { count: 0, spots: [], overrides: {} };
    const why = ctx.count >= MAX_UNSTUCK_RESUMES ? 'resume cap'
        : ctx.spots.some(s => hdist(s.x, s.z, pos.x, pos.z) < UNSTUCK_REPEAT_RADIUS) ? 'stuck again at the same spot' : null;
    if (why) {
        console.log(`[route] unstuck: hand back (${why})`);
        return false;
    }
    const next = { count: ctx.count + 1, spots: [...ctx.spots, { x: pos.x, z: pos.z }], overrides: ctx.overrides ?? {} };
    const actionLabel = actions.currentActionLabel || 'action:goToCoordinates';
    const seq = actions.actionCount ?? 0;   // includes the unstuck action now starting
    const tell = (text) => setTimeout(() => agent.handleMessage?.('system', text), 0);
    console.log(`[route] unstuck: resume ${next.count}/${MAX_UNSTUCK_RESUMES} registered at (${round(pos.x)},${round(pos.z)})`);
    actions.resume_name = actionLabel;
    actions.resume_func = async () => {
        actions.cancelResume?.();   // one shot: a later idle never re-runs it
        if ((actions.actionCount ?? 0) !== seq + 1) {
            // something else ran in between: do not walk off; tell the model what stock Mindcraft would have
            tell(`(AUTO MESSAGE)Your previous action '${actionLabel}' was interrupted by unstuck.\nRespond accordingly.`);
            return;
        }
        console.log(`[route] unstuck: resuming the trip to (${round(target.x)},${round(target.z)})`);
        const result = await routeOrNull(agent, target, { closeness, label, resume: next, deps: next.overrides });
        if (result?.status === 'cancelled') return;   // interrupted again: resumed again, or Mindcraft re-prompts
        let text = result?.text;
        if (!result) {
            // no longer a routed trip (e.g. now near the target): the plain pathfinder, as the command does
            const goTo = next.overrides.goTo ?? defaultGoTo;
            if (Number.isFinite(target.y)) await goTo(agent.bot, target.x, target.y, target.z, closeness);
            if (interrupted(agent.bot)) return;
            text = String(agent.bot.output ?? '').trim() || `Walked toward (${round(target.x)}, ${round(target.z)}).`;
        }
        tell(`(AUTO MESSAGE)Your action '${actionLabel}' was stopped by unstuck mode and resumed automatically. ${text}`);
    };
    return true;
}
