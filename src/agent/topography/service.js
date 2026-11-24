import settings from '../settings.js';

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8090';
const DEFAULT_SIZE_CHUNKS = 16;
const DEFAULT_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 1000;
const DEFAULT_MAX_BLOCK_CHARS = 1200;
const PUSH_INTERVAL_MS = 2000;

const cache = new Map();
let lastPushKey = null;
let lastPushAt = 0;

export function getServiceUrl() {
    const configured = globalThis.process?.env?.CARTOGRAPHY_SERVICE_URL
        || settings.cartography_service_url
        || DEFAULT_SERVICE_URL;
    return configured.replace(/\/+$/, '');
}

export function clearPerceptionCache() {
    cache.clear();
}

/** Headers for every service request; adds the shared bearer token when `cartography_token` is set. */
export function serviceHeaders(extra = {}) {
    const headers = { ...extra };
    const token = settings.cartography_token || globalThis.process?.env?.CARTOGRAPHY_TOKEN;
    if (token)
        headers.Authorization = `Bearer ${token}`;
    return headers;
}

export function resetPushState() {
    lastPushKey = null;
    lastPushAt = 0;
}

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

/** Normalise `overworld`, `minecraft:overworld`, `the_nether`, ... to `minecraft:<name>`. */
export function normalizeDimension(value) {
    if (value === undefined || value === null)
        return null;
    let raw = String(value).trim().toLowerCase();
    if (!raw)
        return null;
    if (!raw.includes(':'))
        raw = `minecraft:${raw}`;
    if (raw === 'minecraft:nether')
        raw = 'minecraft:the_nether';
    if (raw === 'minecraft:end')
        raw = 'minecraft:the_end';
    if (raw === 'minecraft:the_overworld' || raw === 'minecraft:world')
        raw = 'minecraft:overworld';
    return raw;
}

/** The bot's current dimension id, or null when unknown. */
export function getDimension(agent) {
    return normalizeDimension(agent?.bot?.game?.dimension);
}

/** Unknown dimension is treated as overworld (older servers / not yet spawned). */
export function isOverworld(agent) {
    const dimension = getDimension(agent);
    return dimension === null || dimension === 'minecraft:overworld';
}

/**
 * Guard for terrain commands: returns a message to return to the LLM instead of
 * calling the service when the bot is outside the overworld, else null.
 */
export function terrainUnavailableMessage(agent) {
    if (isOverworld(agent))
        return null;
    return `Terrain data is only available in the overworld (you are in ${getDimension(agent)}).`;
}

/**
 * Agent name to send as `agent=` on terrain requests so the service can treat chunks this agent has not
 * seen as unexplored. null when disabled (setting topography_seen_only === false) or the name is unknown.
 */
export function terrainAgentName(agent) {
    const profile = agent?.prompter?.profile;
    const seenOnly = profile?.topography_seen_only ?? settings.topography_seen_only ?? true;
    const name = agent?.name;
    return seenOnly !== false && name ? String(name) : null;
}

function isEnabled(opts) {
    if (opts.enabled !== undefined)
        return opts.enabled !== false;
    if ((settings.cartography_enabled ?? false) === false)
        return false;
    return (settings.topography_perception ?? true) !== false;
}

function resolvePosition(agent, opts) {
    const directX = opts.x ?? opts.center?.x;
    const directZ = opts.z ?? opts.center?.z;
    if (Number.isFinite(directX) && Number.isFinite(directZ))
        return { x: Math.floor(directX), z: Math.floor(directZ) };
    const position = agent?.bot?.entity?.position;
    if (Number.isFinite(position?.x) && Number.isFinite(position?.z))
        return { x: Math.floor(position.x), z: Math.floor(position.z) };
    return null;
}

function formatName(name) {
    if (!name)
        return 'unknown';
    return String(name).replace(/^minecraft:/, '');
}

function formatHeight(value) {
    return Number.isFinite(value) ? String(Math.round(value)) : '?';
}

