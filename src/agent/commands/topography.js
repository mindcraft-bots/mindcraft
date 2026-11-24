import settings from '../settings.js';
import { planBridge } from '../library/bridge_plan.js';
import { getServiceUrl, getDimension, terrainAgentName, serviceHeaders } from '../topography/service.js';

const REQUEST_TIMEOUT_MS = 5000;
const MAX_RUNS = 80;
const MAX_TRANSITIONS = 40;
const MAX_SHORELINE_POINTS = 400;

const pad = (str) => {
    return '\n' + str + '\n';
};

function formatCoordinate(x, z) {
    return `(${x},${z})`;
}

function formatHeight(value) {
    return Number.isFinite(value) ? String(value) : '?';
}

function formatName(name) {
    if (!name)
        return 'unknown';
    return String(name).replace(/^minecraft:/, '');
}

function formatDecimal(value) {
    return Number.isFinite(value) ? value.toFixed(2) : '?';
}

function formatCountPairs(counts, limit = 8) {
    const entries = Object.entries(counts || {})
        .filter(([name, count]) => name !== 'air' && count > 0);
    if (entries.length === 0)
        return 'none';
    entries.sort((a, b) => b[1] - a[1]);
    const shown = entries.slice(0, limit).map(([name, count]) => `${name}=${count}`);
    if (entries.length > limit)
        shown.push(`+${entries.length - limit} more`);
    return shown.join(', ');
}

function formatBlockPairs(pairs, limit = 10) {
    const filtered = (Array.isArray(pairs) ? pairs : [])
        .filter(([name, count]) => name && !/^(minecraft:)?air$/.test(name) && count > 0);
    if (filtered.length === 0)
        return 'none';
    const shown = filtered.slice(0, limit).map(([name, count]) => `${formatName(name)}=${count}`);
    if (filtered.length > limit)
        shown.push(`+${filtered.length - limit} more`);
    return shown.join(', ');
}

function formatList(values) {
    if (!Array.isArray(values) || values.length === 0)
        return 'none';
    return values.join(', ');
}

async function queryService(endpoint, params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
        search.set(key, String(value));
    const url = `${getServiceUrl()}${endpoint}?${search.toString()}`;
    let response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: serviceHeaders() });
    } catch (error) {
        throw new Error(`cannot reach topography service at ${getServiceUrl()} (${error.message})`, { cause: error });
    }
    let payload;
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
}

async function runQuery(endpoint, params, formatter, agent = null) {
    try {
        const agentName = terrainAgentName(agent);
        const data = await queryService(endpoint, agentName ? { ...params, agent: agentName } : params);
        return formatter(data);
    } catch (error) {
        return `Topography error: ${error.message}`;
    }
}

function formatTopography(data) {
    const lines = [
        `TOPOGRAPHY ${formatCoordinate(data.from.x, data.from.z)} -> ${formatCoordinate(data.to.x, data.to.z)}: ${data.sample_count} columns, surface y ${formatHeight(data.min_y)}..${formatHeight(data.max_y)}.`
    ];
    const runs = data.runs || [];
    for (const run of runs.slice(0, MAX_RUNS)) {
        const span = run.x1 === run.x2 && run.z1 === run.z2
            ? formatCoordinate(run.x1, run.z1)
            : `${formatCoordinate(run.x1, run.z1)}->${formatCoordinate(run.x2, run.z2)}`;
        let bed = '';
        if (Number.isFinite(run.bed_min)) {
            bed = run.bed_min === run.bed_max
                ? ` bed y=${run.bed_min}`
                : ` bed y=${run.bed_min}..${run.bed_max}`;
        }
        lines.push(`- ${span} y=${formatHeight(run.y)} ${formatName(run.material)} (${run.length})${bed}`);
    }
    if (runs.length > MAX_RUNS)
        lines.push(`- ... ${runs.length - MAX_RUNS} more runs omitted`);
    const transitions = data.transitions || [];
    if (transitions.length > 0) {
        const shown = transitions.slice(0, MAX_TRANSITIONS)
            .map(t => `${formatCoordinate(t.x, t.z)} ${t.from}->${t.to}${Number.isFinite(t.bed_y) ? ` (bed y=${t.bed_y})` : ''}`);
        if (transitions.length > MAX_TRANSITIONS)
            shown.push(`+${transitions.length - MAX_TRANSITIONS} more`);
        lines.push(`Shoreline crossings: ${shown.join(', ')}`);
    } else {
        lines.push('No land/water crossings along this line.');
    }
    return pad(lines.join('\n'));
}

