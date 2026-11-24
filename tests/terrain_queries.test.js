import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const water = [20, 21, 22, 23, 24, 25, 26].map(x => ({ x, z: 48, y: 65, bed_y: 61, depth: 4 }));
const fixtures = {
    '/flat_areas': {
        center: { x: 22, z: 22 }, radius: 64, width: 9, depth: 9, max_delta: 1,
        areas: [
            { x1: 18, z1: 18, x2: 26, z2: 26, y_min: 70, y_max: 70, center_y: 70, distance: 0, direction: 'here', water_columns: 0, floor_material: 'minecraft:grass_block' },
            { x1: 30, z1: 10, x2: 38, z2: 18, y_min: 70, y_max: 71, center_y: 70, distance: 13.4, direction: 'northeast', water_columns: 1, floor_material: 'minecraft:sand' }
        ],
        missing_chunks: 2
    },
    '/bridge_span': {
        start: { x: 17, z: 48 }, dir: 'east', target: null,
        near_shore: { x: 19, z: 48, y: 66, material: 'minecraft:grass_block' },
        far_shore: { x: 27, z: 48, y: 66, material: 'minecraft:grass_block' },
        span: 7, water_y: 65, water,
        depth: { min: 4, max: 4, avg: 4.0 }, bed_y: { min: 61, max: 61 },
        longest_water_run: 7, water_runs: 1, deck_y: 67,
        caution: ['shore heights differ by 4 blocks'], missing_chunks: 0
    },
    '/topography': {
        from: { x: 18, z: 48 }, to: { x: 28, z: 48 }, sample_count: 11, min_y: 65, max_y: 66,
        runs: [
            { x1: 18, z1: 48, x2: 19, z2: 48, y: 66, material: 'minecraft:grass_block', length: 2 },
            { x1: 20, z1: 48, x2: 26, z2: 48, y: 65, material: 'minecraft:water', length: 7, bed_min: 58, bed_max: 61 }
        ],
        transitions: [{ x: 20, z: 48, from: 'land', to: 'water', bed_y: 61 }]
    }
};
let requests = [];
let server;
let topographyList;
let formatters;

test.before(async () => {
    formatters = await import('../src/agent/commands/topography.js');
    ({ topographyList } = formatters);
    server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        requests.push(url);
        const fixture = fixtures[url.pathname];
        res.writeHead(fixture ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fixture || { error: 'unknown endpoint' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    globalThis.process.env.CARTOGRAPHY_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    delete globalThis.process.env.CARTOGRAPHY_SERVICE_URL;
    await new Promise(resolve => server.close(resolve));
});

const command = name => topographyList.find(item => item.name === name);

test('!flatAreas queries /flat_areas and prints compact candidates', async () => {
    requests = [];
    const output = await command('!flatAreas').perform(null, 22, 22, 64, 9, 9);
    const url = requests[0];
    assert.equal(url.pathname, '/flat_areas');
    assert.equal(url.searchParams.get('width'), '9');
    assert.match(output, /FLAT_AREAS center=\(22,22\) r=64 9x9 max_delta=1: 2 found/);
    assert.match(output, /\(18,18\)->\(26,26\) y=70 grass_block, 0 here/);
    assert.match(output, /\(30,10\)->\(38,18\) y=70\.\.71 sand, 13 NE, 1 water/);
    assert.match(output, /missing chunks: 2/);
    assert.ok(output.length < 600, `output too long: ${output.length}`);
});

test('!flatAreas explains an empty result', () => {
    const output = formatters.formatFlatAreas({
        center: { x: 0, z: 0 }, radius: 10, width: 9, depth: 9, max_delta: 1, areas: [], missing_chunks: 0
    });
    assert.match(output, /none found/);
    assert.match(output, /larger radius/);
});

test('!bridgeSpan prints shores, bed depth, deck y, and a plan', async () => {
    requests = [];
    const output = await command('!bridgeSpan').perform(null, 17, 48, 'East');
    assert.equal(requests[0].searchParams.get('dir'), 'east');
    assert.match(output, /BRIDGE_SPAN from \(17,48\) east: 7 water blocks at y=65, bed y=61\.\.61 \(depth 4\.\.4, avg 4\.00\)/);
    assert.match(output, /near shore \(19,48\) y=66, far shore \(27,48\) y=66, deck y=67/);
    assert.match(output, /plan: deck 7 blocks at y=67, 3 pillars \(every ~3\), 2 landings, 0 stairs/);
    assert.match(output, /caution: shore heights differ by 4 blocks/);
    assert.ok(output.length < 600, `output too long: ${output.length}`);
});

test('!bridgeSpan reports no crossing', () => {
    const output = formatters.formatBridgeSpan({
        start: { x: 0, z: 0 }, dir: 'north', span: 0, water: [], caution: ['no water found along this line'], missing_chunks: 0
    });
    assert.match(output, /no water crossing found/);
    assert.match(output, /caution: no water found/);
});

test('!topography shows water bed height on runs and crossings', async () => {
    const output = await command('!topography').perform(null, 18, 48, 28, 48);
    assert.match(output, /y=65 water \(7\) bed y=58\.\.61/);
    assert.match(output, /Shoreline crossings: \(20,48\) land->water \(bed y=61\)/);
});
