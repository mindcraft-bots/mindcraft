import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NPCContoller } from '../src/agent/npc/controller.js';
import { BuildGoal } from '../src/agent/npc/build_goal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeBot {
    constructor() {
        this.handlers = {};
        this.time = { timeOfDay: 1000 };
        this.interrupt_code = false;
        this.output = '';
    }

    on(event, fn) {
        (this.handlers[event] ||= []).push(fn);
    }

    emit(event, ...args) {
        for (const fn of this.handlers[event] || []) fn(...args);
    }
}

function makeAgent() {
    const bot = new FakeBot();
    const agent = {
        bot,
        isIdle: () => true,
        history: { save() {} },
        prompter: { profile: { npc: {} } },
        actions: {
            resume_func: null,
            // Never invoke fn: real skills would touch a Minecraft server.
            async runAction(label) {
                return { interrupted: false, success: true, label };
            }
        }
    };
    return agent;
}

function makeController(agent) {
    const controller = Object.create(NPCContoller.prototype);
    controller.agent = agent;
    controller.data = {
        do_routine: false,
        goals: [],
        curr_goal: { name: 'any', quantity: 1 },
        built: {},
        home: null,
        do_set_goal: false
    };
    controller.constructions = {};
    controller.temp_goals = [];
    controller.last_goals = {};
    controller.running_next = false;
    controller.currentBuilding = () => null;
    return controller;
}

async function testOverlappingExecuteNext() {
    const controller = makeController(makeAgent());
    let runs = 0;
    controller.executeGoal = async () => {
        runs++;
        await delay(30);
    };

    // Two idle events arriving before the first run finishes.
    await Promise.all([controller.executeNext(), controller.executeNext()]);
    assert.equal(runs, 1, `overlapping executeNext runs: got ${runs}, want 1`);

    // Guard must be released after completion.
    await controller.executeNext();
    assert.equal(runs, 2, `executeNext blocked after completion: got ${runs}, want 2`);
}

async function testGuardResetAfterThrow() {
    const controller = makeController(makeAgent());
    let runs = 0;
    controller.executeGoal = async () => {
        runs++;
        if (runs === 1) throw new Error('build blew up');
    };

    await assert.rejects(controller.executeNext(), /build blew up/);
    await controller.executeNext();
    assert.equal(runs, 2, `guard stuck after throw: got ${runs}, want 2`);
}

async function testIdleEventPath() {
    const agent = makeAgent();
    let idle = true;
    agent.isIdle = () => idle;
    const controller = makeController(agent);
    let runs = 0;
    controller.executeGoal = async () => {
        runs++;
        await delay(50); // keep both idle handlers inside their isIdle check
        idle = false;    // stop the self-emitted idle loop
    };
    controller.init();

    // Resume path: an active resume blocks independent NPC work.
    agent.actions.resume_func = () => {};
    agent.bot.emit('idle');
    await delay(5200);
    assert.equal(runs, 0, `resume_func did not block NPC work: got ${runs} runs`);

    // Two overlapping idle events, both past the 5 s wait.
    agent.actions.resume_func = null;
    agent.bot.emit('idle');
    agent.bot.emit('idle');
    await delay(5300);
    assert.equal(runs, 1, `overlapping idle events started ${runs} runs, want 1`);
}

async function testBuildGoalSpacing() {
    const times = [];
    const agent = makeAgent();
    agent.actions.runAction = async () => {
        times.push(Date.now());
        return { interrupted: false };
    };
    const buildGoal = new BuildGoal(agent);

    for (let i = 0; i < 6; i++) await buildGoal.wrapSkill(async () => {});

    assert.equal(times.length, 6, `got ${times.length} BuildGoal actions, want 6`);
    const gaps = times.slice(1).map((time, i) => time - times[i]);
    const minGap = Math.min(...gaps);
    console.log(`      measured gaps: ${gaps.join(', ')} ms`);
    assert.ok(minGap >= 50, `min gap between BuildGoal actions ${minGap}ms < 50ms (gaps: ${gaps.join(', ')})`);
}

async function testGoalSequencing() {
    const controller = makeController(makeAgent());
    controller.data.do_set_goal = true;
    controller.data.goals = [{ name: 'house', quantity: 1 }];
    controller.data.curr_goal = null;
    controller.constructions = { house: { blocks: [[['stone']]], offset: 0 } };

    const calls = [];
    controller.build_goal = {
        async executeNext() {
            calls.push('build');
            return {
                missing: { oak_log: 2 },
                acted: true,
                position: { x: 0, y: 0, z: 0 },
                orientation: 0
            };
        }
    };
    controller.item_goal = {
        async executeNext() {
            calls.push('item');
            return true;
        }
    };
    let setGoalCalls = 0;
    controller.setGoal = async () => { setGoalCalls++; };

    await controller.executeGoal();
    assert.deepEqual(calls, ['build'], 'one construction acted per executeGoal');
    assert.deepEqual(controller.temp_goals, [{ name: 'oak_log', quantity: 2 }], 'missing blocks queued');
    assert.equal(controller.data.home, null, 'home unchanged while blocks are missing');
    assert.equal(setGoalCalls, 0, 'setGoal skipped when an action was taken');

    controller.temp_goals = [];
    controller.data.built = {};
    controller.data.home = null;
    controller.build_goal.executeNext = async () => ({
        missing: {}, acted: false, position: { x: 0, y: 0, z: 0 }, orientation: 0
    });
    await controller.executeGoal();
    assert.equal(setGoalCalls, 1, 'setGoal called when nothing acted');
}

const tests = [
    ['overlapping executeNext', testOverlappingExecuteNext],
    ['guard reset after throw', testGuardResetAfterThrow],
    ['idle event path + resume', testIdleEventPath],
    ['BuildGoal action spacing', testBuildGoalSpacing],
    ['goal sequencing', testGoalSequencing]
];

let failed = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`PASS  ${name}`);
    } catch (err) {
        failed++;
        console.error(`FAIL  ${name}: ${err.message}`);
    }
}
if (failed) {
    console.error(`${failed}/${tests.length} regression checks failed`);
    process.exit(1);
}
console.log(`All ${tests.length} regression checks passed`);