function formatAreaComposition(data) {
    const surface = data.surface || {};
    const lines = [
        `AREA_COMPOSITION center=${formatCoordinate(data.center.x, data.center.z)} radius=${data.radius}: ${data.columns} columns, ${data.chunks} chunks, biome ${formatName(data.dominant_biome)}.`,
        `- surface y ${formatHeight(surface.min_y)}..${formatHeight(surface.max_y)} avg ${formatDecimal(surface.avg_y)}, water ${(100 * (surface.water_fraction || 0)).toFixed(1)}%.`,
        `- composition: ${formatCountPairs(data.composition)}.`,
        `- artificiality ${formatDecimal(data.artificiality_score)} (chunk avg ${formatDecimal(data.avg_chunk_artificiality)}).`,
        `- top blocks: ${formatBlockPairs(data.top_blocks)}.`,
        `- strong indicators: ${formatCountPairs(data.strong_indicators)}.`
    ];
    if (Array.isArray(data.engineered_blocks) && data.engineered_blocks.length > 0)
        lines.push(`- built: ${formatBlockPairs(data.engineered_blocks)}.`);
    if (data.highest_ground && Number.isFinite(data.highest_ground.y)) {
        const dx = data.highest_ground.x - data.center.x;
        const dz = data.highest_ground.z - data.center.z;
        const distance = Math.round(Math.hypot(dx, dz));
        lines.push(`- highest ground: (${data.highest_ground.x},${data.highest_ground.z}) y=${formatHeight(data.highest_ground.y)}, ~${distance} blocks from center.`);
    }
    if (data.missing_chunks)
        lines.push(`- missing chunks: ${data.missing_chunks} (not loaded from the save yet).`);
    if (data.unexplored_chunks > 0)
        lines.push(`- unexplored: ${data.unexplored_chunks} chunks never seen by you.`);
    return pad(lines.join('\n'));
}

function formatShoreline(data) {
    const segments = data.segments || [];
    const lines = [
        `SHORELINE center=${formatCoordinate(data.center.x, data.center.z)} radius=${data.radius}: water_at_center=${Boolean(data.water_at_center)}, ${segments.length} segments, ${data.point_count} points.`
    ];
    if (segments.length === 0)
        lines.push('- no shoreline found in range.');
    let printed = 0;
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const points = [];
        for (const [x, z] of segment) {
            if (printed >= MAX_SHORELINE_POINTS)
                break;
            points.push(formatCoordinate(x, z));
            printed += 1;
        }
        if (points.length === 0) {
            lines.push(`- segment ${i + 1}: omitted (point limit reached).`);
            continue;
        }
        const omitted = segment.length - points.length;
        const suffix = omitted > 0 ? ` ... (${omitted} more)` : '';
        lines.push(`- segment ${i + 1}: ${points.join(' ')}${suffix}`);
        if (printed >= MAX_SHORELINE_POINTS)
            break;
    }
    if (printed >= MAX_SHORELINE_POINTS && printed < data.point_count)
        lines.push(`- point limit reached (${MAX_SHORELINE_POINTS} of ${data.point_count} points shown).`);
    if (data.missing_chunks)
        lines.push(`- missing chunks: ${data.missing_chunks}`);
    if (data.unexplored_chunks > 0)
        lines.push(`- unexplored: ${data.unexplored_chunks} chunks never seen by you.`);
    return pad(lines.join('\n'));
}

function formatRecall(data) {
    const column = data.column || {};
    const surface = data.surface || {};
    const lines = [
        `RECALL ${formatCoordinate(column.x, column.z)} [chunk ${data.chunk.cx},${data.chunk.cz}]: column y=${formatHeight(column.y)} ${formatName(column.material)}${column.water ? ' (water)' : ''}, ground y=${formatHeight(column.ground_y)} ${formatName(column.ground_material)}.`,
        `- chunk surface y ${formatHeight(surface.min_y)}..${formatHeight(surface.max_y)} avg ${formatDecimal(surface.avg_y)}, water columns ${surface.water_columns ?? '?'}.`,
        `- biome ${formatName(data.dominant_biome)}, artificiality ${formatDecimal(data.artificiality_score)}.`,
        `- composition: ${formatCountPairs(data.composition)}.`,
        `- top blocks: ${formatBlockPairs(data.top_blocks)}.`,
        `- strong indicators: ${formatList(data.strong_indicators)}.`
    ];
    if (data.source)
        lines.push(`- source: ${data.source}`);
    return pad(lines.join('\n'));
}

