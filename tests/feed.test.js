import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';
import { Feed } from '../src/agent/topography/feed.js';
import { SeenReporter } from '../src/agent/topography/seen.js';
import settings from '../src/agent/settings.js';

// Topography is off by default; these tests exercise it switched on.
settings.cartography_enabled = true;

function makeBot({ column = null } = {}) {
    const bot = new EventEmitter();
    bot.username = 'Topo';
    bot.game = { dimension: 'minecraft:overworld' };
    bot.registry = {
        blocksByStateId: {
            1: { name: 'stone' },
            2: { name: 'grass_block' },
            3: { name: 'air' },
        },
        biomes: { 1: { name: 'plains' } },
    };
    bot.world = {
        getColumn: () => column,
        getColumns: () => [{ chunkX: 0, chunkZ: 0 }],
    };
    return bot;
}

function makeColumn() {
    const sections = Array.from({ length: 24 }, () => ({
        data: { value: 3 }, // single-value air
    }));
    // y = 4 (firstY = -4, index 8): an indirect palette with 1-bit data (all stone)
    sections[8] = {
        data: {
            palette: [1, 2],
            data: { bitsPerValue: 1, data: new Uint32Array(128) },
        },
    };
    const biomes = Array.from({ length: 24 }, () => ({ data: { value: 1 } }));
    return { minY: -64, worldHeight: 384, sections, biomes };
}

function makeFeed({ profile = {}, column = null, fetchImpl = null, clock = { now: 0 } } = {}) {
    const calls = [];
    const doFetch = fetchImpl ?? (async (url, init) => {
        calls.push({ url, init });
        return { ok: true };
    });
    const agent = { name: 'Topo', prompter: { profile } };
    const seen = new SeenReporter(agent, { intervalMs: 600000, resyncMs: 0, fetchImpl: doFetch });
    const feed = new Feed(agent, { fetchImpl: doFetch, now: () => clock.now, seen });
    const bot = makeBot({ column });
    agent.bot = bot;
    feed.attach(bot);
    feed.stop(); // tests drive the queue explicitly
    return { feed, bot, agent, calls, clock, doFetch };
}

const settle = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function drain(feed) {
    for (let i = 0; i < 60; i++) {
        await settle();
        if (feed.queue.size === 0 && feed.inflight === 0) {
            await settle();
            if (feed.queue.size === 0 && feed.inflight === 0) return;
        }
    }
}

test('a loaded chunk is forwarded with name palettes, packed data and biomes', async () => {
    const { feed, bot, calls } = makeFeed({ column: makeColumn() });
    bot.emit('chunkColumnLoad', { x: 0, z: 0 });
    await drain(feed, calls);
    const rawCalls = calls.filter(c => String(c.url).endsWith('/chunk_raw'));
    assert.ok(rawCalls.length >= 1);
    const body = JSON.parse(rawCalls[0].init.body.toString('utf8'));
    assert.equal(body.format, 1);
    assert.equal(body.dimension, 'minecraft:overworld');
    assert.equal(body.agent, 'Topo');
    const chunk = body.chunks[0];
    assert.deepEqual({ cx: chunk.cx, cz: chunk.cz, min_y: chunk.min_y, height: chunk.height },
        { cx: 0, cz: 0, min_y: -64, height: 384 });
    // air sections are omitted; the one real section keeps its y and names
    assert.equal(chunk.sections.length, 1);
    assert.equal(chunk.sections[0].y, 4);
    assert.deepEqual(chunk.sections[0].palette, ['minecraft:stone', 'minecraft:grass_block']);
    assert.equal(chunk.sections[0].enc, 'packed');
    assert.equal(chunk.sections[0].bits, 1);
    assert.ok(chunk.sections[0].data.length > 0);
    assert.equal(chunk.biomes[0].palette[0], 'minecraft:plains');
});

test('a direct container becomes a local palette plus u16 indices', () => {
    const column = makeColumn();
    const values = new Array(4096).fill(1);
    for (let i = 0; i < 10; i++) values[i] = 2;
    column.sections[8] = {
        data: {
            data: { bitsPerValue: 15, data: new Uint32Array(4096) },
            get: (i) => values[i],
        },
    };
    const { feed } = makeFeed({ column });
    const chunk = feed.serialize(0, 0);
    const section = chunk.sections[0];
    assert.equal(section.enc, 'u16');
    assert.deepEqual(section.palette, ['minecraft:grass_block', 'minecraft:stone']);
    const raw = Buffer.from(section.data, 'base64');
    assert.equal(raw.length, 8192);
    assert.equal(raw.readUInt16LE(0), 0);   // grass_block
    assert.equal(raw.readUInt16LE(20), 1);  // stone
});

test('an unload drops the queued chunk and reports it to the seen ledger', async () => {
    const { feed, bot } = makeFeed({ column: makeColumn() });
    bot.emit('chunkColumnLoad', { x: 0, z: 0 });
    assert.equal(feed.queue.size, 1);
    bot.emit('chunkColumnUnload', { x: 0, z: 0 });
    assert.equal(feed.queue.size, 0);
    assert.equal(feed.seen.pending.get('minecraft:overworld')?.get('0,0')?.op, 'unload');
});

