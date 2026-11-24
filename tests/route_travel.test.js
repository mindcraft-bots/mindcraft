import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { routedTravel, routeOrNull, shouldRoute, fetchRoute, HANDBACK, WAYPOINT_REACHED, MAX_CONSECUTIVE_FAILS } from '../src/agent/library/route_travel.js';
import settings from '../src/agent/settings.js';

// Topography is off by default; these tests exercise it switched on.
settings.cartography_enabled = true;

function makeBot({ x = 0, z = 0, loaded = false, health = 20, food = 20, time = 1000, players = {} } = {}) {
    const bot = new EventEmitter();
    Object.assign(bot, {
        username: 'Bot', health, food, time: { timeOfDay: time, isDay: time < 12542 }, players, output: '', interrupt_code: false,
        entity: { position: { x, y: 64, z } }, game: { dimension: 'minecraft:overworld' },
        world: { getColumn: () => (loaded ? {} : null) },
    });
    return bot;
}

function makeAgent(opts = {}) {
    const { profile = {}, memory = undefined, ...botOpts } = opts;
    const bot = makeBot(botOpts);
    return { name: 'Bot', bot, memory, prompter: { profile: { topography_routing: true, ...profile } } };
}

/** Plans from the bot's current position straight at the target in steps; every call is recorded. */
function stepRoute({ step = 40, ground = 70, extra = () => ({}) } = {}) {
    const calls = [];
    const fn = async (agent, from, to) => {
        calls.push({ from: { ...from }, to });
        const dx = to.x - from.x, dz = to.z - from.z;
        const dist = Math.hypot(dx, dz);
        const n = Math.max(1, Math.ceil(dist / step));
        const waypoints = [];
        for (let i = 1; i < n; i++) waypoints.push({ x: Math.round(from.x + dx * i / n), y: ground, z: Math.round(from.z + dz * i / n), kind: 'leg' });
        waypoints.push({ x: to.x, y: ground, z: to.z, kind: 'target' });
        return { status: 'complete', distance: Math.round(dist), remaining: 0, target: { x: to.x, z: to.z, y: ground, known: true },
            waypoints, bridges: [], detours: [], ...extra(calls.length, from) };
    };
    fn.calls = calls;
    return fn;
}

function makeDeps(agent, overrides = {}) {
    const goCalls = [];
    let clock = 0;
    const deps = {
        goTo: async (bot, x, y, z, closeness) => {
            goCalls.push({ x, y, z, closeness });
            bot.entity.position.x = x; bot.entity.position.z = z; bot.entity.position.y = y;
            return true;
        },
        now: () => (clock += 1000),
        sleep: async () => {},
        nearbyPlaces: () => [],
        settlementInside: async () => null,
        log: () => {},
        ...overrides,
    };
    deps.goCalls = goCalls;
    return deps;
}

const run = (agent, target, deps, opts = {}) => routedTravel(agent, target, { closeness: 2, deps, ...opts });

test('a near target with a loaded chunk uses plain pathing (no route request)', async () => {
    const agent = makeAgent({ loaded: true });
    const fetchRoute = stepRoute();
    assert.equal(shouldRoute(agent, { x: 30, y: 64, z: 0 }), false);
    const result = await run(agent, { x: 30, y: 64, z: 0 }, makeDeps(agent, { fetchRoute }));
    assert.equal(result, null);
    assert.equal(fetchRoute.calls.length, 0);
});

test('a far target (chunk not loaded) is routed, one leg per waypoint, and arrives', async () => {
    const agent = makeAgent();
    const fetchRoute = stepRoute();
    const deps = makeDeps(agent, { fetchRoute });
    const result = await run(agent, { x: 100, y: 70, z: 0 }, deps);
    assert.equal(result.status, 'ok');
    assert.match(result.text, /reached \(100, 70, 0\)/);
    assert.equal(deps.goCalls.length, 3);
    assert.deepEqual(deps.goCalls.at(-1), { x: 100, y: 70, z: 0, closeness: 2 }); // final leg: asked y and closeness
    assert.equal(deps.goCalls[0].y, 71); // intermediate legs stand on top of the ground block
    assert.equal(deps.goCalls[0].closeness, 2);
});