const COMPASS = { north: 'N', south: 'S', east: 'E', west: 'W', northeast: 'NE', northwest: 'NW', southeast: 'SE', southwest: 'SW' };

export function formatFlatAreas(data) {
    const areas = data.areas || [];
    const width = data.width;
    const depth = data.depth;
    const head = `FLAT_AREAS center=${formatCoordinate(data.center.x, data.center.z)} r=${data.radius} ${width}x${depth} max_delta=${data.max_delta}:`;
    const lines = [];
    if (areas.length === 0) {
        lines.push(`${head} none found.`);
        lines.push('- try a larger radius, a smaller footprint, or a higher max_delta (water, trees, and built ground are excluded).');
    } else {
        lines.push(`${head} ${areas.length} found.`);
        for (const area of areas) {
            const delta = area.y_max - area.y_min;
            const dir = COMPASS[area.direction] || area.direction;
            const water = area.water_columns ? `, ${area.water_columns} water` : '';
            lines.push(`- ${formatCoordinate(area.x1, area.z1)}->${formatCoordinate(area.x2, area.z2)} y=${formatHeight(area.y_min)}${delta ? `..${area.y_max}` : ''} ${formatName(area.floor_material)}, ${Math.round(area.distance)} ${dir}${water}`);
        }
    }
    if (data.missing_chunks)
        lines.push(`- missing chunks: ${data.missing_chunks} (unloaded areas were skipped).`);
    if (data.unexplored_chunks > 0)
        lines.push(`- unexplored: ${data.unexplored_chunks} chunks never seen by you.`);
    return pad(lines.join('\n'));
}

function dirVector(from, to) {
    return { x: Math.sign(to.x - from.x), z: Math.sign(to.z - from.z) };
}

export function formatBridgeSpan(data) {
    const start = formatCoordinate(data.start.x, data.start.z);
    const via = data.dir || (data.target ? `to ${formatCoordinate(data.target.x, data.target.z)}` : '');
    const cautions = Array.isArray(data.caution) ? data.caution : [];
    const lines = [];
    if (!data.span) {
        lines.push(`BRIDGE_SPAN from ${start} ${via}: no water crossing found.`);
    } else {
        const depth = data.depth || {};
        lines.push(`BRIDGE_SPAN from ${start} ${via}: ${data.span} water blocks at y=${formatHeight(data.water_y)}, bed y=${formatHeight(data.bed_y?.min)}..${formatHeight(data.bed_y?.max)} (depth ${formatHeight(depth.min)}..${formatHeight(depth.max)}, avg ${formatDecimal(depth.avg)}).`);
        const near = data.near_shore;
        const far = data.far_shore;
        lines.push(`- near shore ${near ? `${formatCoordinate(near.x, near.z)} y=${formatHeight(near.y)}` : '?'}, far shore ${far ? `${formatCoordinate(far.x, far.z)} y=${formatHeight(far.y)}` : '?'}, deck y=${formatHeight(data.deck_y)}.`);
        if (near && far && Array.isArray(data.water) && data.water.length > 0) {
            const dir = dirVector(near, data.water[0]);
            if (Math.abs(dir.x) + Math.abs(dir.z) === 1) {
                const surfaces = new Map();
                surfaces.set(`${near.x},${near.z}`, { y: near.y, water: false });
                surfaces.set(`${far.x},${far.z}`, { y: far.y, water: false });
                for (const column of data.water)
                    surfaces.set(`${column.x},${column.z}`, { y: column.y, water: true });
                const plan = planBridge({
                    getSurface: (x, z) => surfaces.get(`${x},${z}`) || null,
                    start: { x: near.x, z: near.z },
                    dir,
                    maxLength: data.water.length + 2
                });
                if (!plan.error) {
                    const pillarColumns = new Set(plan.pillars.map(p => `${p.x},${p.z}`)).size;
                    lines.push(`- plan: deck ${plan.length} blocks at y=${plan.deckY}, ${pillarColumns} pillars (every ~${plan.spacing}), ${plan.landings.length} landings, ${plan.stairs.length} stairs.`);
                }
            }
        }
    }
    if (cautions.length > 0)
        lines.push(`- caution: ${cautions.join('; ')}.`);
    if (data.missing_chunks)
        lines.push(`- missing chunks: ${data.missing_chunks}`);
    if (data.unexplored_chunks > 0)
        lines.push(`- unexplored: ${data.unexplored_chunks} chunks never seen by you.`);
    return pad(lines.join('\n'));
}