function formatDecimal(value) {
    if (!Number.isFinite(value))
        return '?';
    return String(Math.round(value * 100) / 100);
}

function levelRows(level, index) {
    const size = Number(level?.cells_per_side);
    if (!Number.isInteger(size) || size <= 0)
        return null;
    const heights = Array.isArray(level.heights) ? level.heights : [];
    const water = Array.isArray(level.water) ? level.water : [];
    if (index === 0) {
        const heightRows = [];
        const waterRows = [];
        for (let row = 0; row < size; row++) {
            heightRows.push(heights.slice(row * size, (row + 1) * size));
            waterRows.push(water.slice(row * size, (row + 1) * size));
        }
        return { heightRows, waterRows };
    }
    const heightRows = [heights.slice(0, size)];
    const waterRows = [water.slice(0, size)];
    for (let row = 1; row < size - 1; row++) {
        heightRows.push([heights[row * size], heights[row * size + size - 1]]);
        waterRows.push([water[row * size], water[row * size + size - 1]]);
    }
    heightRows.push(heights.slice((size - 1) * size, size * size));
    waterRows.push(water.slice((size - 1) * size, size * size));
    return { heightRows, waterRows };
}

function formatRows(rows) {
    return rows
        .map(row => row.map(formatHeight).join(' '))
        .join(' / ');
}

function formatWaterRows(rows) {
    return rows
        .map(row => row.map(value => Number(value) ? '1' : '0').join(' '))
        .join(' / ');
}

function formatLevelLabel(level, index) {
    const chunks = Number(level?.cell_chunks) || 1;
    return `${index === 0 ? 'inner' : 'ring'} ${chunks}ch/cell`;
}

function isAirName(name) {
    return AIR_NAMES.has(String(name).replace(/^minecraft:/, ''));
}

function largestRemainderPercents(values, total) {
    const exact = values.map(value => (100 * value) / total);
    const floors = exact.map(Math.floor);
    let remaining = 100 - floors.reduce((a, b) => a + b, 0);
    const order = exact
        .map((value, index) => ({ index, frac: value - Math.floor(value) }))
        .sort((a, b) => b.frac - a.frac);
    for (const { index } of order) {
        if (remaining <= 0)
            break;
        floors[index] += 1;
        remaining -= 1;
    }
    return floors;
}

function formatComposition(composition) {
    if (!composition || typeof composition !== 'object')
        return null;
    const parts = [];
    const natural = Number(composition.natural) || 0;
    const engineered = Number(composition.engineered) || 0;
    const liquid = Number(composition.liquid) || 0;
    // Air is not shown, so percentages are over the shown categories and sum to 100.
    const shown = [natural, engineered, liquid];
    const total = shown.reduce((a, b) => a + b, 0);
    if (total > 0) {
        const [pn, pe, pl] = largestRemainderPercents(shown, total);
        parts.push(`natural ${pn}%, engineered ${pe}%, water ${pl}%`);
    }
    const topBlocks = Array.isArray(composition.top_blocks) ? composition.top_blocks : [];
    const top = topBlocks
        .filter(pair => Array.isArray(pair) && pair[0] && !isAirName(pair[0]) && (!Number.isFinite(pair[1]) || pair[1] > 0))
        .slice(0, 3)
        .map(pair => formatName(pair[0]));
    if (top.length > 0)
        parts.push(`top: ${top.join(', ')}`);
    if (Number.isFinite(composition.artificiality_score))
        parts.push(`artificiality ${formatDecimal(composition.artificiality_score)}`);
    const engineeredBlocks = Array.isArray(composition.engineered_blocks)
        ? composition.engineered_blocks
        : [];
    const built = engineeredBlocks
        .filter(pair => Array.isArray(pair) && pair[0])
        .slice(0, 4)
        .map(pair => `${formatName(pair[0])} ${Number(pair[1]) || 0}`);
    if (built.length > 0)
        parts.push(`built: ${built.join(', ')}`);
    return parts.length > 0 ? parts.join('; ') : null;
}