test('a loaded chunk but a null y still routes: the route supplies the ground y', async () => {
    const agent = makeAgent({ loaded: true });
    const fetchRoute = stepRoute({ ground: 83 });
    const deps = makeDeps(agent, { fetchRoute });
    const result = await run(agent, { x: 60, y: null, z: 0 }, deps, { closeness: 8, label: 'Oak Hollow' });
    assert.equal(result.status, 'ok');
    assert.equal(deps.goCalls.at(-1).y, 84);
    assert.equal(deps.goCalls.at(-1).closeness, 8);
    assert.match(result.text, /reached \(60, 84, 0\)/);
});

test('topography disabled (master switch or routing switch) is vanilla', async () => {
    for (const profile of [{ cartography_enabled: false }, { topography_routing: false }]) {
        const agent = makeAgent({ profile });
        const fetchRoute = stepRoute();
        assert.equal(await run(agent, { x: 400, y: 70, z: 0 }, makeDeps(agent, { fetchRoute })), null);
        assert.equal(fetchRoute.calls.length, 0);
    }
});

test('routing is on by default (no profile or settings override)', () => {
    const agent = makeAgent();
    agent.prompter.profile = {}; // no per-profile override
    assert.equal(shouldRoute(agent, { x: 400, y: null, z: 0 }), true);
});

test('the nether and unknown coordinates are not routed', async () => {
    const agent = makeAgent();
    agent.bot.game.dimension = 'minecraft:the_nether';
    assert.equal(shouldRoute(agent, { x: 400, y: null, z: 0 }), false);
    const overworld = makeAgent();
    assert.equal(shouldRoute(overworld, { x: NaN, y: 70, z: 0 }), false);
    assert.equal(shouldRoute(overworld, { x: 1, y: null, z: 1 }), false); // already there
});

