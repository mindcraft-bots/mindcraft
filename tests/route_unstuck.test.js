// Resuming a routed trip after Mindcraft's unstuck mode cancels it (route_travel.resumeAfterUnstuck),
// driven through the real ActionManager the way modes.js and agent.js use it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ActionManager } from '../src/agent/action_manager.js';
import { routeOrNull, resumeAfterUnstuck, MAX_UNSTUCK_RESUMES, UNSTUCK_REPEAT_RADIUS } from '../src/agent/library/route_travel.js';
import settings from '../src/agent/settings.js';

// Topography is off by default; these tests exercise it switched on.
settings.cartography_enabled = true;

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function makeAgent({ routing = true } = {}) {
    const bot = new EventEmitter();
    Object.assign(bot, {
        username: 'Bot', health: 20, food: 20, time: { timeOfDay: 1000, isDay: true }, players: {}, output: '', interrupt_code: false,
        entity: { position: { x: 0, y: 64, z: 0 } }, game: { dimension: 'minecraft:overworld' },
        world: { getColumn: () => null },
    });
    const agent = {
        name: 'Bot', bot, messages: [],
        prompter: { profile: { topography_routing: routing } },
        self_prompter: { isActive: () => false },
        requestInterrupt() { bot.interrupt_code = true; },
        clearBotLogs() { bot.output = ''; bot.interrupt_code = false; },
        isIdle() { return !agent.actions.executing; },
        cleanKill(msg) { throw new Error(msg); },
        handleMessage(role, text) { agent.messages.push({ role, text }); },
    };
    agent.actions = new ActionManager(agent);
    return agent;
}

/** Straight plans in 40-block legs from wherever the bot is. */
function stepRoute() {
    const calls = [];
    const fn = async (agent, from, to) => {
        calls.push({ x: Math.round(from.x), z: Math.round(from.z) });
        const dx = to.x - from.x, dz = to.z - from.z;
        const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 40));
        const waypoints = [];
        for (let i = 1; i < n; i++) waypoints.push({ x: Math.round(from.x + dx * i / n), y: 70, z: Math.round(from.z + dz * i / n), kind: 'leg' });
        waypoints.push({ x: to.x, y: 70, z: to.z, kind: 'target' });
        return { status: 'complete', distance: Math.round(Math.hypot(dx, dz)), remaining: 0,
            target: { x: to.x, z: to.z, y: 70, known: true }, waypoints, bridges: [], detours: [] };
    };
    fn.calls = calls;
    return fn;
}

/**
 * Legs walk instantly, except the ones listed in `hangOn` (1-based leg numbers): those wait, like a bot
 * pressed against a wall, until something interrupts.
 */
function makeDeps({ hangOn = [] } = {}) {
    let legs = 0;
    const deps = {
        fetchRoute: stepRoute(),
        goTo: async (bot, x, y, z) => {
            legs++;
            if (hangOn.includes(legs)) {
                while (!bot.interrupt_code) await tick(5);
                return false;
            }
            Object.assign(bot.entity.position, { x, y, z });
            return true;
        },
        now: (() => { let t = 0; return () => (t += 1000); })(),
        sleep: async () => {},
        nearbyPlaces: () => [],
        settlementInside: async () => null,
        log: () => {},
    };
    deps.legs = () => legs;
    return deps;
}

const TARGET = { x: 300, y: 70, z: 0 };

/** `!goToCoordinates` as actions.js runs it (routed part only). */
function startTrip(agent, deps, target = TARGET) {
    return agent.actions.runAction('action:goToCoordinates', async () => {
        await routeOrNull(agent, { ...target }, { closeness: 2, deps });
    });
}

/** A mode taking over, as modes.js `execute` does: the interrupter's label is `mode:<name>`. */
async function runMode(agent, name, moveBy = 5) {
    return agent.actions.runAction(`mode:${name}`, async () => {
        agent.bot.entity.position.z += moveBy;   // moveAway(5)
    });
}

async function waitForHang(deps, leg) {
    while (deps.legs() < leg) await tick(5);
}