const MIN_SETTLEMENT_CONFIDENCE = 0.3;
const SETTLEMENTS_TIMEOUT_MS = 400;

/**
 * One line about built-up places from /settlements: the one the bot is inside, else the nearest.
 * Without it the block only says "engineered 0%" for a village that is a speck in a 256x256 window.
 */
export function formatSettlementLine(settlements) {
    if (!Array.isArray(settlements))
        return '';
    const usable = settlements.filter(s => s && s.center && (s.confidence === undefined || s.confidence >= MIN_SETTLEMENT_CONFIDENCE));
    if (usable.length === 0)
        return '';
    const pick = usable.find(s => s.inside) ?? [...usable].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))[0];
    const kind = pick.kind === 'outpost' ? 'outpost' : 'settlement';
    const buildings = Number.isFinite(pick.building_count) ? `${pick.building_count} buildings` : 'buildings';
    const weak = Number.isFinite(pick.confidence) && pick.confidence < 0.5 ? ' (weak signal)' : '';
    const where = Number.isFinite(pick.distance) && pick.direction
        ? `${Math.round(pick.distance)} blocks ${pick.direction}`
        : `(${Math.round(pick.center.x)},${Math.round(pick.center.z)})`;
    if (pick.inside)
        return `${kind}: you are inside one (${buildings}; centre ${where})${weak}`;
    return `${kind}: nearest is ${where} (${buildings})${weak}`;
}

const DIRECTION_SHORT = {
    north: 'N', northeast: 'NE', east: 'E', southeast: 'SE',
    south: 'S', southwest: 'SW', west: 'W', northwest: 'NW'
};
const MAX_LANDFORMS_SHOWN = 4;

function landformHeight(form) {
    const lo = form.y_min;
    const hi = form.y_max;
    switch (form.kind) {
        case 'cliff': case 'canyon':
            return Number.isFinite(lo) && Number.isFinite(hi) ? (lo === hi ? ` y${hi}` : ` y${lo}-${hi}`) : '';
        case 'valley':
            return Number.isFinite(lo) ? ` y${lo}` : '';
        case 'hill': case 'mountain': case 'ridge': case 'plateau': case 'island':
            return Number.isFinite(hi) ? ` y${hi}` : '';
        default:
            return '';
    }
}

/**
 * One protected line of named landforms from the /perception `landforms` field, nearest/most salient first
 * (the service already ranks and caps): `landforms: cliff 40 W y70-110; hill 120 N y96; lake 30 E` (canyon like cliff: `canyon 60 E y40-78`;
 * island: `island 80 W y72`; beach: `beach 30 S`).
 * Plains are only worth the tokens when nothing else is around. Perception only: never stored in memory.
 */
export function formatLandformsLine(landforms) {
    if (!Array.isArray(landforms))
        return '';
    const usable = landforms.filter(f => f && typeof f.kind === 'string' && Number.isFinite(f.distance));
    const notPlain = usable.filter(f => f.kind !== 'plain');
    const shown = (notPlain.length > 0 ? notPlain : usable).slice(0, MAX_LANDFORMS_SHOWN);
    if (shown.length === 0)
        return '';
    const parts = shown.map(f => {
        const where = f.inside || f.direction === 'here'
            ? 'here'
            : `${Math.round(f.distance)} ${DIRECTION_SHORT[f.direction] || f.direction || ''}`.trim();
        return `${f.kind} ${where}${landformHeight(f)}`;
    });
    return `landforms: ${parts.join('; ')}`;
}

const FAR_LABELS = { high_ground: 'high ground', water: 'water', built: 'built' };