test('service failure before the first leg falls back to plain pathfinding', async () => {
    const agent = makeAgent();
    const deps = makeDeps(agent, { fetchRoute: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(await run(agent, { x: 300, y: 70, z: 0 }, deps), null);
    assert.equal(deps.goCalls.length, 0);
});

test('service failure after some legs hands the rest to plain pathfinding', async () => {
    const agent = makeAgent();
    const good = stepRoute();
    let n = 0;
    const deps = makeDeps(agent, { fetchRoute: async (...a) => { if (++n > 1) throw new Error('timeout'); return good(...a); } });
    assert.equal(await run(agent, { x: 300, y: 70, z: 0 }, deps), null);
    assert.equal(deps.goCalls.length, 1);
});

test('routeOrNull swallows unexpected errors but rethrows interruptions', async () => {
    const agent = makeAgent();
    const boom = makeDeps(agent, { fetchRoute: stepRoute(), goTo: async () => { throw new TypeError('boom'); } });
    assert.equal(await routeOrNull(agent, { x: 300, y: 70, z: 0 }, { deps: boom }), null);
    const cancelled = makeDeps(agent, { fetchRoute: stepRoute(), goTo: async () => { throw Object.assign(new Error('Action cancelled'), { code: 'interrupted' }); } });
    await assert.rejects(routeOrNull(agent, { x: 300, y: 70, z: 0 }, { deps: cancelled }), /cancelled/);
});

test('replans at every waypoint so newly seen terrain feeds in', async () => {
    const agent = makeAgent();
    const fetchRoute = stepRoute({ step: 50 });
    const deps = makeDeps(agent, { fetchRoute });
    await run(agent, { x: 200, y: 70, z: 0 }, deps);
    assert.equal(fetchRoute.calls.length, deps.goCalls.length);
    assert.equal(fetchRoute.calls.length, 4);
    // each request starts where the previous leg ended
    assert.deepEqual(fetchRoute.calls.map(c => c.from.x), [0, 50, 100, 150]);
    // a plan that changes between waypoints is honoured: the second plan sends the bot elsewhere
    const agent2 = makeAgent();
    let i = 0;
    const fr = async (a, from, to) => ({ status: 'complete', distance: i === 0 ? 90 : 60, remaining: 0, target: { known: true, y: 70 }, bridges: [], detours: [],
        waypoints: i++ === 0 ? [{ x: 30, y: 70, z: 40, kind: 'bend' }, { x: 90, y: 70, z: 0, kind: 'target' }] : [{ x: 90, y: 70, z: 0, kind: 'target' }] });
    const d2 = makeDeps(agent2, { fetchRoute: fr });
    await run(agent2, { x: 90, y: 70, z: 0 }, d2);
    assert.deepEqual(d2.goCalls.map(c => [c.x, c.z]), [[30, 40], [90, 0]]);
});

test('topography_debug logs exactly one [route] end line per trip (ok and hand-back)', async () => {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try {
        const ok = makeAgent({ profile: { topography_debug: true } });
        await run(ok, { x: 100, y: 70, z: 0 }, makeDeps(ok, { fetchRoute: stepRoute() }));
        const hb = makeAgent({ profile: { topography_debug: true }, health: HANDBACK.lowHealth });
        await run(hb, { x: 300, y: 70, z: 0 }, makeDeps(hb, { fetchRoute: stepRoute() }));
        const quiet = makeAgent();
        await run(quiet, { x: 100, y: 70, z: 0 }, makeDeps(quiet, { fetchRoute: stepRoute() }));
    } finally { console.log = orig; }
    const ends = lines.filter(l => l.startsWith('[route] end '));
    assert.equal(ends.length, 2);
    assert.match(ends[0], /^\[route\] end status=ok code=- legs=3 walked=\d+$/);
    assert.match(ends[1], /^\[route\] end status=partial code=handback legs=\d+ walked=\d+$/);
});

// ---- hand-back ----
async function handBackScenario(agentOpts, depsFn, plan) {
    const agent = makeAgent(agentOpts);
    const fetchRoute = plan ?? stepRoute();
    const deps = makeDeps(agent, { fetchRoute, ...(depsFn?.(agent) ?? {}) });
    const result = await run(agent, { x: 300, y: 70, z: 0 }, deps);
    return { result, agent, deps };
}

function assertHandBack(result, code, textRe) {
    assert.equal(result.code, code);
    assert.match(result.text, textRe);
    assert.match(result.text, /To resume, call !goToCoordinates\(300, 70, 0, 2\)/);
    assert.match(result.text, /Trip so far:/);
}

test('hand back: damage during a leg', async () => {
    const { result, deps } = await handBackScenario({}, agent => ({
        goTo: async (bot, x, y, z) => { bot.entity.position.x = x; bot.entity.position.z = z; bot.health = 16; return true; },
    }));
    assert.equal(result.status, 'partial');
    assertHandBack(result, 'handback', /you took damage \(health 16\/20\)/);
});

test('hand back: low health and low food (once per trip, then the trip can continue)', async () => {
    let r = await handBackScenario({ health: HANDBACK.lowHealth });
    assertHandBack(r.result, 'handback', /health is low/);
    r = await handBackScenario({ food: HANDBACK.lowFood });
    assertHandBack(r.result, 'handback', /hungry/);
});

test('hand back: a player is nearby, once', async () => {
    const players = { Alex: { entity: { position: { x: 40, y: 64, z: 5 } } }, Bot: { entity: { position: { x: 0, y: 64, z: 0 } } } };
    const { result } = await handBackScenario({ players });
    assertHandBack(result, 'handback', /Alex is nearby/);
});

test('hand back: someone speaks to the bot mid-trip', async () => {
    const { result } = await handBackScenario({}, agent => ({
        goTo: async (bot, x, y, z) => { bot.entity.position.x = x; bot.entity.position.z = z; bot.emit('chat', 'Alex', 'hey'); return true; },
    }));
    assertHandBack(result, 'handback', /Alex spoke to you/);
});

test('hand back: entering a known place not recently visited; a recently visited one is skipped', async () => {
    const old = [{ name: 'Oak Hollow', x: 40, z: 0, visited: true, lastVisitTs: 1 }];
    let r = await handBackScenario({}, () => ({ nearbyPlaces: () => old, now: () => 10 * 3600 * 1000 }));
    assertHandBack(r.result, 'handback', /entering Oak Hollow/);
    const fresh = [{ name: 'Oak Hollow', x: 40, z: 0, visited: true, lastVisitTs: 9.9 * 3600 * 1000 }];
    r = await handBackScenario({}, () => ({ nearbyPlaces: () => fresh, now: () => 10 * 3600 * 1000 }));
    assert.equal(r.result.status, 'ok');
    const bridgePlace = [{ name: 'bridge near (10,0)', x: 40, z: 0, visited: false, lastVisitTs: null }];
    r = await handBackScenario({}, () => ({ nearbyPlaces: () => bridgePlace }));
    assert.equal(r.result.status, 'ok'); // a bridge we recorded ourselves never stops the trip
});

test('hand back: entering a settlement', async () => {
    const { result } = await handBackScenario({}, () => ({
        settlementInside: async () => ({ id: 's1', kind: 'settlement', building_count: 14, center: { x: 40, z: 0 } }),
    }));
    assertHandBack(result, 'handback', /entering a settlement of about 14 buildings/);
});

test('hand back: night on a long trip, but not on a short one', async () => {
    let r = await handBackScenario({ time: 14000 });
    assertHandBack(r.result, 'handback', /night has fallen/);
    const agent = makeAgent({ time: 14000 });
    const result = await run(agent, { x: 100, y: 70, z: 0 }, makeDeps(agent, { fetchRoute: stepRoute() }));
    assert.equal(result.status, 'ok');
});

test('hand back: a substantial reroute', async () => {
    let n = 0;
    const base = stepRoute();
    const fetchRoute = async (...a) => { const p = await base(...a); return ++n === 2 ? { ...p, distance: 600 } : p; };
    const { result } = await handBackScenario({}, null, fetchRoute);
    assertHandBack(result, 'rerouted', /substantially longer route \(now about 600 blocks/);
});

test('a partial first plan followed by a much longer complete plan does not hand back as rerouted', async () => {
    let n = 0;
    const base = stepRoute();
    const fetchRoute = async (...a) => {
        const p = await base(...a);
        n++;
        if (n === 1) return { ...p, status: 'partial', blocked_by: 'water', distance: 165, remaining: 140 };
        if (n === 2) return { ...p, distance: 381 };
        return p;
    };
    const { result } = await handBackScenario({}, null, fetchRoute);
    assert.notEqual(result?.code, 'rerouted');
});

test('a complete plan followed by a much longer one still hands back as rerouted', async () => {
    let n = 0;
    const base = stepRoute();
    const fetchRoute = async (...a) => { const p = await base(...a); return ++n === 3 ? { ...p, distance: 700 } : p; };
    const { result } = await handBackScenario({}, null, fetchRoute);
    assertHandBack(result, 'rerouted', /substantially longer route/);
});

test('a loaded target at or beyond NEAR_DISTANCE is routed; a loaded target under it is not', () => {
    const agent = makeAgent({ loaded: true });
    assert.equal(shouldRoute(agent, { x: 275, y: 64, z: 0 }), true);
    assert.equal(shouldRoute(agent, { x: 96, y: 64, z: 0 }), true);
    assert.equal(shouldRoute(agent, { x: 95, y: 64, z: 0 }), false);
});

test('hand back: route blocked (plan blocked, and a pathfinder that cannot make progress)', async () => {
    let r = await handBackScenario({}, null, async () => ({ status: 'blocked', reason: 'start_unexplored', waypoints: [], bridges: [], detours: [] }));
    assert.equal(r.result.status, 'blocked');
    assertHandBack(r.result, 'route_blocked', /no data for where you stand/);

    r = await handBackScenario({}, () => ({ goTo: async () => false }));
    assert.equal(r.result.status, 'blocked');
    assertHandBack(r.result, 'route_blocked', /could not get from here to the next waypoint/);
    assert.equal(r.deps.goCalls.length, 0); // (the stub above does not record) ...
});

test('a pathfinder that fails twice without moving stops the trip after MAX_CONSECUTIVE_FAILS tries', async () => {
    const agent = makeAgent();
    const calls = [];
    const deps = makeDeps(agent, { fetchRoute: stepRoute(), goTo: async (...a) => { calls.push(a); return false; } });
    const result = await run(agent, { x: 300, y: 70, z: 0 }, deps);
    assert.equal(result.code, 'route_blocked');
    assert.equal(calls.length, MAX_CONSECUTIVE_FAILS);
});

test('hand back: the edge of the explored map (frontier), after waiting for new chunks', async () => {
    const agent = makeAgent();
    let sleeps = 0;
    const fetchRoute = async (a, from) => ({ status: 'partial', reason: 'unexplored', distance: 40, remaining: 260, target: { known: false, y: null }, bridges: [], detours: [],
        waypoints: [{ x: 40, y: 70, z: 0, kind: 'frontier' }] });
    const deps = makeDeps(agent, { fetchRoute, sleep: async () => { sleeps++; } });
    const result = await run(agent, { x: 300, y: 70, z: 0 }, deps);
    assert.equal(result.code, 'frontier');
    assert.match(result.text, /edge of the explored map/);
    assert.match(result.text, /unexplored country|have not seen/);
    assert.ok(sleeps >= 1);
});

test('arrival is not a hand-back and logs the trip as an experience', async () => {
    const logged = [];
    const memory = { enabled: true, logExperience: t => logged.push(t), lookup: () => null, rememberHere: () => {} };
    const agent = makeAgent({ memory });
    const result = await run(agent, { x: 100, y: 70, z: 0 }, makeDeps(agent, { fetchRoute: stepRoute() }));
    assert.equal(result.status, 'ok');
    assert.equal(logged.length, 1);
    assert.match(logged[0], /walked to \(100,0\)/);
});

// ---- interruption ----
test('an interrupt set during a leg stops before any further route request', async () => {
    const agent = makeAgent();
    const fetchRoute = stepRoute();
    const deps = makeDeps(agent, { fetchRoute });
    const go = deps.goTo;
    deps.goTo = async (...a) => { const ok = await go(...a); agent.bot.interrupt_code = true; return ok; };
    const result = await run(agent, { x: 300, y: 70, z: 0 }, deps);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.code, 'interrupted');
    assert.equal(deps.goCalls.length, 1);
    assert.equal(fetchRoute.calls.length, 1);
    assert.equal(agent.bot.output, ''); // an interrupted action reports nothing on develop
});

// ---- trip report and bridges ----
const bridge = { id: 'b1', a: { x: 40, y: 65, z: 0 }, b: { x: 80, y: 65, z: 0 }, length: 41, width: 3, deck_y: 65 };
function bridgePlan({ detours = [{ around: 'water', cells: 6 }] } = {}) {
    return async () => ({
        status: 'complete', distance: 120, remaining: 0, target: { known: true, y: 64 }, bridges: [bridge], detours,
        waypoints: [
            { x: 30, y: 64, z: 0, kind: 'path', note: 'joins a path' },
            { x: 40, y: 65, z: 0, kind: 'bridge_start', bridge: 'b1' },
            { x: 60, y: 65, z: 0, kind: 'bridge_deck', bridge: 'b1' },
            { x: 80, y: 65, z: 0, kind: 'bridge_end', bridge: 'b1' },
            { x: 120, y: 64, z: 0, kind: 'target' },
        ],
    });
}

test('trip report names what the route did', async () => {
    const agent = makeAgent();
    let call = 0;
    // replans: serve the remaining waypoints each time
    const plan = bridgePlan();
    const fetchRoute = async (a, from) => {
        const full = await plan();
        call++;
        return { ...full, waypoints: full.waypoints.filter(w => w.x > from.x + WAYPOINT_REACHED || w.kind === 'target') };
    };
    const result = await run(agent, { x: 120, y: 64, z: 0 }, makeDeps(agent, { fetchRoute }));
    assert.equal(result.status, 'ok');
    assert.match(result.text, /went around the water/);
    assert.match(result.text, /followed a path/);
    assert.match(result.text, /crossed the bridge \(41 blocks\)/);
});

function bridgeRun({ failOnDeck = false, stopAfter = Infinity } = {}) {
    const rememberHere = [];
    const memory = { enabled: true, logExperience: () => {}, lookup: () => null, rememberHere: (...a) => rememberHere.push(a) };
    const agent = makeAgent({ memory });
    const plan = bridgePlan();
    const fetchRoute = async (a, from) => {
        const full = await plan();
        return { ...full, waypoints: full.waypoints.filter(w => w.x > from.x + WAYPOINT_REACHED || w.kind === 'target') };
    };
    let legs = 0;
    const deps = makeDeps(agent, { fetchRoute });
    const go = deps.goTo;
    deps.goTo = async (bot, x, y, z, c) => {
        legs++;
        if (failOnDeck && x === 60) return false; // the pathfinder cannot walk the deck
        if (legs > stopAfter) { bot.interrupt_code = true; }
        return await go(bot, x, y, z, c);
    };
    return { agent, deps, rememberHere };
}

test('a bridge is recorded as an observed place only when walked end to end', async () => {
    const { agent, deps, rememberHere } = bridgeRun();
    const result = await run(agent, { x: 120, y: 64, z: 0 }, deps);
    assert.equal(result.status, 'ok');
    assert.equal(rememberHere.length, 1);
    assert.equal(rememberHere[0][0], 'bridge near (60,0)');
    assert.equal(rememberHere[0][2], 65); // deck height
});

test('a bridge only seen on a plan, or walked partway, is never recorded', async () => {
    // stopped on the deck: entered at the near end but never reached the far end
    let r = bridgeRun({ stopAfter: 2 });
    let result = await run(r.agent, { x: 120, y: 64, z: 0 }, r.deps);
    assert.equal(result.code, 'interrupted');
    assert.equal(r.rememberHere.length, 0);
    // the deck leg fails: not crossed
    r = bridgeRun({ failOnDeck: true });
    result = await run(r.agent, { x: 120, y: 64, z: 0 }, r.deps);
    assert.equal(result.status, 'blocked');
    assert.equal(r.rememberHere.length, 0);
    // a plan that lists the bridge but a trip that hands back before reaching it
    const rememberHere = [];
    const agent = makeAgent({ memory: { enabled: true, logExperience: () => {}, lookup: () => null, rememberHere: (...a) => rememberHere.push(a) }, health: 5 });
    result = await run(agent, { x: 120, y: 64, z: 0 }, makeDeps(agent, { fetchRoute: bridgePlan() }));
    assert.equal(result.code, 'handback');
    assert.equal(rememberHere.length, 0);
});

test('a bridge already in memory is not recorded twice', async () => {
    const rememberHere = [];
    const memory = { enabled: true, logExperience: () => {}, lookup: name => ({ x: 60 }), rememberHere: (...a) => rememberHere.push(a) };
    const agent = makeAgent({ memory });
    const plan = bridgePlan();
    const fetchRoute = async (a, from) => { const full = await plan(); return { ...full, waypoints: full.waypoints.filter(w => w.x > from.x + 3 || w.kind === 'target') }; };
    const result = await run(agent, { x: 120, y: 64, z: 0 }, makeDeps(agent, { fetchRoute }));
    assert.equal(result.status, 'ok');
    assert.equal(rememberHere.length, 0);
    assert.match(result.text, /crossed the bridge/);
});

test('memory off or absent is a no-op', async () => {
    for (const memory of [undefined, null, { enabled: false }]) {
        const agent = makeAgent({ memory });
        const plan = bridgePlan();
        const fetchRoute = async (a, from) => { const full = await plan(); return { ...full, waypoints: full.waypoints.filter(w => w.x > from.x + 3 || w.kind === 'target') }; };
        const result = await run(agent, { x: 120, y: 64, z: 0 }, makeDeps(agent, { fetchRoute }));
        assert.equal(result.status, 'ok');
        assert.match(result.text, /crossed the bridge/);
    }
});

test('the commands are registered and wired to the router', async () => {
    const { getCommand } = await import('../src/agent/commands/index.js');
    assert.ok(getCommand('!goToCoordinates'));
    assert.ok(getCommand('!goToRememberedPlace'));
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('../src/agent/commands/actions.js', import.meta.url), 'utf8');
    assert.equal((source.match(/routeOrNull\(/g) ?? []).length, 2);
});

// ---- shore-following ----
function shorePlan(from, { side = 'left', end = 'step', dx = 40, dz = 0, distance = 40 } = {}) {
    return {
        status: 'partial', reason: 'water', blocked_by: 'water', distance, remaining: 300,
        target: { known: false, y: null }, bridges: [], detours: [],
        waypoints: [{ x: from.x + dx, y: 70, z: from.z + dz, kind: 'shore_follow' }],
        shore: { side, cells: 16, length: 64, end },
    };
}

function completePlan(to, ground = 70) {
    return {
        status: 'complete', distance: 1, remaining: 0, target: { x: to.x, z: to.z, y: ground, known: true },
        bridges: [], detours: [], waypoints: [{ x: to.x, y: ground, z: to.z, kind: 'target' }],
    };
}

test('fetchRoute sends shore and shore_from', async () => {
    const agent = makeAgent();
    const urls = [];
    const fetchImpl = async url => {
        urls.push(String(url));
        return { ok: true, json: async () => completePlan({ x: 100, z: 0 }) };
    };
    await fetchRoute(agent, { x: 0, z: 0 }, { x: 100, z: 0 }, { fetchImpl, shore: 'left', shoreFrom: 120 });
    assert.match(urls[0], /shore=left/);
    assert.match(urls[0], /shore_from=120/);
});

test('shore parameters: auto first, then the chosen side, then the remembered side without shore_from', async () => {
    const agent = makeAgent();
    const calls = [];
    let n = 0;
    const fetchRoute = async (a, from, to, opts = {}) => {
        calls.push({ from: { ...from }, opts: { ...opts } });
        n++;
        if (n === 1) return shorePlan(from);
        if (n === 2) return { ...completePlan({ x: 300, z: 0 }), status: 'partial', waypoints: [{ x: from.x + 40, y: 70, z: 0, kind: 'bend' }] };
        return completePlan({ x: 300, z: 0 });
    };
    const result = await run(agent, { x: 300, y: 70, z: 0 }, makeDeps(agent, { fetchRoute }));
    assert.equal(result.status, 'ok');
    assert.equal(calls[0].opts.shore, 'auto');
    assert.equal(calls[0].opts.shoreFrom, undefined);
    assert.equal(calls[1].opts.shore, 'left');
    assert.equal(calls[1].opts.shoreFrom, 300);
    assert.equal(calls[2].opts.shore, 'left');   // once chosen, auto is never sent again
    assert.equal(calls[2].opts.shoreFrom, undefined);
});

test('150 blocks of shore without progress flips the side once and says so', async () => {
    const agent = makeAgent();
    const opts = [];
    let n = 0;
    const fetchRoute = async (a, from, to, o = {}) => {
        opts.push({ ...o });
        n++;
        if (n <= 5) return shorePlan(from, { side: o.shore === 'right' ? 'right' : 'left', dx: 0, dz: 40 });
        return completePlan({ x: 300, z: 0 });
    };
    const result = await run(agent, { x: 300, y: 70, z: 0 }, makeDeps(agent, { fetchRoute }));
    assert.equal(result.status, 'ok');
    assert.match(result.text, /turned back to try the other way along the shore/);
    assert.equal(opts[0].shore, 'auto');
    assert.equal(opts[4].shore, 'right');        // flipped after 4 legs (160 blocks)
});

test('both sides spent: an honest water_blocked stop names the blocks walked', async () => {
    const agent = makeAgent();
    const fetchRoute = async (a, from, to, o = {}) =>
        shorePlan(from, { side: o.shore === 'right' ? 'right' : 'left', dx: 0, dz: 40 });
    const result = await run(agent, { x: 300, y: 70, z: 0 }, makeDeps(agent, { fetchRoute }));
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'water_blocked');
    assert.match(result.text, /water blocks the way; followed the shore both ways for 320 blocks/);
});

test('8+ blocks of real progress resets the side budget', async () => {
    const agent = makeAgent();
    const fetchRoute = async (a, from, to) => from.x >= 360
        ? completePlan({ x: 400, z: 0 })
        : shorePlan(from, { dx: 40, dz: 0 });
    const deps = makeDeps(agent, { fetchRoute });
    const result = await run(agent, { x: 400, y: 70, z: 0 }, deps);
    assert.equal(result.status, 'ok');
    assert.doesNotMatch(result.text, /turned back/);
    assert.equal(deps.goCalls.length, 10);
});

test('shoreTotal reaching 600 stops even while making progress', async () => {
    const agent = makeAgent();
    let legs = 0;
    const fetchRoute = async (a, from) => {
        legs++;
        return shorePlan(from, { dx: 40, dz: 0 });
    };
    const deps = makeDeps(agent, { fetchRoute });
    const result = await run(agent, { x: 2000, y: 70, z: 0 }, deps);
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'water_blocked');
    assert.match(result.text, /for 600 blocks/);
    assert.equal(deps.goCalls.length, 15);
    assert.equal(legs, 15);
});

