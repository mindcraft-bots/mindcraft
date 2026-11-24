import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  clearSchematicObstructions,
  captureSchematicAttemptIdentity,
  inspectSchematicObstructions,
  isKnownNaturalObstructionName,
  isSafeNaturalObstruction,
  withSchematicDestructionGuards,
} from "../../src/utils/schematic/obstruction_policy.js";
import { trackBotWorldLifecycle } from "../../src/utils/schematic/world_lifecycle.js";

const require = createRequire(import.meta.url);
const minecraftData = require("minecraft-data");
const mineflayerHealth = require("mineflayer/lib/plugins/health.js");
const Block = require("prismarine-block")("1.20.4");

class Vec3 {
  constructor(x, y, z) { Object.assign(this, { x, y, z }); }
}

const key = ({ x, y, z }) => `${x},${y},${z}`;
const buildOf = (cells) => ({ cells, dimensions: { width: cells.length, height: 1, length: 1 } });
const air = () => ({ name: "air", diggable: false, getProperties: () => ({}) });
const block = (name, position, extra = {}) => ({
  name,
  position: new Vec3(position.x, position.y, position.z),
  diggable: true,
  getProperties: () => ({}),
  ...extra,
});

test("read-only inspection scans the full volume without approving or clearing obstructions", () => {
  const cells = [0, 1, 2].map(x => ({ position: { x, y: 0, z: 0 }, name: "air", properties: {} }));
  const { bot, build, removed } = fixture(cells, new Map([
    ["0,0,0", block("poppy", cells[0].position)],
    ["1,0,0", block("birch_leaves", cells[1].position)],
  ]));
  const approved = new Map([["existing", { name: "sentinel" }]]);
  build.approvedObstructions = approved;
  const originalBlockAt = bot.blockAt.bind(bot);
  const visited = [];
  bot.blockAt = position => { visited.push(key(position)); return originalBlockAt(position); };
  assert.throws(() => inspectSchematicObstructions(bot, build, { Vec3Class: Vec3 }), /birch_leaves.*allowlist/);
  assert.deepEqual(visited, ["0,0,0", "1,0,0", "2,0,0"]);
  assert.equal(build.approvedObstructions, approved);
  assert.deepEqual(removed, []);
});

function fixture(cells, blocks) {
  const removed = [];
  const bot = Object.assign(new EventEmitter(), {
    version: "1.20.4",
    registry: minecraftData("1.20.4"),
    game: { dimension: "overworld" },
    world: {},
    _client: Object.assign(new EventEmitter(), { ended: false, socket: { destroyed: false } }),
    interrupt_code: false,
    entity: { position: { distanceTo: () => 0 } },
    blockAt(position) { return blocks.get(key(position)) ?? air(); },
    async dig(target) { removed.push(key(target.position)); blocks.set(key(target.position), air()); },
    async placeBlock() {},
  });
  return { bot, blocks, removed, build: buildOf(cells) };
}

test("clears foliage obstructions for target-solid and intended-air cells only within the volume", async () => {
  const cells = [
    { position: { x: 0, y: 4, z: 0 }, name: "stone", properties: {} },
    { position: { x: 1, y: 4, z: 0 }, name: "air", properties: {} },
    { position: { x: 2, y: 4, z: 0 }, name: "oak_planks", properties: {} },
  ];
  const blocks = new Map([
    ["0,4,0", block("poppy", cells[0].position)],
    ["1,4,0", block("allium", cells[1].position)],
    ["2,4,0", block("oak_planks", cells[2].position)],
    ["3,4,0", block("poppy", { x: 3, y: 4, z: 0 })],
  ]);
  const { bot, removed } = fixture(cells, blocks);

  const result = await clearSchematicObstructions(bot, buildOf(cells), { Vec3Class: Vec3 });
  assert.deepEqual(result, { cleared: 2 });
  assert.deepEqual(removed, ["0,4,0", "1,4,0"]);
  assert.equal(blocks.get("2,4,0").name, "oak_planks", "already-correct player construction is preserved");
  assert.equal(blocks.get("3,4,0").name, "poppy", "outside-volume foliage is untouched");
});