/** One compact line for the overview's far features (at most 3 items, at most 140 characters). */
function formatFarLine(far) {
    if (!Array.isArray(far) || far.length === 0)
        return null;
    const parts = far.slice(0, 3).map(item => {
        if (!item)
            return null;
        const direction = DIRECTION_SHORT[item.direction] || item.direction || '';
        const distance = Number.isFinite(item.distance) ? Math.round(item.distance) : '?';
        const head = `${FAR_LABELS[item.kind] || item.kind || 'place'} ${distance} ${direction}`.trim();
        return Number.isFinite(item.y) ? `${head} y=${item.y}` : head;
    }).filter(Boolean);
    if (parts.length === 0)
        return null;
    let text = `far (seen earlier): ${parts.join('; ')}`;
    if (text.length > 140)
        text = `${text.slice(0, 139)}…`;
    return text;
}

/** Character cap for the block: opts.maxChars, else settings.topography_max_chars, else 1200. Read per call. */
function resolveMaxChars(opts = {}) {
    for (const candidate of [opts?.maxChars, settings.topography_max_chars]) {
        const n = Number(candidate);
        if (candidate !== undefined && candidate !== null && Number.isFinite(n) && n > 0)
            return Math.floor(n);
    }
    return DEFAULT_MAX_BLOCK_CHARS;
}

/**
 * The block is a list of entries rendered in insertion order. An entry without `value` is protected.
 * Otherwise `value` ranks how useful it is: when the block is over the cap, the lowest value goes first, as
 * a whole line, and a short note says something was dropped. A section header (`header: id`) disappears with
 * the last of its `section: id` lines. The protected `landforms:` line is added with add(text) and no value.
 */
class BlockBuilder {
    constructor() { this.entries = []; this.nextValue = 1; }
    add(text, { value, section, header } = {}) {
        const entry = { text, value, section, header, dropped: false };
        this.entries.push(entry);
        return entry;
    }
    /** Give entries increasing value in the order they are passed (first passed = dropped first). */
    rank(entries) {
        for (const entry of entries) {
            if (entry)
                entry.value = this.nextValue++;
        }
    }
    render(max) {
        const dropped = [];
        const build = () => {
            const live = this.entries.filter(entry => !entry.dropped && !(entry.header
                && !this.entries.some(other => !other.dropped && other.section === entry.header)));
            const lines = live.map(entry => entry.text);
            if (dropped.length > 0)
                lines.push('(trimmed: lower-priority lines dropped)');
            return lines;
        };
        const droppable = this.entries.filter(entry => entry.value !== undefined).sort((a, b) => a.value - b.value);
        let lines = build();
        while (lines.join('\n').length > max && droppable.length > 0) {
            const next = droppable.shift();
            next.dropped = true;
            dropped.push(next);
            lines = build();
        }
        // Last resort, only if protected lines alone exceed the cap: shed from the end, keeping header + compass.
        while (lines.join('\n').length > max && lines.length > 2) {
            const last = this.entries.filter(entry => !entry.dropped && entry.value === undefined && !entry.header).pop();
            if (!last || last === this.entries[0] || last === this.entries[1])
                break;
            last.dropped = true;
            dropped.push(last);
            lines = build();
        }
        let block = lines.join('\n');
        if (block.length > max)
            block = block.slice(0, max);
        return block;
    }
}

