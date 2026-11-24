import test from 'node:test';
import assert from 'node:assert/strict';
import { SeenReporter } from '../src/agent/topography/seen.js';
import settings from '../src/agent/settings.js';

// Topography is off by default; these tests exercise it switched on.
settings.cartography_enabled = true;

function makeAgent(profile = {}) {
    return { name: 'Bot', prompter: { profile }, bot: { game: { dimension: 'overworld' } } };
}

function makeReporter({ fail = () => false, agent = makeAgent() } = {}) {
    const posts = [];
    const fetchImpl = (url, init) => {
        if (fail()) return Promise.reject(new Error('down'));
        posts.push({ url, body: JSON.parse(init.body) });
        return Promise.resolve({ ok: true });
    };
    // long interval + no heartbeat: tests call flush() themselves
    const seen = new SeenReporter(agent, { intervalMs: 600000, resyncMs: 0, fetchImpl });
    const handlers = {};
    const bot = {
        game: agent.bot.game,
        on: (ev, fn) => { handlers[ev] = fn; },
        world: { getColumns: () => [] },
    };
    seen.attach(bot);
    return { seen, posts, handlers, bot, agent };
}
const at = (cx, cz) => ({ x: cx * 16, z: cz * 16 });
const sorted = (list) => [...list].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

test('first flush is a full resync: loaded set as chunks, replace true, unloaded list present', async () => {
    const { seen, posts, handlers } = makeReporter();
    handlers.chunkColumnLoad(at(1, 2));
    handlers.chunkColumnLoad(at(3, 4));
    handlers.chunkColumnLoad(at(5, 6));
    handlers.chunkColumnUnload(at(5, 6));
    assert.equal(await seen.flush(), 3);
    assert.equal(posts.length, 1);
    const { url, body } = posts[0];
    assert.match(url, /\/seen$/);
    assert.equal(body.agent, 'Bot');
    assert.equal(body.dimension, 'minecraft:overworld');
    assert.equal(body.replace, true);
    assert.deepEqual(sorted(body.chunks), [[1, 2], [3, 4]]);
    assert.deepEqual(body.unloaded, [[5, 6]]);
});

test('later batches send loads and unloads; repeat loads are not suppressed', async () => {
    const { seen, posts, handlers } = makeReporter();
    handlers.chunkColumnLoad(at(1, 1));
    await seen.flush();
    handlers.chunkColumnLoad(at(1, 1)); // reloaded: must be reported again
    handlers.chunkColumnLoad(at(2, 2));
    handlers.chunkColumnUnload(at(9, 9));
    await seen.flush();
    const body = posts[1].body;
    assert.ok(!body.replace);
    assert.deepEqual(sorted(body.chunks), [[1, 1], [2, 2]]);
    assert.deepEqual(body.unloaded, [[9, 9]]);
    assert.equal(await seen.flush(), 0, 'nothing pending -> no POST');
    assert.equal(posts.length, 2);
});

test('order inside a batch: the last event per chunk wins and an unloaded chunk still counts as seen', async () => {
    const { seen, posts, handlers } = makeReporter();
    await seen.flush(); // consume the initial resync
    handlers.chunkColumnLoad(at(1, 1));
    handlers.chunkColumnUnload(at(1, 1));   // loaded then unloaded: ends unloaded
    handlers.chunkColumnUnload(at(2, 2));
    handlers.chunkColumnLoad(at(2, 2));     // unloaded then loaded: ends loaded
    await seen.flush();
    const body = posts.at(-1).body;
    assert.deepEqual(body.unloaded, [[1, 1]]);
    assert.deepEqual(body.chunks, [[2, 2]]);
});

test('failed POST: nothing is lost, backs off, and the next success is a full resync', async () => {
    let down = true;
    const { seen, posts, handlers } = makeReporter({ fail: () => down });
    handlers.chunkColumnLoad(at(1, 1));
    handlers.chunkColumnLoad(at(2, 2));
    assert.equal(await seen.flush(), 0);
    assert.ok(seen.blockedUntil > Date.now() + 10000, 'backoff retained');
    assert.equal(seen.pending.get('minecraft:overworld').size, 2, 'requeued');
    down = false;
    handlers.chunkColumnUnload(at(2, 2));
    await seen.flush();
    const body = posts[0].body;
    assert.equal(body.replace, true, 'resync after an outage (the service may have restarted)');
    assert.deepEqual(body.chunks, [[1, 1]]);
    assert.deepEqual(body.unloaded, [[2, 2]]);
    assert.equal(seen.pending.size, 0);
});