function landformWhere(form) {
    if (form.inside || form.direction === 'here')
        return 'here (you are on or in it)';
    return `${Math.round(form.distance)} blocks ${form.direction}`;
}

function landformSize(form) {
    const size = form.size || {};
    if (!Number.isFinite(size.length))
        return '';
    return Number.isFinite(size.width) && size.width > 0
        ? `~${size.length}x${size.width} blocks`
        : `~${size.length} blocks`;
}

/** One line of full detail for a landform from /landforms (also usable for the /perception field). */
export function formatLandform(form) {
    const at = Number.isFinite(form.x) && Number.isFinite(form.z) ? formatCoordinate(form.x, form.z) : '?';
    const size = form.size || {};
    const lo = formatHeight(form.y_min);
    const hi = formatHeight(form.y_max);
    const head = `${form.kind} ${landformWhere(form)}`;
    const long = Number.isFinite(size.length) ? `~${size.length} blocks long` : null;
    const wide = Number.isFinite(size.width) ? `~${size.width} wide` : null;
    let details;
    switch (form.kind) {
        case 'cliff':
            details = [`y ${lo} to ${hi}`, `at ${at}`, form.facing ? `faces ${form.facing}` : null, long];
            break;
        case 'canyon':
            details = [`y ${lo} to ${hi}`, wide, long, `at ${at}`];
            break;
        case 'beach':
            details = [long, wide, `at ${at}`];
            break;
        case 'island':
            details = [landformSize(form), `peak y ${hi}`, `centre ${at}`];
            break;
        case 'hill': case 'mountain':
            details = [`peak y ${hi} at ${at}`, `base ~y ${lo}`, landformSize(form)];
            break;
        case 'ridge':
            details = [`crest y ${hi} at ${at}`, `base ~y ${lo}`, long, wide];
            break;
        case 'plateau':
            details = [`top y ${hi}`, `base ~y ${lo}`, `centre ${at}`, landformSize(form)];
            break;
        case 'valley':
            details = [`floor y ${lo} at ${at}`, `flanks ~y ${hi}`, long];
            break;
        case 'river':
            details = [`surface y ${lo}`, `at ${at}`, long, wide];
            break;
        case 'lake': case 'ocean':
            details = [`surface y ${lo}`, `centre ${at}`, landformSize(form)];
            break;
        default:
            details = [`y ${lo} to ${hi}`, `centre ${at}`, landformSize(form)];
    }
    const text = `${head}, ${details.filter(Boolean).join(', ')}`;
    return form.partial ? `${text} (extent partly unknown)` : text;
}

export function formatLandforms(data) {
    const forms = Array.isArray(data.landforms) ? data.landforms : [];
    const head = `LANDFORMS center=${formatCoordinate(data.center.x, data.center.z)} r=${data.radius}:`;
    const lines = [forms.length === 0 ? `${head} none recognised.` : `${head} ${forms.length} found, nearest/most salient first.`];
    for (const form of forms)
        lines.push(`- ${formatLandform(form)}`);
    if (data.missing_chunks)
        lines.push(`- missing chunks: ${data.missing_chunks} (unloaded areas were skipped).`);
    if (data.unexplored_chunks > 0)
        lines.push(`- unexplored: ${data.unexplored_chunks} chunks never seen by you.`);
    return pad(lines.join('\n'));
}

// ---- long-range overview ----
export const OVERVIEW_MAX_CHARS = 800;
const OVERVIEW_DIRECTIONS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