export function formatPerception(data, opts = {}) {
    if (!data || typeof data !== 'object')
        return '';
    if (data.unavailable)
        return ''; // e.g. {"unavailable": "dimension"}: inject nothing
    const center = data.center || {};
    const x = Number.isFinite(center.x) ? Math.floor(center.x) : 0;
    const z = Number.isFinite(center.z) ? Math.floor(center.z) : 0;
    const size = Number.isFinite(data.size_chunks) ? data.size_chunks : DEFAULT_SIZE_CHUNKS;
    const levels = Array.isArray(data.lod) ? data.lod : [];
    const block = new BlockBuilder();
    const cellSizes = levels.map(level => Number(level?.cell_chunks) || 1);
    const lodLabel = cellSizes.length > 0
        ? `${cellSizes.length === 1 ? 'level' : 'levels'} ${cellSizes.join('/')} chunks per cell`
        : 'no LOD data';
    block.add(`TOPOGRAPHY ${size}x${size} chunks centered at (${x},${z}), LOD ${lodLabel}`);
    block.add('compass: north=-Z, south=+Z, east=+X, west=-X; rows run north -> south');

    const heightEntries = [];
    const waterEntries = [];
    const rowEntries = { heights: [], water: [] };
    for (let index = 0; index < levels.length; index++) {
        const rows = levelRows(levels[index], index);
        if (!rows)
            continue;
        const label = formatLevelLabel(levels[index], index);
        if (rows.heightRows.some(row => row.length > 0))
            rowEntries.heights.push({ index, text: `  ${label}: ${formatRows(rows.heightRows)}` });
        if (rows.waterRows.some(row => row.length > 0))
            rowEntries.water.push({ index, text: `  ${label}: ${formatWaterRows(rows.waterRows)}` });
    }
    if (rowEntries.heights.length > 0) {
        block.add('heights (NW->SE, y):', { header: 'heights' });
        for (const row of rowEntries.heights)
            heightEntries.push({ index: row.index, entry: block.add(row.text, { section: 'heights' }) });
    }
    if (rowEntries.water.length > 0) {
        block.add('water (0 land, 1 water):', { header: 'water' });
        for (const row of rowEntries.water)
            waterEntries.push({ index: row.index, entry: block.add(row.text, { section: 'water' }) });
    }

    const water = data.water;
    if (water && typeof water === 'object') {
        const centerLabel = water.at_center ? 'water' : 'land';
        const nearest = water.nearest;
        if (nearest && Number.isFinite(nearest.distance)) {
            block.add(`nearest water: ${nearest.direction || 'unknown'}, ${Math.round(nearest.distance)} blocks; center: ${centerLabel}`);
        } else {
            block.add(`nearest water: none; center: ${centerLabel}`);
        }
    }

    const settlementLine = formatSettlementLine(data.settlements_nearby);
    if (settlementLine)
        block.add(settlementLine);

    const landformsLine = formatLandformsLine(data.landforms);
    if (landformsLine)
        block.add(landformsLine); // protected: no value, never dropped by trimming

    const farLineEnabled = (opts?.farLine ?? settings.topography_far_line ?? true) !== false;
    const farEntry = farLineEnabled ? (() => {
        const text = formatFarLine(data.far);
        return text ? block.add(text) : null;
    })() : null;

    const surface = data.surface || {};
    const relief = Number.isFinite(surface.relief)
        ? surface.relief
        : (Number.isFinite(surface.max_y) && Number.isFinite(surface.min_y) ? surface.max_y - surface.min_y : null);
    const reliefPart = Number.isFinite(relief) ? `relief: ${formatHeight(relief)}; ` : '';
    block.add(`${reliefPart}biome: ${formatName(data.biome)}`);

    const terrain = data.terrain || {};
    let highestEntry = null;
    let byDirectionEntry = null;
    const highest = terrain.highest;
    if (highest && Number.isFinite(highest.y)) {
        const direction = highest.direction || 'here';
        const where = direction === 'here'
            ? 'at center'
            : `${direction}, ~${Math.round(highest.distance)} blocks`;
        highestEntry = block.add(`highest ground: ${where}, y=${formatHeight(highest.y)}`);
    }
    const byDirection = terrain.highest_by_direction;
    if (byDirection && typeof byDirection === 'object') {
        const short = {
            north: 'N', northeast: 'NE', east: 'E', southeast: 'SE',
            south: 'S', southwest: 'SW', west: 'W', northwest: 'NW'
        };
        const order = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
        const parts = order
            .filter(d => byDirection[d] && Number.isFinite(byDirection[d].y))
            .map(d => `${short[d]} ${formatHeight(byDirection[d].y)}`);
        if (parts.length > 0)
            byDirectionEntry = block.add(`highest by direction: ${parts.join(' ')}`);
    }

    const composition = formatComposition(data.composition);
    if (composition)
        block.add(`composition: ${composition}`);

    if (Number(data.missing_chunks) > 0)
        block.add(`missing: ${data.missing_chunks} chunks`);
    if (Number(data.unexplored_chunks) > 0)
        block.add(`unexplored: ${data.unexplored_chunks} chunks (never seen by you)`);

    // Drop order, lowest value first (see BlockBuilder): coarse-ring water, finer-ring water, inner water,
    // coarse-ring heights, highest by direction, nearest-ring heights, highest ground. Everything else is protected.
    const rings = (list) => list.filter(row => row.index > 0).sort((x, y) => y.index - x.index).map(row => row.entry);
    const innerWater = waterEntries.filter(row => row.index === 0).map(row => row.entry);
    const heightRings = rings(heightEntries);
    const nearRingHeights = heightRings.length > 0 ? [heightRings.pop()] : [];
    block.rank([
        farEntry,
        ...rings(waterEntries),
        ...innerWater,
        ...heightRings,
        byDirectionEntry,
        ...nearRingHeights,
        highestEntry,
    ]);

    return block.render(resolveMaxChars(opts));
}

