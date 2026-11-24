import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import settings from '../src/agent/settings.js';
import {
    getServiceUrl,
    fetchPerception,
    formatPerception,
    formatLandformsLine,
    pushPosition,
    clearPerceptionCache,
    resetPushState
} from '../src/agent/topography/service.js';
import { Prompter } from '../src/models/prompter.js';
import { getCommandDocs, executeCommand } from '../src/agent/commands/index.js';
import { formatLandform } from '../src/agent/commands/topography.js';

// Topography is off by default; these tests exercise it switched on.
settings.cartography_enabled = true;

const perceptionFixture = {
    service: 'topography',
    center: { x: 120, z: -46 },
    size_chunks: 16,
    window: { cx1: 7, cz1: -49, cx2: 22, cz2: -34 },
    resolution: 'lod',
    lod: [
        {
            cell_chunks: 1,
            cells_per_side: 4,
            cx1: 7,
            cz1: -49,
            heights: [64, 65, 66, 67, 65, 66, 66, 67, 64, 65, 66, 67, 64, 65, 66, 67],
            water: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        },
        {
            cell_chunks: 2,
            cells_per_side: 4,
            cx1: 5,
            cz1: -47,
            heights: [64, 65, 67, 68, 64, 66, 67, 69, 63, 65, 68, 70, 63, 65, 69, 71],
            water: [0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]
        },
        {
            cell_chunks: 4,
            cells_per_side: 4,
            cx1: 1,
            cz1: -43,
            heights: [63, 65, 70, 72, 63, 66, 71, 73, 64, 67, 72, 74, 64, 68, 73, 75],
            water: [0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        }
    ],
    surface: { min_y: 63, max_y: 78, avg_y: 68.4, relief: 15 },
    terrain: {
        highest: { x: 168, z: -46, y: 78, dx: 48, dz: 0, distance: 48, direction: 'east', material: 'minecraft:stone' },
        lowest: { x: 120, z: -46, y: 63, dx: 0, dz: 0, distance: 0, direction: 'here', material: 'minecraft:grass_block' },
        highest_by_direction: {
            north: { y: 65, distance: 10, direction: 'north' },
            northeast: { y: 70, distance: 20, direction: 'northeast' },
            east: { y: 78, distance: 48, direction: 'east' },
            southeast: { y: 72, distance: 30, direction: 'southeast' },
            south: { y: 68, distance: 15, direction: 'south' },
            southwest: { y: 64, distance: 25, direction: 'southwest' },
            west: { y: 66, distance: 12, direction: 'west' },
            northwest: { y: 67, distance: 18, direction: 'northwest' }
        }
    },
    water: { at_center: false, nearest: { dx: 48, dz: 0, distance: 48, direction: 'east' } },
    biome: 'minecraft:plains',
    composition: {
        natural: 12345,
        engineered: 120,
        liquid: 800,
        air: 0,
        water_fraction: 0.06,
        top_blocks: [
            ['minecraft:stone', 5000],
            ['minecraft:grass_block', 3200],
            ['minecraft:oak_planks', 100]
        ],
        engineered_blocks: [
            ['minecraft:red_concrete', 64],
            ['minecraft:copper_block', 40]
        ],
        artificiality_score: 0.01
    },
    missing_chunks: 0,
    updated_at: 1699999999.0,
    window_version: 42
};

let server;
let baseUrl;
let requestCount;
let positionCount;
let lastPositionBody;
let previousEnv;
let previousUrlSetting;

test.before(async () => {
    requestCount = 0;
    positionCount = 0;
    lastPositionBody = null;
    server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/position') {
            let raw = '';
            req.on('data', chunk => { raw += chunk; });
            req.on('end', () => {
                positionCount += 1;
                try {
                    lastPositionBody = JSON.parse(raw || '{}');
                } catch {
                    lastPositionBody = null;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ accepted: true, queued: 256 }));
            });
            return;
        }
        if (url.pathname !== '/perception') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unknown endpoint' }));
            return;
        }
        requestCount += 1;
        const x = url.searchParams.get('x');
        if (x === '500') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'boom' }));
            return;
        }
        if (x === '599') {
            const timer = setTimeout(() => {
                if (!res.writableEnded) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(perceptionFixture));
                }
            }, 500);
            res.on('close', () => clearTimeout(timer));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(perceptionFixture));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    previousEnv = process.env.CARTOGRAPHY_SERVICE_URL;
    previousUrlSetting = settings.cartography_service_url;
    process.env.CARTOGRAPHY_SERVICE_URL = baseUrl;
    clearPerceptionCache();
});