function overviewFeatureLine(feature) {
    const at = Number.isFinite(feature.x) && Number.isFinite(feature.z) ? ` (${feature.x},${feature.z})` : '';
    const distance = Number.isFinite(feature.distance) ? Math.round(feature.distance) : '?';
    const direction = feature.direction || '?';
    switch (feature.kind) {
        case 'high_ground':
            return `high ground: ${distance} ${direction}${at}${Number.isFinite(feature.y) ? ` y=${feature.y}` : ''}`;
        case 'water':
            return `water: ${distance} ${direction}${at}, about ${feature.chunks ?? '?'} chunks`
                + `${feature.open ? ', extends beyond what you have seen' : ''}`;
        case 'built':
            return `built area: ${distance} ${direction}${at}`;
        default:
            return `${formatName(feature.kind)}: ${distance} ${direction}${at}`;
    }
}

function overviewCellText(cell) {
    const land = formatName(cell.land || 'unknown');
    const water = Number(cell.water) > 0 ? `, water ${Math.round(cell.water * 100)}%` : '';
    const y = Array.isArray(cell.y) ? `, y ${formatHeight(cell.y[0])}-${formatHeight(cell.y[1])}` : '';
    const partial = cell.partial ? ' (partly seen)' : '';
    return `${cell.from}-${cell.to} ${land}${water}${y}${partial}`;
}

/**
 * Big-picture overview of everything the bot has seen beyond ~128 blocks, capped at 800 chars.
 * Direction lines go first when trimming (outermost ring inward), then features from the end.
 */
export function formatOverview(data) {
    if (!data || typeof data !== 'object' || data.unavailable)
        return 'OVERVIEW: topography is not available here.';
    const radius = Number.isFinite(data.radius) ? data.radius : 2048;
    const header = `OVERVIEW of what you have seen (beyond ~128 blocks), radius ${radius}:`;
    const featureLines = (Array.isArray(data.features) ? data.features : []).map(overviewFeatureLine);
    let directionCells = [];
    const cells = (Array.isArray(data.cells) ? data.cells : []).filter(cell => cell && cell.dir);
    for (const direction of OVERVIEW_DIRECTIONS) {
        const list = cells.filter(cell => cell.dir === direction)
            .sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
        for (const cell of list)
            directionCells.push({ direction, cell });
    }
    if (featureLines.length === 0 && directionCells.length === 0)
        return 'OVERVIEW: you have not seen anything beyond your immediate surroundings yet.';

    const render = () => {
        const lines = [header, ...featureLines];
        for (const direction of OVERVIEW_DIRECTIONS) {
            const parts = directionCells.filter(item => item.direction === direction)
                .map(item => overviewCellText(item.cell));
            if (parts.length > 0)
                lines.push(`${direction}: ${parts.join('; ')}`);
        }
        return lines.join('\n');
    };

    // Leave room for the newlines `pad()` adds around command output.
    const cap = OVERVIEW_MAX_CHARS - 2;
    let text = render();
    while (text.length > cap && directionCells.length > 0) {
        const outermost = Math.max(...directionCells.map(item => Number(item.cell.to) || 0));
        const kept = directionCells.filter(item => (Number(item.cell.to) || 0) !== outermost);
        if (kept.length === directionCells.length)
            break;
        directionCells = kept;
        text = render();
    }
    while (text.length > cap && featureLines.length > 0) {
        featureLines.pop();
        text = render();
    }
    if (text.length > cap)
        text = `${text.slice(0, cap - 1)}…`;
    return text;
}