function buildUrl(position, opts, dimension, agentName = null) {
    const search = new URLSearchParams();
    if (agentName)
        search.set('agent', agentName);
    search.set('x', String(position.x));
    search.set('z', String(position.z));
    if (dimension)
        search.set('dimension', dimension);
    const size = opts.size ?? opts.size_chunks ?? settings.topography_render_chunks ?? DEFAULT_SIZE_CHUNKS;
    search.set('size_chunks', String(size));
    const materials = opts.materials ?? settings.topography_perception_materials ?? false;
    if (materials)
        search.set('materials', '1');
    return `${getServiceUrl()}/perception?${search.toString()}`;
}

function buildSettlementsUrl(position, dimension, agentName = null) {
    const search = new URLSearchParams();
    if (agentName)
        search.set('agent', agentName);
    search.set('x', String(position.x));
    search.set('z', String(position.z));
    search.set('radius', '96');
    if (dimension)
        search.set('dimension', dimension);
    return `${getServiceUrl()}/settlements?${search.toString()}`;
}

async function requestPerception(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal, headers: serviceHeaders() });
        let payload = null;
        try {
            payload = await response.json();
        } catch {
            payload = null;
        }
        if (!response.ok) {
            const message = payload && payload.error ? payload.error : `HTTP ${response.status}`;
            throw new Error(message);
        }
        if (!payload || typeof payload !== 'object')
            throw new Error('service returned an invalid response');
        return payload;
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchPerception(agent, opts = {}) {
    if (!isEnabled(opts)) {
        if (opts.debug)
            console.log('[topography] perception disabled for this agent');
        return '';
    }
    const position = resolvePosition(agent, opts);
    if (!position)
        return '';
    const size = opts.size ?? opts.size_chunks ?? settings.topography_render_chunks ?? DEFAULT_SIZE_CHUNKS;
    const dimension = getDimension(agent);
    if (!isOverworld(agent)) {
        if (opts.debug)
            console.log(`[topography] perception skipped: dimension ${dimension}`);
        return '';
    }
    const key = `${position.x},${position.z},${size},${dimension || ''},${terrainAgentName(agent) || ''}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        if (opts.debug)
            console.log(`[topography] cache hit x=${position.x} z=${position.z} size=${size} chars=${cached.value.length}`);
        return cached.value;
    }
    if (cached)
        cache.delete(key);
    const timeoutMs = opts.timeout_ms ?? opts.timeoutMs ?? settings.topography_perception_timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const url = buildUrl(position, opts, dimension, terrainAgentName(agent));
    const started = Date.now();
    try {
        const data = await requestPerception(url, timeoutMs);
        if (!data.unavailable) {
            // Settlements ride along in the same block. Optional: a short timeout, and any failure just leaves the line out.
            const settlements = await requestPerception(
                buildSettlementsUrl(position, dimension, terrainAgentName(agent)), Math.min(timeoutMs, SETTLEMENTS_TIMEOUT_MS)
            ).catch(() => null);
            if (Array.isArray(settlements?.settlements) && settlements.settlements.length > 0)
                data.settlements_nearby = settlements.settlements;
        }
        const formatted = formatPerception(data, {
            farLine: opts.farLine ?? agent?.prompter?.profile?.topography_far_line
        });
        if (formatted)
            cache.set(key, { value: formatted, expiresAt: Date.now() + CACHE_TTL_MS });
        if (opts.debug) {
            console.log(
                `[topography] perception ok x=${position.x} z=${position.z} size=${size} ` +
                `ms=${Date.now() - started} chars=${formatted.length} ` +
                `missing=${data.missing_chunks} version=${data.window_version} url=${url}`
            );
        }
        return formatted;
    } catch (error) {
        const message = error?.message || error;
        if (opts.debug) {
            console.warn(
                `[topography] perception failed x=${position.x} z=${position.z} size=${size} ` +
                `ms=${Date.now() - started} url=${url}: ${message}`
            );
        } else {
            console.warn(`Topography perception unavailable: ${message}`);
        }
        return '';
    }
}

export function pushPosition(agent, opts = {}) {
    if (!isEnabled(opts)) {
        if (opts.debug)
            console.log('[topography] position push disabled for this agent');
        return;
    }
    if (!isOverworld(agent))
        return;
    const position = resolvePosition(agent, opts);
    if (!position)
        return;
    const dimension = getDimension(agent);
    const size = opts.size ?? opts.size_chunks ?? settings.topography_render_chunks ?? DEFAULT_SIZE_CHUNKS;
    const key = `${Math.floor(position.x / 16)},${Math.floor(position.z / 16)},${size}`;
    const now = Date.now();
    if (key === lastPushKey && now - lastPushAt < PUSH_INTERVAL_MS)
        return;
    lastPushKey = key;
    lastPushAt = now;
    const payload = { x: position.x, z: position.z, size_chunks: size };
    if (dimension)
        payload.dimension = dimension;
    const body = JSON.stringify(payload);
    const url = `${getServiceUrl()}/position`;
    try {
        const request = fetch(url, {
            method: 'POST',
            headers: serviceHeaders({ 'Content-Type': 'application/json' }),
            body
        });
        if (opts.debug) {
            request.then(response => {
                console.log(
                    `[topography] position push x=${position.x} z=${position.z} size=${size} ` +
                    `status=${response.status} url=${url}`
                );
            }).catch(error => {
                console.warn(
                    `[topography] position push failed x=${position.x} z=${position.z} size=${size} ` +
                    `url=${url}: ${error?.message || error}`
                );
            });
        } else {
            request.catch(() => {});
        }
    } catch (error) {
        if (opts.debug)
            console.warn(`[topography] position push error: ${error?.message || error}`);
        // Fire-and-forget: a failed prefetch must never affect prompting.
    }
}

/**
 * Push the bot's position if it has changed chunk tile (pushPosition debounces
 * duplicates to one request per tile per ~2 s). Cheap enough to call from the
 * agent update tick so the service prefetches while the bot walks, not only when
 * a prompt is built. Reads the per-profile topography settings from the prompter.
 */
export function pushPositionIfMoved(agent, opts = {}) {
    const profile = agent?.prompter?.profile;
    const master = profile?.cartography_enabled ?? settings.cartography_enabled ?? false;
    const perception = master && (profile?.topography_perception ?? settings.topography_perception ?? true);
    pushPosition(agent, {
        enabled: opts.enabled ?? perception,
        debug: opts.debug ?? profile?.topography_debug ?? settings.topography_debug ?? false,
        ...opts
    });
}