test('block changes are debounced (2 s quiet, 10 s max) and re-forwarded at most every 5 s', () => {
    const clock = { now: 0 };
    const { feed } = makeFeed({ column: makeColumn(), clock });
    feed._pump = () => {};
    clock.now = 1000;
    feed.bot.emit('blockUpdate', { stateId: 1 }, { stateId: 2, position: { x: 3, y: 65, z: 4 } });
    clock.now = 2000;
    feed._tick();
    assert.equal(feed.queue.size, 0, 'still inside the quiet period');
    clock.now = 3500;
    feed._tick();
    assert.equal(feed.queue.size, 1, '2 s after the last change');
    feed.queue.clear();
    // a chunk forwarded now is not forwarded again for 5 s
    feed.lastSent.set('0,0', 3500);
    feed._enqueue(0, 0);
    assert.equal(feed.queue.size, 0);
    clock.now = 8600;
    feed._enqueue(0, 0);
    assert.equal(feed.queue.size, 1);
    // the 10 s maximum age flushes a chunk that keeps changing
    feed.queue.clear();
    clock.now = 20000;
    feed._markDirty(1, 1);
    for (let t = 21000; t <= 30000; t += 1000) { clock.now = t; feed._markDirty(1, 1); feed._tick(); }
    assert.equal(feed.queue.size, 1);
});

test('queue cap drops the oldest entry and sets resync', () => {
    const { feed } = makeFeed({ column: makeColumn() });
    feed._pump = () => {};
    for (let i = 0; i < 5000; i++) feed._enqueue(i, 0);
    assert.equal(feed.queue.size, 4096);
    assert.equal(feed.resync, true);
});

test('the attach-time rescan coerces string chunk coordinates', () => {
    const { feed, bot } = makeFeed({ column: makeColumn() });
    feed._pump = () => {};
    bot.world.getColumns = () => [{ chunkX: '5', chunkZ: '-3' }, { chunkX: 'x', chunkZ: 1 }];
    feed._resync();
    assert.deepEqual([...feed.queue.keys()], ['5,-3']);
});

test('a failed batch is retried once, then dropped with a resync; no throw', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: false }; };
    const { feed, bot } = makeFeed({ column: makeColumn(), fetchImpl });
    bot.emit('chunkColumnLoad', { x: 0, z: 0 });
    await drain(feed, [1, 2, 3]);
    assert.ok(calls >= 2, 'retried');
    assert.equal(feed.queue.size, 0, 'dropped after the second failure');
    assert.equal(feed.resync, true);
    assert.equal(feed.inflight, 0);
});

test('a token is sent as Authorization: Bearer', async () => {
    const saved = settings.cartography_token;
    settings.cartography_token = 's3cret';
    try {
        const { feed, bot, calls } = makeFeed({ column: makeColumn() });
        bot.emit('chunkColumnLoad', { x: 0, z: 0 });
        await drain(feed, calls);
        const rawCall = calls.find(c => String(c.url).endsWith('/chunk_raw'));
        assert.equal(rawCall.init.headers.Authorization, 'Bearer s3cret');
    } finally {
        settings.cartography_token = saved;
    }
});

test('topography_feed off registers no chunk forwarding; the seen ledger still works', () => {
    const { feed, bot } = makeFeed({ column: makeColumn(), profile: { topography_feed: 'off' } });
    bot.emit('chunkColumnLoad', { x: 0, z: 0 });
    assert.equal(feed.queue.size, 0);
    assert.equal(feed.seen.pending.get('minecraft:overworld')?.get('0,0')?.op, 'load');
    feed.stop();
});

test('an enabled feed owns chunk events and still feeds the seen ledger', () => {
    const { feed, bot } = makeFeed({ column: makeColumn() });
    feed._pump = () => {};
    bot.emit('chunkColumnLoad', { x: 16, z: 32 });
    assert.equal(feed.queue.size, 1);
    assert.equal(feed.seen.pending.get('minecraft:overworld')?.get('1,2')?.op, 'load');
});

test('a gzipped body over 8 KB is decompressible and still valid JSON', async () => {
    const { feed, bot, calls } = makeFeed({ column: makeColumn() });
    // Make the payload large: a 16-bit direct section is ~8 KB of base64 on its own.
    const column = makeColumn();
    column.sections[8] = {
        data: {
            data: { bitsPerValue: 15, data: new Uint32Array(4096) },
            get: (i) => (i % 2 ? 1 : 2),
        },
    };
    feed.bot.world.getColumn = () => column;
    bot.emit('chunkColumnLoad', { x: 0, z: 0 });
    await drain(feed, calls);
    const call = [...calls].reverse().find(c => String(c.url).endsWith('/chunk_raw'));
    let raw = call.init.body;
    if (call.init.headers['Content-Encoding'] === 'gzip') raw = zlib.gunzipSync(raw);
    const body = JSON.parse(raw.toString('utf8'));
    assert.ok(body.chunks[0].sections[0].data.length > 0);
});

