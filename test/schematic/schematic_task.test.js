import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import minecraftData from 'minecraft-data';
import { SchematicTaskValidator, expectedCells } from '../../src/agent/tasks/schematic_task.js';
import { createResponder, responseFor } from '../../ci/mock-llm/server.js';
import settings from '../../settings.js';

const registry = minecraftData('1.21.4');
const data = { schem_path: 'ci/pattern.mc1.21.4.schem', origin: { x: 20, y: 80, z: 30 }, orientation: 'east' };

test('canonical settings select both profiles and retain trust and placement policy', () => {
    assert.deepEqual(settings.profiles, ['./alice.json', './andy.json']);
    assert.deepEqual(settings.known_bot_peers, ['Alice', 'Andy']);
    assert.equal(settings.schematic_placement_mode, 'delicate');
    assert.deepEqual(settings.trusted_command_senders, ['Sunny26639']);
});

test('strict asset selection, rotation, inventory and independent live-world validation', async () => {
    const world = new Map();
    const bot = { version: '1.21.4', registry, blockAt: p => world.get(`${p.x},${p.y},${p.z}`) ?? null };
    const validator = new SchematicTaskValidator(data, { bot });
    assert.deepEqual(await validator.initialize(), { stone: 2, dirt: 2 });
    assert.deepEqual(validator.cells.map(c => [c.position.x, c.position.z, c.name]), [
        [21, 30, 'stone'], [21, 31, 'air'], [21, 32, 'dirt'],
        [20, 30, 'dirt'], [20, 31, 'stone'], [20, 32, 'air'],
    ]);
    assert.equal(validator.validate().score, 0);
    for (const c of validator.cells) world.set(`${c.position.x},${c.position.y},${c.position.z}`, { name: c.name, stateId: c.stateId, getProperties: () => ({ ...c.properties }) });
    assert.deepEqual(validator.validate(), { valid: true, score: 1, mismatches: [] });
    world.set('21,80,31', { name: 'stone', stateId: 1, getProperties: () => ({}) });
    assert.equal(validator.validate().score, 5 / 6);
    world.set('21,80,30', { name: 'stone', stateId: 1, getProperties: () => ({ wrong: true }) });
    assert.equal(validator.validate().score, 4 / 6);
    bot.blockAt = () => { throw new Error('unloaded'); };
    assert.equal(validator.validate().score, 0);
    await assert.rejects(new SchematicTaskValidator({ ...data, schem_path: '../escape.schem' }, { bot }).initialize());
});

test('stateful orientation is transformed and properties must agree', () => {
    const source = { size: { x: 1, y: 1, z: 1 }, getBlock: () => ({}) };
    const cells = expectedCells(source, { transformState: (_block, orientation) => ({ name: 'oak_log', stateId: 42, properties: { axis: orientation === 'east' ? 'z' : 'x' } }) }, { x: 0, y: 0, z: 0 }, 'east');
    const bot = { blockAt: () => ({ name: 'oak_log', stateId: 42, getProperties: () => ({ axis: 'x' }) }) };
    const validator = new SchematicTaskValidator({}, { bot });
    validator.cells = cells;
    assert.equal(validator.validate().valid, false);
    assert.throws(() => expectedCells(source, {}, { x: 0, y: 0, z: 0 }, 'invalid'));
});

test('mock deterministically emits the real command and rejects unknown goals', () => {
    const goal = [{ role: 'user', content: 'CI_BUILD pattern 202 80 0 east' }];
    const command = '!buildSchematic("ci/pattern.mc1.21.4.schem", 202, 80, 0, "delicate", null, null, "east")';
    assert.equal(responseFor(goal), command);
    const respond = createResponder();
    assert.equal(respond(goal), command);
    assert.equal(respond(goal), '');
    assert.throws(() => responseFor([{ role: 'user', content: 'CI_BUILD other 0 0 0 north' }]));
});

test('real launcher loads both profiles and applies host, port and profile overrides', async () => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const env = { ...process.env };
    for (const name of ['PROFILES', 'SETTINGS_JSON', 'MINECRAFT_HOST', 'MINECRAFT_PORT', 'MINDSERVER_PORT']) delete env[name];
    delete env.NODE_TEST_CONTEXT;
    const launch = extra => spawnSync(process.execPath, ['--experimental-loader', fileURLToPath(new URL('./startup_loader.js', import.meta.url)), 'main.js'], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 10000 });
    const normal = launch({});
    assert.equal(normal.status, 0, normal.stderr);
    const agents = normal.stdout.split('\n').filter(line => line.startsWith('AGENT ')).map(line => JSON.parse(line.slice(6)));
    assert.deepEqual(agents.map(agent => agent.name), ['Alice', 'Andy']);
    assert.match(normal.stdout, /INIT 8082/);
    const overridden = launch({ MINECRAFT_HOST: 'purpur', MINECRAFT_PORT: '25566', PROFILES: '["./ci/configs/test_profile.json"]' });
    assert.equal(overridden.status, 0, overridden.stderr);
    const only = JSON.parse(overridden.stdout.split('\n').find(line => line.startsWith('AGENT ')).slice(6));
    assert.equal(only.name, 'SchemTester');
    assert.equal(only.host, 'purpur');
    assert.equal(only.port, 25566);
});