test("a successful guarded clearing scan visits every cell before the first dig", async () => {
  const cells = [0, 1, 2].map(x => ({ position: { x, y: 0, z: 0 }, name: "air", properties: {} }));
  const candidate = fixture(cells, new Map([["0,0,0", block("poppy", cells[0].position)]]));
  const visited = new Set();
  const originalBlockAt = candidate.bot.blockAt.bind(candidate.bot);
  const originalDig = candidate.bot.dig.bind(candidate.bot);
  candidate.bot.blockAt = position => { visited.add(key(position)); return originalBlockAt(position); };
  candidate.bot.dig = target => {
    assert.deepEqual([...visited].sort(), ["0,0,0", "1,0,0", "2,0,0"]);
    return originalDig(target);
  };
  assert.deepEqual(await clearSchematicObstructions(candidate.bot, candidate.build, { Vec3Class: Vec3 }), { cleared: 1 });
});

test("preflight refuses containers, valuables, and player-built materials without digging", async () => {
  for (const name of ["chest", "diamond_ore", "oak_planks", "oak_log", "stone_bricks"]) {
    const position = { x: 1, y: 2, z: 3 };
    const { bot, removed } = fixture(
      [{ position, name: "air", properties: {} }],
      new Map([[key(position), block(name, position)]]),
    );
    await assert.rejects(
      clearSchematicObstructions(bot, buildOf([{ position, name: "air", properties: {} }]), { Vec3Class: Vec3 }),
      new RegExp(`${name}.*protected|${name}.*allowlist`, "i"),
    );
    assert.deepEqual(removed, [], `${name} must remain untouched`);
  }

  const leaf = { x: 0, y: 0, z: 0 };
  const chest = { x: 1, y: 0, z: 0 };
  const mixed = fixture(
    [
      { position: leaf, name: "air", properties: {} },
      { position: chest, name: "air", properties: {} },
    ],
    new Map([[key(leaf), block("poppy", leaf)], [key(chest), block("chest", chest)]]),
  );
  await assert.rejects(clearSchematicObstructions(mixed.bot, mixed.build, { Vec3Class: Vec3 }), /chest.*protected/i);
  assert.deepEqual(mixed.removed, [], "preflight must discover protected cells before removing an earlier candidate");
});

test("allowlist uses actual vanilla registry singleton names and excludes dependent plants", async () => {
  const registryNames = new Set(Object.keys(minecraftData("1.20.4").blocksByName));
  for (const name of ["poppy", "allium", "wheat", "carrots"]) {
    assert.equal(registryNames.has(name), true, `${name} is an actual registry block`);
    assert.equal(isKnownNaturalObstructionName(name, "1.20.4"), true, `${name} is a supported singleton`);
    const position = { x: 0, y: 0, z: 0 };
    const candidate = fixture(
      [{ position, name: "air", properties: {} }],
      new Map([[key(position), block(name, position)]]),
    );
    assert.deepEqual(await clearSchematicObstructions(candidate.bot, candidate.build, { Vec3Class: Vec3 }), { cleared: 1 });
  }
  for (const name of ["oak_leaves", "bamboo", "vine", "tall_grass", "large_fern", "sunflower", "sugar_cane", "kelp", "tall_seagrass", "big_dripleaf", "pitcher_plant"]) {
    if (!registryNames.has(name)) continue;
    assert.equal(isKnownNaturalObstructionName(name, "1.20.4"), false, `${name} is dependent or multi-block`);
    const position = { x: 0, y: 0, z: 0 };
    const candidate = fixture(
      [{ position, name: "air", properties: {} }],
      new Map([[key(position), block(name, position)]]),
    );
    await assert.rejects(clearSchematicObstructions(candidate.bot, candidate.build, { Vec3Class: Vec3 }));
    assert.deepEqual(candidate.removed, []);
  }
  for (const name of ["chest", "stone", "diamond_ore"]) {
    assert.equal(registryNames.has(name), true);
    assert.equal(isKnownNaturalObstructionName(name, "1.20.4"), false, `${name} remains protected`);
  }
});

