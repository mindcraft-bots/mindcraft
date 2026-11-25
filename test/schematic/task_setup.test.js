import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { Task } from '../../src/agent/tasks/tasks.js';

function clock(t) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
}

async function drive(t, promise) {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; !done && i < 100; i++) {
        t.mock.timers.tick(50);
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(done, true, 'setup did not settle');
    return promise;
}

function fixture(options = {}) {
    const commands = [], goals = [];
    let loaded = false, filled = false, partiallyFilled = false;
    const bot = {
        registry: { itemsByName: { stone: {}, dirt: {} } },
        inventory: { slots: options.deny === 'clear' ? [{ name: 'dirt', count: 1 }] : [] },
        entity: { position: { x: 0, y: 64, z: 0 }, onGround: false },
        blockAt(pos) {
            if (!loaded || options.deny === 'chunks') return null;
            if (pos.y === 79 && options.obstruction) return { name: 'chest', boundingBox: 'block' };
            if (pos.y === 79 && (filled || options.existingPlatform || (partiallyFilled && pos.x < 20))) return { name: 'stone', boundingBox: 'block' };
            return { name: 'air', boundingBox: 'empty' };
        },
        chat(command) {
            commands.push(command);
            // Simulate the server asynchronously processing commands and sending updates.
            setTimeout(() => {
                const parts = command.split(' ');
                if (parts[0] === '/clear' && options.deny !== 'clear') bot.inventory.slots = [];
                if (parts[0] === '/give' && options.deny !== 'give') bot.inventory.slots.push({ name: parts[2], count: options.deny === 'partial' ? 1 : Number(parts[3]) });
                if (parts[0] === '/tp' && options.deny !== 'tp') {
                    bot.entity.position = { x: Number(parts[2]), y: Number(parts[3]), z: Number(parts[4]) };
                    loaded = true;
                    bot.entity.onGround = !!(filled || options.existingPlatform) && options.deny !== 'ground';
                }
                if (parts[0] === '/fill' && options.deny !== 'fill' && options.deny !== 'partial-fill') {
                    filled = true;
                    if (options.fall) bot.entity.position.y = 79;
                    bot.entity.onGround = options.deny !== 'ground' && !options.fall;
                }
                if (parts[0] === '/fill' && options.deny === 'partial-fill') partiallyFilled = true;
            }, 5);
        },
    };
    const data = { task_id: 'setup-test', type: 'schematic', agent_count: 1, human_count: 0, timeout: options.timeout ?? 0.25,
        origin: { x: 20, y: 80, z: 30 }, prepare_test_platform: true, goal: 'build' };
    const task = new Task({ bot, name: 'Tester', count_id: 0, actions: { executing: false } }, data);
    task.available_agents = ['Tester'];
    task.validator = {
        cells: [{ position: { x: 20, y: 80, z: 30 } }],
        initialize: options.initialize || (() => Promise.resolve({ stone: 2 })),
        validate: () => ({ valid: true, score: 1 }),
    };
    task.setAgentGoal = () => { goals.push('goal'); return Promise.resolve(); };
    return { task, bot, commands, goals };
}

for (const [deny, lastCommand] of [['clear', '/clear'], ['give', '/give'], ['partial', '/give'], ['tp', '/tp'], ['chunks', '/tp'], ['fill', '/fill'], ['partial-fill', '/fill'], ['ground', '/fill']]) {
    test(`setup fails closed on ${deny}`, async t => {
        clock(t);
        const { task, commands, goals } = fixture({ deny });
        await assert.rejects(drive(t, task.initBotTask()), /timed out/);
        assert.equal(task.schematicReady, false);
        assert.equal(task.isDone().score, 0);
        assert.deepEqual(goals, []);
        assert.equal(commands.at(-1).split(' ')[0], lastCommand);
    });
}

test('successful delayed setup verifies inventory, site and platform before starting the goal', async t => {
    clock(t);
    const { task, commands, goals } = fixture({ timeout: 2 });
    await drive(t, task.initBotTask());
    assert.equal(task.schematicReady, true);
    assert.deepEqual(goals, ['goal']);
    assert.deepEqual(commands.map(c => c.split(' ')[0]), ['/clear', '/give', '/tp', '/fill']);
    assert.match(commands.at(-1), / stone replace air$/);
    assert.equal(task.isDone(), false); // matching world alone is not a completed build
    task.schematicBuildCompleted = true;
    assert.equal(task.isDone().message, 'Task successful');
});