export const topographyList = [
    {
        name: '!topography',
        description: 'Get a 1D surface height/material profile along a line between two coordinates. Use for bridges, roads, or foundations. For highest/lowest ground, area, or direction questions use the automatic TOPOGRAPHY block or !area_composition instead.',
        params: {
            'x1': { type: 'int', description: 'Start x coordinate.' },
            'z1': { type: 'int', description: 'Start z coordinate.' },
            'x2': { type: 'int', description: 'End x coordinate.' },
            'z2': { type: 'int', description: 'End z coordinate.' }
        },
        perform: function (agent, x1, z1, x2, z2) {
            return runQuery('/topography', { x1, z1, x2, z2 }, formatTopography, agent);
        }
    },
    {
        name: '!area_composition',
        description: 'Get a 2D area summary around a coordinate: block composition, biome, surface stats, highest ground, and built/engineered blocks. Use for area, peak, or direction questions.',
        params: {
            'x': { type: 'int', description: 'Center x coordinate.' },
            'z': { type: 'int', description: 'Center z coordinate.' },
            'radius': { type: 'int', description: 'Radius in blocks around the center.', domain: [1, 257, '[)'] }
        },
        perform: function (agent, x, z, radius) {
            return runQuery('/area_composition', { x, z, radius }, formatAreaComposition, agent);
        }
    },
    {
        name: '!landforms',
        description: 'List named landforms (cliff, canyon, hill, mountain, ridge, plateau, valley, plain, lake, river, ocean, beach, island) around a coordinate, nearest and most salient first, each with direction, distance, y range, position, size, and cliff facing. Islands are reported only when every shore has been seen. Only explored ground counts.',
        params: {
            'x': { type: 'int', description: 'Center x coordinate.' },
            'z': { type: 'int', description: 'Center z coordinate.' },
            'radius': { type: 'int', description: 'Radius in blocks around the center.', domain: [16, 257, '[)'] }
        },
        perform: function (agent, x, z, radius) {
            return runQuery('/landforms', { x, z, radius }, formatLandforms, agent);
        }
    },
    {
        name: '!shoreline',
        description: 'Get the exact shoreline polyline (list of x,z points) of the nearest water body around a coordinate.',
        params: {
            'x': { type: 'int', description: 'Center x coordinate.' },
            'z': { type: 'int', description: 'Center z coordinate.' },
            'radius': { type: 'int', description: 'Radius in blocks around the center.', domain: [1, 257, '[)'] }
        },
        perform: function (agent, x, z, radius) {
            return runQuery('/shoreline', { x, z, radius }, formatShoreline, agent);
        }
    },
    {
        name: '!flatAreas',
        description: 'Find flat, dry, tree-free rectangular building sites near a coordinate (up to 5, nearest first). Use before building a house or base.',
        params: {
            'x': { type: 'int', description: 'Center x coordinate.' },
            'z': { type: 'int', description: 'Center z coordinate.' },
            'radius': { type: 'int', description: 'Search radius in blocks.', domain: [1, 129, '[)'] },
            'width': { type: 'int', description: 'Footprint size along x in blocks.', domain: [1, 65, '[)'] },
            'depth': { type: 'int', description: 'Footprint size along z in blocks.', domain: [1, 65, '[)'] }
        },
        perform: function (agent, x, z, radius, width, depth) {
            return runQuery('/flat_areas', { x, z, radius, width, depth }, formatFlatAreas, agent);
        }
    },
    {
        name: '!bridgeSpan',
        description: 'Scan from a shore coordinate in a compass direction and report the water crossing: near/far shore, water depth, bed height, safe deck y, and a pillar/landing plan. Use before building a bridge.',
        params: {
            'x': { type: 'int', description: 'Start x coordinate (on the near shore).' },
            'z': { type: 'int', description: 'Start z coordinate (on the near shore).' },
            'direction': { type: 'string', description: 'north, south, east or west.' }
        },
        perform: function (agent, x, z, direction) {
            return runQuery('/bridge_span', { x, z, dir: String(direction || '').toLowerCase() }, formatBridgeSpan, agent);
        }
    },
    {
        name: '!recall',
        description: 'Recall the stored topographic summary (surface, biome, composition) for the chunk containing a coordinate that was explored before.',
        params: {
            'x': { type: 'int', description: 'x coordinate to recall.' },
            'z': { type: 'int', description: 'z coordinate to recall.' }
        },
        perform: function (agent, x, z) {
            return runQuery('/recall', { x, z }, formatRecall, agent);
        }
    },
    {
        name: '!overview',
        description: 'Big-picture summary of everything you have seen beyond your immediate surroundings: far water, high ground, built areas and terrain by direction. Use it for questions about places that are far away or that you saw earlier.',
        params: {
            'radius': { type: 'int', description: 'Radius in blocks around you.', domain: [256, 4097, '[)'] }
        },
        perform: function (agent, radius) {
            const position = agent?.bot?.entity?.position;
            if (!position)
                return 'Topography error: the bot has no position yet';
            const params = {
                x: Math.floor(position.x),
                z: Math.floor(position.z),
                radius: Number.isFinite(radius) ? radius : 2048
            };
            const dimension = getDimension(agent);
            if (dimension)
                params.dimension = dimension;
            return runQuery('/overview', params, formatOverview, agent).then(text => pad(text));
        }
    }
];