test.after(async () => {
    if (previousEnv === undefined)
        delete process.env.CARTOGRAPHY_SERVICE_URL;
    else
        process.env.CARTOGRAPHY_SERVICE_URL = previousEnv;
    if (previousUrlSetting === undefined)
        delete settings.cartography_service_url;
    else
        settings.cartography_service_url = previousUrlSetting;
    delete settings.topography_perception;
    clearPerceptionCache();
    await new Promise(resolve => server.close(resolve));
});

test('getServiceUrl prefers env, then settings, then the default', () => {
    const savedEnv = process.env.CARTOGRAPHY_SERVICE_URL;
    const savedSetting = settings.cartography_service_url;
    try {
        delete process.env.CARTOGRAPHY_SERVICE_URL;
        delete settings.cartography_service_url;
        assert.equal(getServiceUrl(), 'http://127.0.0.1:8090');
        settings.cartography_service_url = 'http://settings.test:9000/';
        assert.equal(getServiceUrl(), 'http://settings.test:9000');
        process.env.CARTOGRAPHY_SERVICE_URL = 'http://env.test:9001/';
        assert.equal(getServiceUrl(), 'http://env.test:9001');
    } finally {
        if (savedEnv === undefined)
            delete process.env.CARTOGRAPHY_SERVICE_URL;
        else
            process.env.CARTOGRAPHY_SERVICE_URL = savedEnv;
        if (savedSetting === undefined)
            delete settings.cartography_service_url;
        else
            settings.cartography_service_url = savedSetting;
    }
});

test('formatPerception renders a compact LOD block within budget', () => {
    const block = formatPerception(perceptionFixture);
    assert.match(block, /^TOPOGRAPHY 16x16 chunks centered at \(120,-46\), LOD levels 1\/2\/4 chunks per cell/);
    assert.match(block, /compass: north=-Z, south=\+Z, east=\+X, west=-X/);
    assert.match(block, /heights \(NW->SE, y\):/);
    assert.match(block, /inner 1ch\/cell: 64 65 66 67 \/ 65 66 66 67/);
    assert.match(block, /ring 2ch\/cell: 64 65 67 68/);
    assert.match(block, /ring 4ch\/cell: 63 65 70 72/);
    assert.match(block, /water \(0 land, 1 water\):/);
    assert.match(block, /nearest water: east, 48 blocks; center: land/);
    assert.match(block, /relief: 15; biome: plains/);
    assert.match(block, /composition: natural 93%, engineered 1%, water 6%; top: stone, grass_block, oak_planks; artificiality 0\.01/);
    assert.match(block, /highest ground: east, ~48 blocks, y=78/);
    assert.match(block, /highest by direction: N 65 NE 70 E 78 SE 72 S 68 SW 64 W 66 NW 67/);
    assert.match(block, /built: red_concrete 64, copper_block 40/);
    assert.ok(block.length <= 1200, `block was ${block.length} characters`);
    assert.doesNotMatch(block, /minecraft:/);
});

test('fetchPerception returns the formatted block from the service', async () => {
    clearPerceptionCache();
    const block = await fetchPerception(null, { x: 120, z: -46, size: 16 });
    assert.match(block, /^TOPOGRAPHY 16x16 chunks centered at \(120,-46\)/);
    assert.match(block, /biome: plains/);
});

test('failure and timeout return an empty string without throwing', async () => {
    clearPerceptionCache();
    const failed = await fetchPerception(null, { x: 500, z: 0, size: 16 });
    assert.equal(failed, '');

    clearPerceptionCache();
    const timedOut = await fetchPerception(null, { x: 599, z: 0, size: 16, timeout_ms: 50 });
    assert.equal(timedOut, '');
});

test('disabled perception returns an empty string', async () => {
    clearPerceptionCache();
    const saved = settings.topography_perception;
    settings.topography_perception = false;
    try {
        const block = await fetchPerception(null, { x: 123, z: 45, size: 16 });
        assert.equal(block, '');
    } finally {
        if (saved === undefined)
            delete settings.topography_perception;
        else
            settings.topography_perception = saved;
    }
});