test('existing platform is not overwritten and obstructed platform is never filled', async t => {
    clock(t);
    const existing = fixture({ timeout: 2, existingPlatform: true });
    await drive(t, existing.task.initBotTask());
    assert.equal(existing.commands.some(c => c.startsWith('/fill')), false);
    const obstructed = fixture({ timeout: 2, obstruction: true });
    await assert.rejects(drive(t, obstructed.task.initBotTask()), /other than air or stone/);
    assert.equal(obstructed.commands.some(c => c.startsWith('/fill')), false);
    assert.deepEqual(obstructed.goals, []);
});

test('falling during remote chunk setup requires a second confirmed teleport', async t => {
    clock(t);
    const { task, commands, goals } = fixture({ timeout: 2, fall: true });
    await drive(t, task.initBotTask());
    assert.deepEqual(commands.map(c => c.split(' ')[0]), ['/clear', '/give', '/tp', '/fill', '/tp']);
    assert.deepEqual(goals, ['goal']);
});

test('hung initialization and late completion cannot issue commands or a goal', async t => {
    clock(t);
    let finish;
    const { task, commands, goals } = fixture({ initialize: () => new Promise(resolve => { finish = resolve; }) });
    const setup = task.initBotTask();
    await assert.rejects(drive(t, setup), /timed out/);
    finish({ stone: 2 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(commands, []);
    assert.deepEqual(goals, []);
    assert.equal(task.isDone().score, 0);
});

test('overall deadline applies before readiness and before accepting a matching build', () => {
    const { task, commands } = fixture({ timeout: 1 });
    task.taskStartTime = Date.now() - 1000;
    assert.equal(task.isDone().message, 'Task timeout reached');
    task.schematicReady = true;
    task.schematicBuildCompleted = true;
    assert.notEqual(task.isDone().message, 'Task successful');
    assert.deepEqual(commands, []);
});

test('deadline cancellation during pending setup prevents subsequent commands', async t => {
    clock(t);
    const { task, commands, goals } = fixture({ deny: 'give', timeout: 1 });
    const setup = task.initBotTask();
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(50);
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(950);
    assert.equal(task.isDone().message, 'Task timeout reached');
    await assert.rejects(drive(t, setup), /timed out|cancelled/);
    assert.deepEqual(commands.map(c => c.split(' ')[0]), ['/clear', '/give']);
    assert.deepEqual(goals, []);
});

test('setup has a separate 30-second cap even with a longer task deadline', async t => {
    clock(t);
    const { task, commands, goals } = fixture({ timeout: 120, initialize: () => new Promise(() => {}) });
    const setup = task.initBotTask();
    setup.catch(() => {});
    t.mock.timers.tick(30000);
    await assert.rejects(drive(t, setup), /timed out/);
    assert.deepEqual(commands, []);
    assert.deepEqual(goals, []);
});

test('agent exits nonzero on a schematic task failure', () => {
    const env = { ...process.env };
    delete env.TASK_RESULT_FILE;
    const program = `import { Agent } from './src/agent/agent.js';
        const agent = { task: { data: { task_id: 'failure' }, task_type: 'schematic', isDone: () => ({ message: 'Task timeout reached', score: 0 }) },
            history: { add: () => {}, save: () => {} }, killAll: () => { throw Error('incorrect successful shutdown'); } };
        await Agent.prototype.checkTaskDone.call(agent);`;
    const result = spawnSync(process.execPath, ['--experimental-loader', './test/schematic/commands-loader.js', '--input-type=module', '-e', program], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 2, result.stderr);
});

test('multi-agent setup fails before any shared-world operation', async () => {
    const { task, commands, goals } = fixture();
    task.data.agent_count = 2;
    await assert.rejects(task.initBotTask(), /requires one agent/);
    assert.deepEqual(commands, []);
    assert.deepEqual(goals, []);
});

test('non-schematic validation and timeout behavior remain unchanged', () => {
    const { task } = fixture();
    task.task_type = 'cooking';
    assert.equal(task.isDone().message, 'Task successful');
    task.validator = { validate: () => ({ valid: false, score: 0 }) };
    task.taskStartTime = Date.now() - 1000;
    task.taskTimeout = 1;
    assert.equal(task.isDone().message, 'Task timeout reached');
});
