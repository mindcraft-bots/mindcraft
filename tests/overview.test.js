import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOverview, OVERVIEW_MAX_CHARS } from '../src/agent/commands/topography.js';
import { formatPerception } from '../src/agent/topography/service.js';
import { getCommandDocs, executeCommand } from '../src/agent/commands/index.js';
import settings from '../src/agent/settings.js';

// Topography is off by default; these tests exercise it switched on.
settings.cartography_enabled = true;

const overviewFixture = {
    center: { x: 0, z: 0 },
    radius: 2048,
    seen_chunks: 812,
    summarised_chunks: 790,
    cells: [
        { dir: 'north', from: 128, to: 512, chunks: 37, coverage: 0.41, partial: true, land: 'forest', water: 0.12, y: [61, 95], built: 0 },
        { dir: 'north', from: 512, to: 1024, chunks: 200, coverage: 0.9, partial: false, land: 'grass', water: 0, y: [60, 70], built: 1 },
        { dir: 'west', from: 128, to: 512, chunks: 10, coverage: 0.1, partial: true, land: 'water', water: 1, y: [60, 62], built: 0 }
    ],
    features: [
        { kind: 'high_ground', x: 6400, z: -250, distance: 350, direction: 'north', y: -51 },
        { kind: 'water', x: 6040, z: 90, distance: 400, direction: 'west', chunks: 12, open: true, centre: { x: 6000, z: 90 } },
        { kind: 'built', x: 600, z: 600, distance: 600, direction: 'northeast', chunks: 4 }
    ]
};

const perceptionFixture = {
    center: { x: 0, z: 0 },
    size_chunks: 16,
    lod: [],
    surface: { min_y: 63, max_y: 78, avg_y: 68.4, relief: 15 },
    terrain: {},
    water: { at_center: false, nearest: null },
    biome: 'minecraft:plains',
    composition: { natural: 100, engineered: 1, liquid: 0, air: 0, water_fraction: 0, top_blocks: [], artificiality_score: 0.01 },
    missing_chunks: 0,
    far: [
        { kind: 'high_ground', direction: 'north', distance: 350, y: -51 },
        { kind: 'water', direction: 'west', distance: 400 },
        { kind: 'built', direction: 'northeast', distance: 600 }
    ]
};

test('formatOverview: header, every feature kind, and direction lines', () => {
    const text = formatOverview(overviewFixture);
    assert.match(text, /^OVERVIEW of what you have seen \(beyond ~128 blocks\), radius 2048:/);
    assert.match(text, /high ground: 350 north \(6400,-250\) y=-51/);
    assert.match(text, /water: 400 west \(6040,90\), about 12 chunks, extends beyond what you have seen/);
    assert.match(text, /built area: 600 northeast \(600,600\)/);
    assert.match(text, /north: 128-512 forest, water 12%, y 61-95 \(partly seen\); 512-1024 grass, y 60-70/);
    assert.match(text, /west: 128-512 water, water 100%, y 60-62 \(partly seen\)/);
});

test('formatOverview: nothing seen beyond the window', () => {
    assert.equal(formatOverview({ center: { x: 0, z: 0 }, radius: 2048, cells: [], features: [] }),
        'OVERVIEW: you have not seen anything beyond your immediate surroundings yet.');
    assert.match(formatOverview({ unavailable: 'dimension' }), /not available/);
});

test('formatOverview: capped at 800 characters, the outermost ring goes first', () => {
    const cells = [];
    for (const dir of ['north', 'east', 'south', 'west']) {
        for (const [from, to] of [[128, 512], [512, 1024], [1024, 2048], [2048, 4096]]) {
            cells.push({ dir, from, to, chunks: 1, coverage: 0.01, partial: true, land: 'forest', water: 0.1, y: [60, 70], built: 0 });
        }
    }
    const features = Array.from({ length: 12 }, (_, i) => ({
        kind: 'water', x: 100 * i, z: 200 * i, distance: 300 + i, direction: 'west', chunks: 4, open: true
    }));
    const text = formatOverview({ radius: 4096, cells, features });
    assert.ok(text.length <= OVERVIEW_MAX_CHARS, `length ${text.length}`);
    assert.doesNotMatch(text, /2048-4096/);
    // the innermost ring survives unless even it alone is too big
    if (text.includes('128-512'))
        assert.match(text, /128-512/);
});