test('a profile can override the global perception setting', async () => {
    clearPerceptionCache();
    const agent = { bot: { entity: { position: { x: 300, y: 64, z: 300 } } } };
    const prompter = Object.create(Prompter.prototype);
    prompter.agent = agent;
    const saved = settings.topography_perception;
    try {
        settings.topography_perception = true;
        prompter.profile = { topography_perception: false };
        assert.equal(await prompter.replaceStrings('$TOPOGRAPHY', []), '');

        clearPerceptionCache();
        settings.topography_perception = false;
        prompter.profile = { topography_perception: true };
        const enabled = await prompter.replaceStrings('$TOPOGRAPHY', []);
        assert.match(enabled, /^TOPOGRAPHY/);
    } finally {
        if (saved === undefined)
            delete settings.topography_perception;
        else
            settings.topography_perception = saved;
    }
});

test('cartography_enabled false removes the block, docs, and commands', async () => {
    clearPerceptionCache();
    const profile = { cartography_enabled: false };
    const agent = {
        bot: { entity: { position: { x: 10, y: 64, z: 10 } } },
        blocked_actions: [],
        prompter: { profile }
    };
    const prompter = Object.create(Prompter.prototype);
    prompter.agent = agent;
    prompter.profile = profile;

    assert.equal(await prompter.replaceStrings('$TOPOGRAPHY', []), '');

    const docs = getCommandDocs(agent);
    assert.doesNotMatch(docs, /!topography:/);
    assert.doesNotMatch(docs, /!area_composition:/);
    assert.doesNotMatch(docs, /!shoreline:/);
    assert.doesNotMatch(docs, /!recall:/);

    const enabledDocs = getCommandDocs({ blocked_actions: [], prompter: { profile: {} } });
    assert.match(enabledDocs, /!topography:/);

    const result = await executeCommand(agent, '!topography(0,0,1,0)');
    assert.match(result, /disabled/);

    const enabledProfile = {};
    const enabledPrompter = Object.create(Prompter.prototype);
    enabledPrompter.agent = {
        bot: { entity: { position: { x: 10, y: 64, z: 10 } } },
        blocked_actions: [],
        prompter: { profile: enabledProfile }
    };
    enabledPrompter.profile = enabledProfile;
    assert.match(await enabledPrompter.replaceStrings('$TOPO_GUIDE', []), /North is -Z/);
    assert.equal(await prompter.replaceStrings('$TOPO_GUIDE', []), '');
});

test('perception requests are cached for one second', async () => {
    clearPerceptionCache();
    const before = requestCount;
    const first = await fetchPerception(null, { x: 200, z: -46, size: 16 });
    const second = await fetchPerception(null, { x: 200, z: -46, size: 16 });
    assert.equal(first, second);
    assert.ok(first.length > 0);
    assert.equal(requestCount - before, 1);
    clearPerceptionCache();
});

test('pushPosition sends a fire-and-forget position and throttles repeats', async () => {
    resetPushState();
    const before = positionCount;
    const agent = { bot: { entity: { position: { x: 120, y: 64, z: -46 } } } };
    pushPosition(agent);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(positionCount - before, 1);
    assert.deepEqual(lastPositionBody, { x: 120, z: -46, size_chunks: 16 });

    pushPosition(agent);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(positionCount - before, 1);

    const moved = { bot: { entity: { position: { x: 120 + 16 * 4, y: 64, z: -46 } } } };
    pushPosition(moved);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(positionCount - before, 2);
});

test('pushPosition does nothing when perception is disabled', async () => {
    resetPushState();
    const before = positionCount;
    const saved = settings.topography_perception;
    settings.topography_perception = false;
    try {
        pushPosition({ bot: { entity: { position: { x: 999, y: 64, z: 999 } } } });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(positionCount, before);
    } finally {
        if (saved === undefined)
            delete settings.topography_perception;
        else
            settings.topography_perception = saved;
    }
});

test('replaceStrings injects the perception block into the prompt', async () => {
    clearPerceptionCache();
    const agent = {
        name: 'tester',
        bot: { entity: { position: { x: 120, y: 64, z: -46 } } }
    };
    const prompter = Object.create(Prompter.prototype);
    prompter.agent = agent;
    prompter.profile = {};
    const prompt = await prompter.replaceStrings('$TOPOGRAPHY', []);
    assert.match(prompt, /TOPOGRAPHY 16x16 chunks centered at \(120,-46\)/);
    assert.match(prompt, /composition:/);

    const saved = settings.topography_perception;
    settings.topography_perception = false;
    try {
        const disabled = await prompter.replaceStrings('$TOPOGRAPHY', []);
        assert.equal(disabled, '');
    } finally {
        if (saved === undefined)
            delete settings.topography_perception;
        else
            settings.topography_perception = saved;
    }
});