test('a chunk that changes while the POST is in flight stays queued; one flush at a time', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const agent = makeAgent();
    const seen = new SeenReporter(agent, {
        intervalMs: 600000, resyncMs: 0,
        fetchImpl: async () => { await gate; return { ok: true }; },
    });
    seen.addChunk(1, 1);
    const flushing = seen.flush();
    assert.strictEqual(seen.flush(), flushing);
    await new Promise(r => setTimeout(r, 10));
    seen.removeChunk(1, 1);
    release();
    await flushing;
    assert.equal(seen.pending.get('minecraft:overworld').get('1,1').op, 'unload');
});

test('respawn / dimension change rescans the loaded set; disconnect reports everything unloaded', async () => {
    const { seen, posts, handlers, bot, agent } = makeReporter();
    handlers.chunkColumnLoad(at(1, 1));
    handlers.chunkColumnLoad(at(2, 2));
    await seen.flush();
    bot.world.getColumns = () => [{ chunkX: 7, chunkZ: 7 }];
    await seen._rescan(bot);
    await seen.flush();
    const body = posts.at(-1).body;
    assert.equal(body.replace, true);
    assert.deepEqual(body.chunks, [[7, 7]]);
    // the bot moves to the nether: the overworld is no longer loaded
    agent.bot.game.dimension = 'the_nether';
    bot.world.getColumns = () => [{ chunkX: 0, chunkZ: 0 }];
    await seen._rescan(bot);
    await seen.flush();
    const overworld = posts.filter(p => p.body.dimension === 'minecraft:overworld').at(-1).body;
    assert.deepEqual(overworld.chunks, []);
    assert.equal(overworld.replace, true);
    assert.ok(posts.some(p => p.body.dimension === 'minecraft:the_nether'));
    // disconnect
    agent.bot.game.dimension = 'overworld';
    handlers.chunkColumnLoad(at(3, 3));
    handlers.end();
    await seen.flush();
    const last = posts.filter(p => p.body.dimension === 'minecraft:overworld').at(-1).body;
    assert.deepEqual(last.chunks, []);
    assert.equal(last.replace, true);
});

test('heartbeat rescans real columns so pre-attach / missed chunks are not left frozen', async () => {
    const { seen, posts, bot } = makeReporter();
    // the attach-time rescan ran before the world had columns
    await seen.flush();
    bot.world.getColumns = () => [{ chunkX: 4, chunkZ: 5 }];
    await seen._heartbeat();
    await seen.flush();
    const body = posts.at(-1).body;
    assert.equal(body.replace, true);
    assert.deepEqual(body.chunks, [[4, 5]]);
    // a later heartbeat replaces the set rather than accumulating stale chunks
    bot.world.getColumns = () => [{ chunkX: 6, chunkZ: 7 }];
    await seen._heartbeat();
    await seen.flush();
    const later = posts.at(-1).body;
    assert.equal(later.replace, true);
    assert.deepEqual(later.chunks, [[6, 7]]);
    seen.stop();
});

test('string chunk coords from world.getColumns are coerced', async () => {
    const { seen, bot } = makeReporter();
    bot.world.getColumns = () => [{ chunkX: '4', chunkZ: '5' }];
    await seen._heartbeat();
    assert.deepEqual(seen.loadedKeys(), ['4,5']);
    seen.stop();
});

test('disabled when topography_seen_only is false; clears the queue', async () => {
    const { seen, posts, handlers, agent } = makeReporter();
    handlers.chunkColumnLoad(at(1, 1));
    agent.prompter.profile.topography_seen_only = false;
    assert.equal(await seen.flush(), 0);
    assert.equal(seen.pending.size, 0);
    assert.equal(posts.length, 0);
});