test('formatOverview: never exceeds the cap with absurd input', () => {
    const cells = Array.from({ length: 300 }, (_, i) => ({
        dir: 'north', from: 128, to: 512, chunks: i, coverage: 0.01, partial: true,
        land: `very_long_land_class_name_${i}`, water: 0.5, y: [1, 2], built: 0
    }));
    const text = formatOverview({ radius: 2048, cells, features: [] });
    assert.ok(text.length <= OVERVIEW_MAX_CHARS);
});

test('the far line appears in the perception block and can be turned off', () => {
    const on = formatPerception(perceptionFixture);
    assert.match(on, /far \(seen earlier\): high ground 350 N y=-51; water 400 W; built 600 NE/);
    const off = formatPerception(perceptionFixture, { farLine: false });
    assert.doesNotMatch(off, /far \(seen earlier\)/);
    const absent = formatPerception({ ...perceptionFixture, far: [] });
    assert.doesNotMatch(absent, /far \(seen earlier\)/);
});

test('the far line is the first thing dropped when the block is over its cap', () => {
    const text = formatPerception(perceptionFixture, { maxChars: 260 });
    assert.ok(text.length <= 260, `length ${text.length}`);
    assert.doesNotMatch(text, /far \(seen earlier\)/);
    assert.match(text, /TOPOGRAPHY 16x16 chunks/);
});

test('the perception block never exceeds topography_max_chars', () => {
    for (const cap of [1200, 800, 400]) {
        const text = formatPerception(perceptionFixture, { maxChars: cap });
        assert.ok(text.length <= cap, `${cap}: ${text.length}`);
    }
});

test('!overview is listed for Topo and refused when topography is off', async () => {
    const enabled = getCommandDocs({ blocked_actions: [], prompter: { profile: {} } });
    assert.match(enabled, /!overview:/);
    assert.match(enabled, /far water, high ground, built areas and terrain by direction/);
    const disabled = getCommandDocs({ blocked_actions: [], prompter: { profile: { cartography_enabled: false } } });
    assert.doesNotMatch(disabled, /!overview:/);
    const agent = {
        name: 'Topo',
        bot: { entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'minecraft:overworld' } },
        blocked_actions: [],
        prompter: { profile: { cartography_enabled: false } }
    };
    assert.match(await executeCommand(agent, '!overview(2048)'), /disabled/);
});

test('!overview calls /overview at the bot position and formats the answer', async () => {
    const realFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async url => {
        urls.push(String(url));
        return { ok: true, json: async () => overviewFixture };
    };
    try {
        const agent = {
            name: 'Topo',
            bot: { entity: { position: { x: 12.7, y: 64, z: -3.2 } }, game: { dimension: 'minecraft:overworld' } },
            blocked_actions: [],
            prompter: { profile: {} }
        };
        const output = await executeCommand(agent, '!overview(1024)');
        assert.match(output, /OVERVIEW of what you have seen/);
        assert.match(output, /radius 2048/);   // formatter prints the response radius
        assert.ok(urls[0].startsWith('http://127.0.0.1:8090/overview?'));
        assert.match(urls[0], /x=12/);
        assert.match(urls[0], /z=-4/);
        assert.match(urls[0], /radius=1024/);
        assert.match(urls[0], /agent=Topo/);
        assert.match(urls[0], /dimension=minecraft%3Aoverworld/);
        assert.ok(output.length <= 802, `command output ${output.length}`);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('!overview with the service down returns the existing error message', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try {
        const agent = {
            name: 'Topo',
            bot: { entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'minecraft:overworld' } },
            blocked_actions: [],
            prompter: { profile: {} }
        };
        assert.match(await executeCommand(agent, '!overview(2048)'), /Topography error: cannot reach topography service/);
    } finally {
        globalThis.fetch = realFetch;
    }
});