// A bigger window than the fixture so the default cap forces trimming.
function bigPerception() {
    const level = (cell, side, base) => ({
        cell_chunks: cell, cells_per_side: side,
        heights: Array.from({ length: side * side }, (_, i) => base + (i % 37)),
        water: Array.from({ length: side * side }, (_, i) => (i % 3 === 0 ? 1 : 0)),
    });
    return { ...perceptionFixture, lod: [level(1, 8, 60), level(2, 8, 60), level(4, 8, 60)] };
}

test('trimming keeps composition and protected lines and never exceeds the cap', () => {
    const data = bigPerception();
    const full = formatPerception(data, { maxChars: 100000 });
    assert.ok(full.length > 1200, `fixture should exceed the default cap, was ${full.length}`);
    for (const cap of [1200, 900, 760]) {
        const block = formatPerception(data, { maxChars: cap });
        assert.ok(block.length <= cap, `cap ${cap}, block ${block.length}`);
        assert.match(block, /^TOPOGRAPHY 16x16/);
        assert.match(block, /compass:/);
        assert.match(block, /inner 1ch\/cell: 60 61/);
        assert.match(block, /nearest water: east, 48 blocks/);
        assert.match(block, /relief: 15; biome: plains/);
        assert.match(block, /composition: natural 93%/);
        assert.match(block, /trimmed/);
    }
});

// Classify an optional line by its drop rank (0 = dropped first).
const DROP_ORDER = [
    line => line.startsWith('  ring 4ch') && /: [01 /]+$/.test(line),
    line => line.startsWith('  ring 2ch') && /: [01 /]+$/.test(line),
    line => line.startsWith('  inner 1ch') && /: [01 /]+$/.test(line),
    line => line.startsWith('  ring 4ch') && !/: [01 /]+$/.test(line),
    line => line.startsWith('highest by direction'),
    line => line.startsWith('  ring 2ch') && !/: [01 /]+$/.test(line),
    line => line.startsWith('highest ground'),
];

test('trimming drops the lowest-value lines first, whole lines, in the documented order', () => {
    const data = bigPerception();
    const full = formatPerception(data, { maxChars: 100000 });
    const fullLines = full.split('\n');
    for (const matches of DROP_ORDER)
        assert.ok(fullLines.some(matches), 'full block should contain every optional line');
    // Just under the full size: only the lowest-value line (coarsest ring water) goes.
    const slight = formatPerception(data, { maxChars: full.length - 1 }).split('\n');
    assert.ok(!slight.some(DROP_ORDER[0]));
    for (const matches of DROP_ORDER.slice(1))
        assert.ok(slight.some(matches));
    // Shrinking the cap only removes lines, always the next one in order, and every kept line is whole.
    let previousPresent = DROP_ORDER.length;
    for (let cap = full.length; cap >= 300; cap -= 25) {
        const lines = formatPerception(data, { maxChars: cap }).split('\n');
        const present = DROP_ORDER.map(matches => lines.some(matches));
        // Dropped lines form a prefix of the drop order (the rest of the block is untouched).
        const keptFrom = present.indexOf(true);
        if (keptFrom !== -1)
            assert.ok(present.slice(keptFrom).every(Boolean), `cap ${cap}: ${present}`);
        const count = present.filter(Boolean).length;
        assert.ok(count <= previousPresent, `cap ${cap} brought lines back`);
        previousPresent = count;
    }
});

test('a section header disappears with its last row', () => {
    const data = bigPerception();
    const block = formatPerception(data, { maxChars: 480 });
    const lines = block.split('\n');
    const waterRows = lines.filter(line => line.startsWith('  ') && /: [01 /]+$/.test(line));
    assert.equal(lines.some(line => line.startsWith('water (0 land')), waterRows.length > 0);
});

test('topography_max_chars overrides the default; invalid values are ignored; opts win', () => {
    const data = bigPerception();
    const saved = settings.topography_max_chars;
    try {
        delete settings.topography_max_chars;
        const base = formatPerception(data);
        assert.ok(base.length <= 1200 && base.length > 1000, `default cap was ${base.length}`);
        settings.topography_max_chars = 800;
        assert.ok(formatPerception(data).length <= 800);
        for (const bad of [0, -5, 'abc', NaN, null])
            { settings.topography_max_chars = bad; assert.equal(formatPerception(data), base, String(bad)); }
        settings.topography_max_chars = 800;
        assert.ok(formatPerception(data, { maxChars: 600 }).length <= 600);
        settings.topography_max_chars = 5000;
        assert.ok(formatPerception(data).length > 1200);
    } finally {
        if (saved === undefined) delete settings.topography_max_chars;
        else settings.topography_max_chars = saved;
    }
});