test('an unstuck interruption resumes the routed trip from the new position, without a model turn', async () => {
    const agent = makeAgent();
    const deps = makeDeps({ hangOn: [2] });
    const trip = startTrip(agent, deps);
    await waitForHang(deps, 2);
    const stuckAt = { ...agent.bot.entity.position };
    await runMode(agent, 'unstuck');
    await trip;
    assert.ok(agent.actions.resume_func, 'a resume is registered, so modes.js skips its re-prompt');
    assert.equal(agent.actions.resume_name, 'action:goToCoordinates');
    const plansBefore = deps.fetchRoute.calls.length;

    await agent.actions.resumeAction();   // agent.js does this once the agent is idle
    await tick(5);
    assert.equal(agent.actions.resume_func, null, 'one shot');
    const replan = deps.fetchRoute.calls[plansBefore];
    assert.deepEqual(replan, { x: Math.round(stuckAt.x), z: Math.round(stuckAt.z) + 5 }, 're-planned from where unstuck left the bot');
    assert.equal(agent.bot.entity.position.x, TARGET.x);
    assert.equal(agent.messages.length, 1);
    assert.match(agent.messages[0].text, /resumed automatically/);
    assert.match(agent.messages[0].text, /reached \(300, 70, 0\)/);
    assert.match(agent.messages[0].text, /resumed after getting stuck/);
});

test('!stop is unchanged: no resume', async () => {
    const agent = makeAgent();
    const deps = makeDeps({ hangOn: [2] });
    const trip = startTrip(agent, deps);
    await waitForHang(deps, 2);
    await agent.actions.stop();
    agent.actions.cancelResume();
    await trip;
    assert.equal(agent.actions.resume_func, null);
});

test('another mode (combat) is unchanged: no resume', async () => {
    const agent = makeAgent();
    const deps = makeDeps({ hangOn: [2] });
    const trip = startTrip(agent, deps);
    await waitForHang(deps, 2);
    await runMode(agent, 'self_defense');
    await trip;
    assert.equal(agent.actions.resume_func, null);
});

test('without topography routing nothing is resumed', async () => {
    const agent = makeAgent({ routing: false });
    agent.actions.interruptedBy = 'mode:unstuck';
    assert.equal(resumeAfterUnstuck(agent, TARGET), false);
    assert.equal(agent.actions.resume_func, null);
});

test(`at most ${MAX_UNSTUCK_RESUMES} resumes per trip; the next unstuck hands back to the model`, async () => {
    const agent = makeAgent();
    const deps = makeDeps({ hangOn: [2, 4, 6] });
    const trip = startTrip(agent, deps);
    for (let n = 1; n <= MAX_UNSTUCK_RESUMES + 1; n++) {
        await waitForHang(deps, 2 * n);
        // each stuck spot is far from the last one
        await runMode(agent, 'unstuck');
        if (n === 1) await trip;
        if (n <= MAX_UNSTUCK_RESUMES) {
            assert.ok(agent.actions.resume_func, `resume ${n}`);
            agent.actions.resumeAction();   // runs in the background until the next hang
            await tick(5);
        } else {
            await tick(20);
            assert.equal(agent.actions.resume_func, null, 'cap reached: stock behaviour');
        }
    }
    assert.equal(agent.messages.length, 0, 'no result text: Mindcraft re-prompts the model itself');
});

test(`stuck again within ${UNSTUCK_REPEAT_RADIUS} blocks of an earlier stuck spot hands back`, () => {
    const agent = makeAgent();
    agent.actions.interruptedBy = 'mode:unstuck';
    agent.bot.entity.position = { x: 104, y: 64, z: 3 };
    const near = { count: 1, spots: [{ x: 100, z: 0 }], overrides: {} };
    assert.equal(resumeAfterUnstuck(agent, TARGET, { resume: near }), false);
    const far = { count: 1, spots: [{ x: 60, z: 0 }], overrides: {} };
    assert.equal(resumeAfterUnstuck(agent, TARGET, { resume: far }), true);
});

test('if another action ran before the resume, it does not walk off and tells the model as stock would', async () => {
    const agent = makeAgent();
    const deps = makeDeps({ hangOn: [2] });
    const trip = startTrip(agent, deps);
    await waitForHang(deps, 2);
    await runMode(agent, 'unstuck');
    await trip;
    await agent.actions.runAction('action:collectBlocks', async () => {});
    const legs = deps.legs();
    await agent.actions.resumeAction();
    await tick(5);
    assert.equal(deps.legs(), legs, 'no travel');
    assert.equal(agent.messages.length, 1);
    assert.match(agent.messages[0].text, /interrupted by unstuck/);
});