test("real Mineflayer respawn packet invalidates a same-dimension named-world attempt before digging", async () => {
  const position = { x: 0, y: 0, z: 0 };
  const candidate = fixture(
    [{ position, name: "air", properties: {} }],
    new Map([[key(position), block("poppy", position)]]),
  );
  const world = candidate.bot.world;
  const entity = candidate.bot.entity;
  let namedWorld = "minecraft:overworld";
  trackBotWorldLifecycle(candidate.bot);
  mineflayerHealth(candidate.bot, { respawn: false });
  const attemptIdentity = captureSchematicAttemptIdentity(candidate.bot);
  namedWorld = "minecraft:overworld_copy";
  candidate.bot._client.emit("respawn", {
    worldState: { dimension: "minecraft:overworld", name: namedWorld },
    copyMetadata: true,
  });
  assert.equal(candidate.bot.game.dimension, "overworld");
  assert.equal(candidate.bot.world, world, "the reproduction retains the same world object");
  assert.equal(candidate.bot.entity, entity, "the reproduction retains the same entity object");
  assert.equal(namedWorld, "minecraft:overworld_copy");
  await assert.rejects(clearSchematicObstructions(candidate.bot, candidate.build, {
    Vec3Class: Vec3,
    attemptIdentity,
  }), /identity changed/);
  assert.deepEqual(candidate.removed, []);
});

test("world lifecycle listeners are installed once and removed after disconnect", async () => {
  const { bot } = fixture([], new Map());
  const baseline = {
    clientRespawn: bot._client.listenerCount("respawn"),
    death: bot.listenerCount("death"),
    end: bot.listenerCount("end"),
    kicked: bot.listenerCount("kicked"),
    disconnect: bot.listenerCount("disconnect"),
    world: bot.listenerCount("world"),
  };
  trackBotWorldLifecycle(bot);
  trackBotWorldLifecycle(bot);
  assert.equal(bot._client.listenerCount("respawn"), baseline.clientRespawn + 1);
  assert.equal(bot.listenerCount("death"), baseline.death + 1);
  bot._client.emit("respawn", { worldState: { name: "minecraft:overworld_copy" } });
  bot.emit("end", "test disconnect");
  assert.equal(bot._client.listenerCount("respawn"), baseline.clientRespawn);
  assert.equal(bot.listenerCount("death"), baseline.death);
  assert.equal(bot.listenerCount("end"), baseline.end);
  assert.equal(bot.listenerCount("kicked"), baseline.kicked);
  assert.equal(bot.listenerCount("disconnect"), baseline.disconnect);
  assert.equal(bot.listenerCount("world"), baseline.world);
});

test("waterlogged mangrove propagule states fail full preflight and immediate recheck", async () => {
  const position = { x: 0, y: 0, z: 0 };
  const waterloggedState = Block.fromProperties("mangrove_propagule", {
    age: 0,
    hanging: false,
    stage: 0,
    waterlogged: true,
  });
  const properties = waterloggedState.getProperties();
  assert.equal(properties.waterlogged, true, "state comes from the real Minecraft block registry");
  assert.equal(isSafeNaturalObstruction({ name: "mangrove_propagule", properties }, "1.20.4"), false);

  const candidate = fixture(
    [{ position, name: "stone", properties: {} }],
    new Map([[key(position), block("mangrove_propagule", position, { getProperties: () => properties })]]),
  );
  await assert.rejects(clearSchematicObstructions(candidate.bot, candidate.build, { Vec3Class: Vec3 }), /fluid/);
  assert.deepEqual(candidate.removed, [], "fluid-bearing obstruction is rejected before any dig");

  const race = fixture(
    [{ position, name: "stone", properties: {} }],
    new Map([[key(position), block("mangrove_propagule", position, {
      getProperties: () => ({ ...properties, waterlogged: false }),
    })]]),
  );
  let reads = 0;
  const originalBlockAt = race.bot.blockAt.bind(race.bot);
  race.bot.blockAt = (at) => {
    reads++;
    const found = originalBlockAt(at);
    if (reads > 1) return block("mangrove_propagule", at, { getProperties: () => properties });
    return found;
  };
  await assert.rejects(clearSchematicObstructions(race.bot, race.build, { Vec3Class: Vec3 }), /changed after preflight|fluid/);
  assert.deepEqual(race.removed, []);
});