test('a shore plan does not trigger the substantial-reroute hand-back', async () => {
    const agent = makeAgent();
    let n = 0;
    const fetchRoute = async (a, from, to) => {
        n++;
        if (n === 1) return { ...completePlan({ x: 300, z: 0 }), status: 'partial', distance: 100, remaining: 200, waypoints: [{ x: from.x + 40, y: 70, z: 0, kind: 'bend' }] };
        if (n === 2) return shorePlan(from, { distance: 600 });
        return completePlan({ x: 300, z: 0 });
    };
    const result = await run(agent, { x: 300, y: 70, z: 0 }, makeDeps(agent, { fetchRoute }));
    assert.equal(result.status, 'ok');
});

test('an interrupt during a shore leg stops before any further request', async () => {
    const agent = makeAgent();
    const fetchRoute = async (a, from) => shorePlan(from, { dz: 40 });
    let calls = 0;
    const deps = makeDeps(agent, {
        fetchRoute: async (...a) => { calls++; return fetchRoute(...a); },
        goTo: async (bot, x, y, z) => { bot.entity.position.x = x; bot.entity.position.z = z; agent.bot.interrupt_code = true; return true; },
    });
    const result = await run(agent, { x: 300, y: 70, z: 0 }, deps);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.code, 'interrupted');
    assert.equal(calls, 1);
});

test('a stalled shore leg is ended, then the shore is traced', async () => {
    const agent = makeAgent();
    let n = 0;
    const fetchRoute = async (a, from, to) => {
        n++;
        if (n === 1) return { ...completePlan({ x: 300, z: 0 }), status: 'partial', waypoints: [{ x: from.x, y: 70, z: from.z + 40, kind: 'shore' }] };
        if (n === 2) return shorePlan(from, { dx: 40, dz: 0, side: 'left' });
        return completePlan({ x: 300, z: 0 });
    };
    let legs = 0;
    const deps = makeDeps(agent, {
        fetchRoute,
        legTimeoutMs: 10,
        goTo: async (bot, x, y, z) => {
            legs++;
            if (legs === 1) return new Promise(() => {});   // the pathfinder stalls at the water's edge
            bot.entity.position.x = x; bot.entity.position.z = z;
            return true;
        },
    });
    const result = await run(agent, { x: 300, y: 70, z: 0 }, deps);
    assert.equal(result.status, 'ok');
    assert.ok(legs >= 3, `legs ${legs}`);
    assert.match(result.text, /followed the shoreline/);
});