test('a cap smaller than the protected lines still yields a block within the cap', () => {
    const block = formatPerception(bigPerception(), { maxChars: 300 });
    assert.ok(block.length <= 300, `block was ${block.length}`);
    assert.match(block, /^TOPOGRAPHY 16x16/);
    assert.match(block, /compass:/);
});

const landformFixture = [
    { kind: 'cliff', distance: 40.2, direction: 'west', inside: false, y_min: 70, y_max: 110 },
    { kind: 'hill', distance: 120, direction: 'north', inside: false, y_min: 70, y_max: 96 },
    { kind: 'lake', distance: 30, direction: 'east', inside: false, y_min: 63, y_max: 63 },
];

test('landforms line is compact, ordered as given, and placed after nearest water/settlement lines', () => {
    const line = formatLandformsLine(landformFixture);
    assert.equal(line, 'landforms: cliff 40 W y70-110; hill 120 N y96; lake 30 E');
    const block = formatPerception({ ...perceptionFixture, landforms: landformFixture, settlements_nearby: [
        { kind: 'settlement', inside: false, distance: 90, direction: 'south', building_count: 6, confidence: 0.9, center: { x: 1, z: 2 } }] });
    const lines = block.split('\n');
    const index = lines.indexOf(line);
    assert.ok(index > 0, block);
    assert.match(lines[index - 1], /^settlement:/);
    assert.match(lines[index + 1], /^relief: /);
});

test('canyon, beach and island get compact perception items and full-detail command lines', () => {
    const forms = [
        { kind: 'canyon', distance: 60, direction: 'east', inside: false, y_min: 40, y_max: 78, x: 60, z: 0,
          size: { length: 90, width: 12, area: 1080 }, partial: false, depth: 38 },
        { kind: 'beach', distance: 30, direction: 'south', inside: false, y_min: 63, y_max: 65, x: 0, z: 30,
          size: { length: 50, width: 6, area: 300 }, partial: true },
        { kind: 'island', distance: 80, direction: 'west', inside: false, y_min: 62, y_max: 72, x: -80, z: 0,
          size: { length: 40, width: 35, area: 1100 }, partial: false },
    ];
    assert.equal(formatLandformsLine(forms), 'landforms: canyon 60 E y40-78; beach 30 S; island 80 W y72');
    assert.match(formatLandform(forms[0]), /^canyon 60 blocks east, y 40 to 78, ~12 wide, ~90 blocks long, at \(60,0\)$/);
    assert.match(formatLandform(forms[1]), /^beach 30 blocks south, ~50 blocks long, ~6 wide, at \(0,30\) \(extent partly unknown\)$/);
    assert.match(formatLandform(forms[2]), /^island 80 blocks west, ~40x35 blocks, peak y 72, centre \(-80,0\)$/);
});

test('landforms line is limited, hides plains unless alone, and is absent when empty', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ kind: 'hill', distance: 10 + i, direction: 'east', y_max: 80 + i }));
    assert.equal(formatLandformsLine(many).split('; ').length, 4);
    const plain = { kind: 'plain', distance: 0, direction: 'here', inside: true, y_min: 64, y_max: 66 };
    assert.equal(formatLandformsLine([plain, landformFixture[2]]), 'landforms: lake 30 E');
    assert.equal(formatLandformsLine([plain]), 'landforms: plain here');
    assert.equal(formatLandformsLine([{ kind: 'plateau', distance: 0, direction: 'here', inside: true, y_max: 100 }]), 'landforms: plateau here y100');
    for (const empty of [[], undefined, null, 'x', [{}]])
        assert.equal(formatLandformsLine(empty), '');
    assert.doesNotMatch(formatPerception({ ...perceptionFixture, landforms: [] }), /landforms:/);
    assert.doesNotMatch(formatPerception(perceptionFixture), /landforms:/);
});

test('landforms line is protected: it survives trimming and the block stays within the cap', () => {
    const data = { ...bigPerception(), landforms: landformFixture };
    for (const cap of [1200, 900, 760]) {
        const block = formatPerception(data, { maxChars: cap });
        assert.ok(block.length <= cap, `cap ${cap}, block ${block.length}`);
        assert.match(block, /landforms: cliff 40 W y70-110; hill 120 N y96; lake 30 E/);
    }
    assert.ok(formatPerception(data).length <= 1200);
});