test("multi-block physics dependencies are refused whether both halves are inside or cross the boundary", async () => {
  const physicsWorld = (insidePositions, plantName) => {
    const blocks = new Map(insidePositions.map((position) => [key(position), block(plantName, position)]));
    const cells = insidePositions.map((position) => ({ position, name: "air", properties: {} }));
    const candidate = fixture(cells, blocks);
    // Model vanilla dependent-block physics: digging either half removes its
    // companion, including a companion outside the declared schematic volume.
    candidate.bot.dig = async (target) => {
      candidate.removed.push(key(target.position));
      blocks.delete(key(target.position));
      const companion = { x: target.position.x, y: target.position.y + 1, z: target.position.z };
      if (blocks.has(key(companion))) {
        candidate.removed.push(key(companion));
        blocks.delete(key(companion));
      }
    };
    return candidate;
  };

  for (const positions of [
    [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
    [{ x: 0, y: 0, z: 0 }],
  ]) {
    const candidate = physicsWorld(positions, "sunflower");
    candidate.build.dimensions = positions.length === 2
      ? { width: 1, height: 2, length: 1 }
      : { width: 1, height: 1, length: 1 };
    if (positions.length === 1) {
      candidate.blocks.set("0,1,0", block("sunflower", { x: 0, y: 1, z: 0 }));
    }
    await assert.rejects(clearSchematicObstructions(candidate.bot, candidate.build, { Vec3Class: Vec3 }));
    assert.deepEqual(candidate.removed, [], "reject before physics can remove any part");
  }
});

test("TOCTOU changes are re-read immediately before dig and cancellation is honored", async () => {
  const position = { x: 0, y: 0, z: 0 };
  const cells = [{ position, name: "stone", properties: {} }];
  const blocks = new Map([[key(position), block("poppy", position)]]);
  let reads = 0;
  const { bot, removed } = fixture(cells, blocks);
  const originalRead = bot.blockAt;
  bot.blockAt = (pos) => {
    reads++;
    if (reads === 2) blocks.set(key(pos), block("chest", pos));
    return originalRead(pos);
  };
  await assert.rejects(clearSchematicObstructions(bot, buildOf(cells), { Vec3Class: Vec3 }), /changed after preflight/);
  assert.deepEqual(removed, []);

  const cancelled = fixture(cells, new Map([[key(position), block("poppy", position)]]));
  cancelled.bot.interrupt_code = true;
  await assert.rejects(clearSchematicObstructions(cancelled.bot, buildOf(cells), { Vec3Class: Vec3 }), /cancelled/);
  assert.deepEqual(cancelled.removed, []);

  const duringDig = fixture(cells, new Map([[key(position), block("poppy", position)]]));
  duringDig.bot.dig = async (target) => {
    duringDig.removed.push(key(target.position));
    duringDig.blocks.set(key(target.position), air());
    duringDig.bot.interrupt_code = true;
  };
  await assert.rejects(clearSchematicObstructions(duringDig.bot, buildOf(cells), { Vec3Class: Vec3 }), /cancelled after clearing/);
  assert.deepEqual(duringDig.removed, [key(position)]);
});

test("unavailable cells fail closed and a dig must be verified as air", async () => {
  const position = { x: 0, y: 0, z: 0 };
  const cells = [{ position, name: "air", properties: {} }];
  const unavailable = fixture(cells, new Map());
  unavailable.bot.blockAt = () => null;
  await assert.rejects(clearSchematicObstructions(unavailable.bot, buildOf(cells), { Vec3Class: Vec3 }), /unavailable or unloaded/);

  const noOpDig = fixture(cells, new Map([[key(position), block("poppy", position)]]));
  noOpDig.bot.dig = async () => {};
  await assert.rejects(clearSchematicObstructions(noOpDig.bot, buildOf(cells), { Vec3Class: Vec3 }), /Could not verify air/);
});

test("cancellation while navigating stops pathfinding before any obstruction is dug", async () => {
  const position = { x: 10, y: 0, z: 0 };
  const cells = [{ position, name: "air", properties: {} }];
  const { bot, removed } = fixture(cells, new Map([[key(position), block("poppy", position)]]));
  let stopped = false;
  bot.entity.position.distanceTo = () => 100;
  bot.pathfinder = {
    goto: () => new Promise(() => {}),
    setGoal(goal) { if (goal === null) stopped = true; },
  };
  const pending = clearSchematicObstructions(bot, buildOf(cells), { Vec3Class: Vec3 });
  setTimeout(() => { bot.interrupt_code = true; }, 1);
  await assert.rejects(pending, /cancelled while moving/);
  assert.equal(stopped, true);
  assert.deepEqual(removed, []);
});

test("pending obstruction navigation times out once, stops, and cannot dig even after late rejection", { timeout: 2000 }, async () => {
  const position = { x: 10, y: 4, z: -2 };
  const cells = [{ position, name: "air", properties: {} }];
  const { bot, removed, build } = fixture(cells, new Map([[key(position), block("poppy", position)]]));
  let rejectMovement;
  let subscriptions = 0;
  let stops = 0;
  bot.entity.position.distanceTo = () => 100;
  bot.pathfinder = {
    goto: () => ({ then(_resolve, reject) { subscriptions++; rejectMovement = reject; } }),
    setGoal(goal) { assert.equal(goal, null); stops++; },
  };
  await assert.rejects(clearSchematicObstructions(bot, build, { Vec3Class: Vec3, navigationTimeoutMs: 130 }), (error) => {
    assert.equal(error.code, "SCHEMATIC_CLEAR_NAVIGATION_TIMEOUT");
    assert.match(error.message, /obstruction clearing navigation timed out after 130ms.*10,4,-2.*inaccessible/i);
    return true;
  });
  assert.equal(subscriptions, 1, "the returned navigation thenable is observed once");
  assert.equal(stops, 1);
  assert.deepEqual(removed, []);
  rejectMovement(new Error("late navigation failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(removed, []);
});

test("navigation timeout clears real pathfinder goto listeners", { timeout: 2000 }, async () => {
  const position = { x: 10, y: 0, z: 0 };
  const cells = [{ position, name: "air", properties: {} }];
  const { bot, removed, build } = fixture(cells, new Map([[key(position), block("poppy", position)]]));
  const goto = require("mineflayer-pathfinder/lib/goto");
  const events = ["path_stop", "goal_reached", "path_update", "goal_updated"];
  const baseline = events.map((event) => bot.listenerCount(event));
  bot.entity.position.distanceTo = () => 100;
  bot.pathfinder = {
    goto: (goal) => goto(bot, goal),
    setGoal(goal) { bot.emit("goal_updated", goal); },
  };
  await assert.rejects(clearSchematicObstructions(bot, build, { Vec3Class: Vec3, navigationTimeoutMs: 20 }), /navigation timed out/);
  assert.deepEqual(events.map((event) => bot.listenerCount(event)), baseline);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(removed, []);
});

for (const phase of ["initial check", "queued startup"]) {
  test(`navigation deadline before ${phase} never starts a goal or leaks goto listeners`, async (t) => {
    const position = { x: 10, y: 0, z: 0 };
    const cells = [{ position, name: "air", properties: {} }];
    const { bot, removed, build } = fixture(cells, new Map([[key(position), block("poppy", position)]]));
    const goto = require("mineflayer-pathfinder/lib/goto");
    const events = ["path_stop", "goal_reached", "path_update", "goal_updated"];
    const baseline = events.map((event) => bot.listenerCount(event));
    let clockCalls = 0;
    t.mock.method(performance, "now", () => {
      clockCalls++;
      return clockCalls <= (phase === "initial check" ? 1 : 2) ? 0 : 2;
    });
    let starts = 0;
    let goal = null;
    let stops = 0;
    bot.entity.position.distanceTo = () => 100;
    bot.pathfinder = {
      goto(target) { starts++; return goto(bot, target); },
      setGoal(target) { goal = target; if (target === null) stops++; bot.emit("goal_updated", target); },
    };
    await assert.rejects(clearSchematicObstructions(bot, build, { Vec3Class: Vec3, navigationTimeoutMs: 1 }), { code: "SCHEMATIC_CLEAR_NAVIGATION_TIMEOUT" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(starts, 0);
    assert.equal(goal, null);
    assert.equal(stops, 1);
    assert.deepEqual(events.map((event) => bot.listenerCount(event)), baseline);
    assert.deepEqual(removed, []);
  });
}

test("queued navigation rechecks cancellation before starting", async () => {
  const position = { x: 10, y: 0, z: 0 };
  const cells = [{ position, name: "air", properties: {} }];
  const { bot, removed, build } = fixture(cells, new Map([[key(position), block("poppy", position)]]));
  let starts = 0;
  let stops = 0;
  bot.entity.position.distanceTo = () => { queueMicrotask(() => { bot.interrupt_code = true; }); return 100; };
  bot.pathfinder = {
    goto() { starts++; return Promise.resolve(); },
    setGoal(goal) { assert.equal(goal, null); stops++; },
  };
  await assert.rejects(clearSchematicObstructions(bot, build, { Vec3Class: Vec3 }), { code: "SCHEMATIC_CLEAR_CANCELLED" });
  assert.equal(starts, 0);
  assert.equal(stops, 1);
  assert.deepEqual(removed, []);
});

test("pending navigation honors interruption, build cancellation, and lifecycle changes before timeout", { timeout: 2000 }, async () => {
  for (const reason of ["interrupt", "build", "world", "lifecycle"]) {
    const position = { x: 10, y: 0, z: 0 };
    const cells = [{ position, name: "air", properties: {} }];
    const { bot, removed, build } = fixture(cells, new Map([[key(position), block("poppy", position)]]));
    let current = true;
    const identity = captureSchematicAttemptIdentity(bot, { isCurrent: () => current });
    let stops = 0;
    bot.entity.position.distanceTo = () => 100;
    bot.pathfinder = {
      goto: () => {
        if (reason === "interrupt") bot.interrupt_code = true;
        if (reason === "build") build.isCancelled = true;
        if (reason === "world") bot._client.emit("respawn");
        if (reason === "lifecycle") current = false;
        return new Promise(() => {});
      },
      stop() { stops++; },
    };
    await assert.rejects(clearSchematicObstructions(bot, build, {
      Vec3Class: Vec3, attemptIdentity: identity, navigationTimeoutMs: 500,
    }), (error) => error.code === "SCHEMATIC_CLEAR_CANCELLED" && /moving to 10,0,0/.test(error.message));
    assert.equal(stops, 1, reason);
    assert.deepEqual(removed, [], reason);
  }
});

test("successful navigation clears only the revalidated obstruction", async () => {
  const position = { x: 10, y: 0, z: 0 };
  const cells = [{ position, name: "air", properties: {} }];
  const { bot, removed, build } = fixture(cells, new Map([[key(position), block("poppy", position)]]));
  let moves = 0;
  bot.entity.position.distanceTo = () => 100;
  bot.pathfinder = { goto() { moves++; return Promise.resolve(); } };
  assert.deepEqual(await clearSchematicObstructions(bot, build, { Vec3Class: Vec3, navigationTimeoutMs: 500 }), { cleared: 1 });
  assert.equal(moves, 1);
  assert.deepEqual(removed, [key(position)]);
});

test("world transition during navigation await fails closed before any dig", async () => {
  const position = { x: 10, y: 0, z: 0 };
  const cells = [{ position, name: "air", properties: {} }];
  const { bot, removed } = fixture(cells, new Map([[key(position), block("poppy", position)]]));
  bot.entity.position.distanceTo = () => 100;
  bot.pathfinder = {
    async goto() {
      bot.game.dimension = "the_nether";
      bot.world = {};
    },
    setGoal() {},
  };
  await assert.rejects(clearSchematicObstructions(bot, buildOf(cells), { Vec3Class: Vec3 }), /identity changed/);
  assert.deepEqual(removed, []);
});

test("missing observable world identity fails closed before inspection or destruction", async () => {
  const position = { x: 0, y: 0, z: 0 };
  const candidate = fixture(
    [{ position, name: "air", properties: {} }],
    new Map([[key(position), block("poppy", position)]]),
  );
  candidate.bot._client = null;
  await assert.rejects(clearSchematicObstructions(candidate.bot, candidate.build, { Vec3Class: Vec3 }), /identity changed or is unavailable/);
  assert.deepEqual(candidate.removed, []);
});

test("death, disconnect, entity replacement, and lifecycle cancellation fail closed", async () => {
  const position = { x: 0, y: 0, z: 0 };
  for (const invalidate of [
    (bot) => { bot.health = 0; },
    (bot) => { bot._client.ended = true; },
    (bot) => { bot.entity = {}; },
  ]) {
    const candidate = fixture(
      [{ position, name: "air", properties: {} }],
      new Map([[key(position), block("poppy", position)]]),
    );
    const attemptIdentity = captureSchematicAttemptIdentity(candidate.bot);
    invalidate(candidate.bot);
    await assert.rejects(clearSchematicObstructions(candidate.bot, candidate.build, {
      Vec3Class: Vec3,
      attemptIdentity,
    }), /identity changed/);
    assert.deepEqual(candidate.removed, []);
  }

  const candidate = fixture(
    [{ position, name: "air", properties: {} }],
    new Map([[key(position), block("poppy", position)]]),
  );
  const lifecycle = { isCurrent: () => false };
  const attemptIdentity = captureSchematicAttemptIdentity(candidate.bot, lifecycle);
  await assert.rejects(clearSchematicObstructions(candidate.bot, candidate.build, {
    Vec3Class: Vec3,
    attemptIdentity,
  }), /identity changed/);
  assert.deepEqual(candidate.removed, []);
});

test("world transition while a dig awaits prevents every subsequent destructive action", async () => {
  const first = { x: 0, y: 0, z: 0 };
  const second = { x: 1, y: 0, z: 0 };
  const cells = [first, second].map((position) => ({ position, name: "air", properties: {} }));
  const blocks = new Map([[key(first), block("poppy", first)], [key(second), block("poppy", second)]]);
  const candidate = fixture(cells, blocks);
  candidate.bot.dig = async (target) => {
    candidate.removed.push(key(target.position));
    blocks.set(key(target.position), air());
    candidate.bot.world = {};
  };
  await assert.rejects(clearSchematicObstructions(candidate.bot, buildOf(cells), { Vec3Class: Vec3 }), /identity changed/);
  assert.deepEqual(candidate.removed, [key(first)], "transition during the first dig prevents the next dig");
});

test("inaccessible foliage is reported without excavation", async () => {
  const position = { x: 10, y: 0, z: 0 };
  const cells = [{ position, name: "air", properties: {} }];
  const { bot, removed } = fixture(cells, new Map([[key(position), block("poppy", position)]]));
  bot.entity.position.distanceTo = () => 100;
  bot.pathfinder = { goto: async () => { throw new Error("no safe route"); } };
  await assert.rejects(clearSchematicObstructions(bot, buildOf(cells), { Vec3Class: Vec3 }), /inaccessible.*no safe route/);
  assert.deepEqual(removed, []);
});

test("guard disables pathfinder excavation/scaffolding and rejects all out-of-volume digs", async () => {
  const position = { x: 0, y: 0, z: 0 };
  const cells = [{ position, name: "air", properties: {} }];
  const { bot } = fixture(cells, new Map([
    [key(position), block("poppy", position)],
    ["4,0,0", block("poppy", { x: 4, y: 0, z: 0 })],
  ]));
  const originalMovements = { canDig: true, allow1by1towers: true, scafoldingBlocks: [1, 2] };
  bot.pathfinder = {
    movements: originalMovements,
    setMovements(movements) { this.movements = movements; },
  };
  bot.builder = { clearArea: async () => "original" };
  const originalDig = bot.dig;

  await withSchematicDestructionGuards(bot, buildOf(cells), Vec3, async () => {
    assert.equal(bot.pathfinder.movements.canDig, false);
    assert.equal(bot.pathfinder.movements.allow1by1towers, false);
    assert.deepEqual(bot.pathfinder.movements.scafoldingBlocks, []);
    await assert.rejects(bot.dig(block("poppy", { x: 4, y: 0, z: 0 })), /outside the exact schematic volume/);
    await assert.rejects(bot.dig(block("poppy", position)), /unapproved schematic dig/);
    await assert.rejects(
      bot.placeBlock({ position: new Vec3(0, 0, 0) }, new Vec3(1, 0, 0)),
      /outside the exact schematic volume/,
    );
    await assert.rejects(bot.builder.clearArea({}), /disabled/);
  });

  assert.equal(bot.dig, originalDig);
  assert.equal(bot.pathfinder.movements, originalMovements);
  assert.equal(await bot.builder.clearArea(), "original");
});

test("keeps destructive guards installed until a cancelled builder promise actually settles", async () => {
  const position = { x: 0, y: 0, z: 0 };
  const cells = [{ position, name: "air", properties: {} }];
  const { bot, removed } = fixture(cells, new Map());
  const originalMovements = { canDig: true, allow1by1towers: true, scafoldingBlocks: [1] };
  bot.pathfinder = { movements: originalMovements, setMovements(movements) { this.movements = movements; } };
  bot.builder = {};
  const originalWorld = bot.world;
  let lifecycleCurrent = true;
  const attemptIdentity = captureSchematicAttemptIdentity(bot, { isCurrent: () => lifecycleCurrent });
  let settle;
  const settlement = new Promise((resolve) => { settle = resolve; });
  const originalDig = bot.dig;

  const result = await withSchematicDestructionGuards(
    bot,
    buildOf(cells),
    Vec3,
    async () => "interrupted",
    () => settlement,
    attemptIdentity,
  );
  assert.equal(result, "interrupted");
  assert.notEqual(bot.dig, originalDig);
  assert.equal(bot.pathfinder.movements.canDig, false);
  bot.world = {};
  await assert.rejects(bot.dig(block("poppy", position)), /cancelled|identity changed/);
  bot.world = originalWorld;
  lifecycleCurrent = false;
  await assert.rejects(bot.placeBlock({ position: new Vec3(-1, 0, 0) }, new Vec3(1, 0, 0)), /cancelled|identity changed/);
  assert.deepEqual(removed, [], "the retained guard rejects stale-world builder calls");
  settle();
  await settlement;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(bot.dig, originalDig);
  assert.equal(bot.pathfinder.movements, originalMovements);
});

test("stale identity or an operation error retains guards until pending builder settlement", async () => {
  for (const failure of ["transition", "throw"]) {
    const position = { x: 0, y: 0, z: 0 };
    const cells = [{ position, name: "air", properties: {} }];
    const { bot, removed } = fixture(cells, new Map());
    const movements = { canDig: true };
    bot.pathfinder = { movements, setMovements(value) { this.movements = value; } };
    bot.builder = { clearArea: async () => {} };
    const dig = bot.dig, place = bot.placeBlock, clear = bot.builder.clearArea;
    let settle;
    const pending = new Promise(resolve => { settle = resolve; });
    await assert.rejects(withSchematicDestructionGuards(bot, buildOf(cells), Vec3, async () => {
      if (failure === "transition") { bot._client.emit("respawn"); return "interrupted"; }
      throw new Error("operation failed");
    }, () => pending), failure === "transition" ? /identity changed/ : /operation failed/);
    assert.notEqual(bot.dig, dig);
    assert.notEqual(bot.placeBlock, place);
    assert.notEqual(bot.builder.clearArea, clear);
    assert.equal(bot.pathfinder.movements.canDig, false);
    await assert.rejects(bot.dig(block("poppy", position)));
    await assert.rejects(bot.placeBlock({ position: new Vec3(-1, 0, 0) }, new Vec3(1, 0, 0)));
    assert.deepEqual(removed, []);
    settle();
    await pending;
    await Promise.resolve();
    assert.equal(bot.dig, dig);
    assert.equal(bot.placeBlock, place);
    assert.equal(bot.builder.clearArea, clear);
    assert.equal(bot.pathfinder.movements, movements);
  }
});

test("unknown waterlogged metadata fails closed while registry-proven dry blocks remain clearable", async () => {
  const position = { x: 0, y: 0, z: 0 };
  const cells = [{ position, name: "air", properties: {} }];
  for (const extra of [{ getProperties: undefined }, { getProperties: () => ({}) },
    { getProperties: () => { throw new Error("unreadable"); } },
    { getProperties: () => ({ waterlogged: "unknown" }) },
    { getProperties: () => ({ waterlogged: "none" }) },
    { getProperties: () => ({ waterlogged: true }) }]) {
    const candidate = block("mangrove_propagule", position, extra);
    const { bot, removed, build } = fixture(cells, new Map([[key(position), candidate]]));
    assert.equal(isSafeNaturalObstruction(candidate, bot.version), false);
    await assert.rejects(clearSchematicObstructions(bot, build, { Vec3Class: Vec3 }), /fluid|water/i);
    assert.deepEqual(removed, []);
  }
  for (const candidate of [block("mangrove_propagule", position, { getProperties: () => ({ waterlogged: false }) }),
    block("poppy", position, { getProperties: () => { throw new Error("unreadable"); } })]) {
    const { bot, removed, build } = fixture(cells, new Map([[key(position), candidate]]));
    assert.equal(isSafeNaturalObstruction(candidate, bot.version), true);
    assert.equal((await clearSchematicObstructions(bot, build, { Vec3Class: Vec3 })).cleared, 1);
    assert.deepEqual(removed, [key(position)]);
  }
});
