import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { planRaiseSchematicSite, revalidateRaiseSchematicSite, revalidateRaiseSchematicSiteAtDispatch } from "../../src/utils/schematic/raise_site_planner.js";

class Vec3 { constructor(x, y, z) { Object.assign(this, { x, y, z }); } }
const key = p => `${p.x},${p.y},${p.z}`;
const cube = [[0, 0, 0, 1, 1, 1]];
const block = (name, extra = {}) => ({ name, shapes: name.includes("air") ? [] : cube, getProperties: () => ({}), ...extra });

function fixture({ width = 2, height = 2, length = 1 } = {}) {
  const names = ["air", "cave_air", "void_air", "stone", "dirt", "cobblestone", "oak_planks", "oak_leaves", "chest", "redstone_wire", "sand"];
  const registry = { blocksByName: {}, blocksByStateId: {} };
  names.forEach((name, id) => { const def = { name, states: [] }; registry.blocksByName[name] = def; registry.blocksByStateId[id] = def; });
  const ids = Object.fromEntries(names.map((name, id) => [name, id]));
  const cells = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let z = 0; z < length; z++) {
    cells.push({ position: { x, y: 10 + y, z }, name: y === 0 ? "stone" : "air", stateId: y === 0 ? ids.stone : ids.air, properties: {} });
  }
  const values = new Map(), reads = [], actions = [];
  const entity = { position: { x: 100, y: 20, z: 100 }, width: 0.6, height: 1.8 };
  const bot = Object.assign(new EventEmitter(), {
    registry, version: "synthetic", game: { dimension: "overworld" }, world: {}, _client: Object.assign(new EventEmitter(), { socket: {} }), entity, entities: { self: entity },
    blockAt(p) { reads.push(key(p)); return values.has(key(p)) ? values.get(key(p)) : block(p.y <= 9 ? "stone" : "air"); },
    dig() { actions.push("dig"); }, placeBlock() { actions.push("place"); }, chat() { actions.push("chat"); },
    creative: { setInventorySlot() { actions.push("creative"); } }, pathfinder: { goto() { actions.push("move"); } },
  });
  return { bot, build: { cells, dimensions: { width, height, length } }, options: { origin: { x: 0, y: 10, z: 0 }, worldBounds: { minY: -64, maxY: 319 }, Vec3Class: Vec3 }, values, reads, actions, ids };
}
const plan = f => planRaiseSchematicSite(f.bot, f.build, f.options);
const refuse = (promise, code = "SCHEMATIC_SITE_UNSAFE") => assert.rejects(promise, { code });

test("selects the lowest elevated fixed-X/Z site and freezes the complete transformed volume and bottom-up dirt", async () => {
  const f = fixture({ width: 3 });
  f.values.set("0,10,0", block("dirt"));
  f.values.set("2,9,0", block("air"));
  const result = await plan(f);
  assert.deepEqual(result.origin, { x: 0, y: 11, z: 0 });
  assert.deepEqual(result.requestedOrigin, { x: 0, y: 10, z: 0 });
  assert.deepEqual(result.dirt, [{ x: 2, y: 9, z: 0 }, { x: 1, y: 10, z: 0 }, { x: 2, y: 10, z: 0 }]);
  assert.equal(result.volume.length, 6);
  assert.deepEqual(result.volume.map(c => c.position.y), [11, 11, 11, 12, 12, 12]);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.volume) && Object.isFrozen(result.volume[0].properties) && Object.isFrozen(result.dirt[0]));
  assert.deepEqual(f.actions, []);
});

test("retains the requested Y when a flat site is already suitable", async () => {
  const f = fixture(); const result = await plan(f);
  assert.deepEqual(result.origin, f.options.origin);
  assert.deepEqual(result.dirt, []);
  assert.equal(await revalidateRaiseSchematicSite(f.bot, result), true);
  assert.deepEqual(f.actions, []);
});

test("already-correct occupied targets are retained and excluded from the edit prefix and budget", async () => {
  const f = fixture();
  f.values.set("0,10,0", block("stone"));
  f.options.limits = { edits: 1 };
  const result = await plan(f);
  assert.deepEqual(result.origin, f.options.origin);
  assert.deepEqual(result.dirt, []);
  assert.equal(await revalidateRaiseSchematicSite(f.bot, result), true);
  f.values.set("1,10,0", block("stone"));
  assert.equal(await revalidateRaiseSchematicSite(f.bot, result, { completedVolume: 1 }), true);
  f.values.set("0,10,0", block("air"));
  await refuse(revalidateRaiseSchematicSite(f.bot, result, { completedVolume: 1 }));
  assert.deepEqual(f.actions, []);
});

test("an already-correct passive non-terrain target is preserved, not mistaken for a structure obstruction", async () => {
  const f = fixture({ width: 1 });
  Object.assign(f.build.cells[0], { name: "oak_planks", stateId: f.ids.oak_planks });
  f.values.set("0,10,0", block("oak_planks"));
  const result = await plan(f);
  assert.equal(result.origin.y, 10);
  assert.equal(await revalidateRaiseSchematicSite(f.bot, result), true);
  await refuse(revalidateRaiseSchematicSite(f.bot, result, { completedVolume: 1 }));
  assert.deepEqual(f.actions, []);
});

test("offset transformed volumes search from their own minimum while reporting the moved anchor", async () => {
  const f = fixture();
  f.build.cells = f.build.cells.map(cell => ({ ...cell, position: { x: cell.position.x + 5, y: cell.position.y + 2, z: cell.position.z - 3 } }));
  f.values.set("5,12,-3", block("dirt"));
  const result = await plan(f);
  assert.deepEqual(result.origin, { x: 0, y: 11, z: 0 });
  assert.deepEqual(result.volume[0].position, { x: 5, y: 13, z: -3 });
  assert.ok(result.dirt.some(p => key(p) === "6,12,-3"));
  assert.deepEqual(f.actions, []);
});

test("the first matching elevation is selected rather than raised over a correct occupied cell", async () => {
  const f = fixture();
  f.values.set("0,10,0", block("stone"));
  const result = await plan(f);
  assert.equal(result.origin.y, 10);
  assert.deepEqual(f.actions, []);
});

test("continues past an unsupportable low matching candidate to the lowest bounded supported site", async () => {
  const f = fixture({ width: 1, height: 1 });
  f.options.origin.y = 0;
  f.build.cells[0].position.y = 0;
  f.options.worldBounds = { minY: 0, maxY: 30 };
  f.bot.blockAt = p => { f.reads.push(key(p)); return block(p.y === 0 || p.y === 3 ? "stone" : "air"); };
  const result = await plan(f);
  assert.equal(result.origin.y, 4);
  assert.deepEqual(result.dirt, []);
  assert.deepEqual(f.actions, []);
});

test("only air is fillable and structure, foliage, unknown, falling and unloaded ground is rejected", async () => {
  for (const value of [block("oak_planks"), block("oak_leaves"), block("mystery"), block("sand"), block("chest"), null]) {
    const f = fixture(); f.values.set("0,9,0", value);
    await refuse(plan(f)); assert.deepEqual(f.actions, []);
  }
});

test("obstructed volumes do not elevate over structures or foliage", async () => {
  for (const name of ["oak_planks", "oak_leaves", "chest", "mystery"]) {
    const f = fixture(); f.values.set("0,10,0", block(name)); await refuse(plan(f));
  }
});

test("ground needs a reviewed state and a full cube without block entity data", async () => {
  for (const value of [block("stone", { shapes: [] }), block("stone", { nbt: {} }), block("stone", { getProperties: () => ({ mystery: true }) }), block("stone", { getProperties: () => { throw Error("unknown"); } })]) {
    const f = fixture(); f.values.set("0,9,0", value); await refuse(plan(f));
  }
});

test("rejects unknown, active, foliage and structural neighbors even outside the volume", async () => {
  for (const name of ["redstone_wire", "mystery", "oak_leaves", "chest", "oak_planks", "cobblestone"]) {
    const f = fixture(); f.values.set("-2,10,0", block(name)); await refuse(plan(f));
  }
});

test("rejects unsupported targets and state-ID/name disagreement before world reads", async () => {
  for (const [name, id] of [["redstone_wire", 9], ["stone", 0], ["mystery", 0]]) {
    const f = fixture(); Object.assign(f.build.cells[0], { name, stateId: id }); await refuse(plan(f)); assert.equal(f.reads.length, 0);
  }
});

test("validates complete rectangular volume and basic inputs before reads", async () => {
  for (const mutate of [f => f.build.cells.pop(), f => { f.build.cells[1].position = { ...f.build.cells[0].position }; }]) {
    const f = fixture(); mutate(f); await assert.rejects(plan(f)); assert.equal(f.reads.length, 0);
  }
  const f = fixture(); delete f.options.worldBounds; await assert.rejects(plan(f), TypeError);
});

test("bounds footprint, height, rise, depth, edits and reads", async () => {
  const footprint = fixture(); footprint.options.limits = { footprint: 1 }; await refuse(plan(footprint), "SCHEMATIC_SITE_BUDGET"); assert.equal(footprint.reads.length, 0);
  const height = fixture(); height.options.limits = { height: 1 }; await refuse(plan(height), "SCHEMATIC_SITE_BUDGET");
  const rise = fixture(); rise.values.set("0,10,0", block("dirt")); rise.options.limits = { rise: 0 }; await refuse(plan(rise), "SCHEMATIC_NO_SITE");
  const depth = fixture(); depth.values.set("0,9,0", block("air")); depth.options.limits = { depth: 1 }; await refuse(plan(depth), "SCHEMATIC_NO_SITE");
  const edits = fixture(); edits.options.limits = { edits: 1 }; await refuse(plan(edits), "SCHEMATIC_SITE_BUDGET");
  const reads = fixture(); reads.options.limits = { reads: 4 }; await refuse(plan(reads), "SCHEMATIC_SITE_BUDGET"); assert.equal(reads.reads.length, 4);
});

test("protection discovery enforces the read budget before selecting a site", async () => {
  const f = fixture({ width: 1, height: 1 });
  f.options.excludeMatches = true;
  f.options.limits = { reads: 4, rise: 8 };
  const read = f.bot.blockAt.bind(f.bot);
  f.bot.blockAt = p => {
    const result = read(p);
    result.stateId = f.ids[result.name];
    return result;
  };
  await refuse(plan(f), "SCHEMATIC_SITE_BUDGET");
  assert.equal(f.reads.length, 4);
  assert.deepEqual(f.actions, []);
});

test("rejects invalid budgets and enforces the wall-clock deadline after a slow read", async () => {
  const invalid = fixture(); invalid.options.limits = { reads: 100001 }; await assert.rejects(plan(invalid), RangeError);
  const f = fixture(); f.options.limits = { milliseconds: 1 };
  const read = f.bot.blockAt; f.bot.blockAt = p => { const start = performance.now(); while (performance.now() - start < 5) { /* Simulate a blocking reader. */ } return read(p); };
  await refuse(plan(f), "SCHEMATIC_SITE_BUDGET");
});

test("dimension limits cover both volume and the entire inspection halo", async () => {
  const volume = fixture(); volume.options.worldBounds.maxY = 10; await refuse(plan(volume)); assert.equal(volume.reads.length, 0);
  const halo = fixture(); halo.options.worldBounds.minY = 8; await refuse(plan(halo), "SCHEMATIC_NO_SITE");
});

test("fails closed on missing or intersecting entity bounds including the bot", async () => {
  for (const entity of [null, { position: { x: 0, y: 10, z: 0 }, width: 1, height: 2 }, { position: { x: 99, y: 10, z: 0 }, width: 0, height: 2 }]) {
    const f = fixture(); f.bot.entities.other = entity; await refuse(plan(f));
  }
  const f = fixture(); f.bot.entity.position = { x: 0, y: 10, z: 0 }; await refuse(plan(f));
});

test("identity, dimension, lifecycle and explicit cancellation are checked during inspection", async () => {
  for (const change of [f => { f.bot.game.dimension = "nether"; }, f => { f.bot.world = {}; }, f => { f.bot._client.emit("respawn"); }, f => { f.build.isCancelled = true; }, f => { f.bot.interrupt_code = true; }]) {
    const f = fixture(); const read = f.bot.blockAt; f.bot.blockAt = p => { const result = read(p); change(f); return result; };
    await refuse(plan(f), "SCHEMATIC_CLEAR_CANCELLED"); assert.deepEqual(f.actions, []);
  }
  const f = fixture(); f.options.isInterrupted = () => true; await refuse(plan(f), "SCHEMATIC_CLEAR_CANCELLED");
});

test("takes a transformed-plan and requested-origin snapshot before asynchronous scans", async () => {
  const f = fixture(); const read = f.bot.blockAt; let first = true;
  f.bot.blockAt = p => { if (first) { first = false; queueMicrotask(() => { f.build.cells[0].name = "chest"; f.options.origin.x = 100; }); } return read(p); };
  const result = await plan(f); assert.equal(result.volume[0].name, "stone"); assert.equal(result.origin.x, 0);
});

test("revalidates exact ordered dirt and volume prefixes without performing writes", async () => {
  const f = fixture(); f.values.set("0,10,0", block("dirt"));
  const result = await plan(f); assert.deepEqual(result.dirt, [{ x: 1, y: 10, z: 0 }]);
  await refuse(revalidateRaiseSchematicSite(f.bot, result, { completedVolume: 1 }));
  await refuse(revalidateRaiseSchematicSite(f.bot, result, { completedDirt: 1 }));
  f.values.set("1,10,0", block("dirt"));
  assert.equal(await revalidateRaiseSchematicSite(f.bot, result, { completedDirt: 1 }), true);
  f.values.set(key(result.volume[0].position), block("stone"));
  assert.equal(await revalidateRaiseSchematicSite(f.bot, result, { completedDirt: 1, completedVolume: 1 }), true);
  await refuse(revalidateRaiseSchematicSite(f.bot, result, { completedDirt: 1 }));
  assert.deepEqual(f.actions, []);
});

test("dispatch revalidation synchronously enforces the same exact edit prefixes and site identity", async () => {
  const f = fixture();
  f.values.set("0,10,0", block("dirt"));
  const result = await plan(f);
  const check = options => revalidateRaiseSchematicSiteAtDispatch(f.bot, result, options);
  assert.equal(check(), true);
  assert.throws(() => check({ completedDirt: 1 }), { code: "SCHEMATIC_SITE_UNSAFE" });
  f.values.set("1,10,0", block("dirt"));
  assert.equal(check({ completedDirt: 1 }), true);
  f.values.set(key(result.volume[0].position), block("stone"));
  assert.equal(check({ completedDirt: 1, completedVolume: 1 }), true);
  assert.throws(() => check({ completedDirt: 1 }), { code: "SCHEMATIC_SITE_UNSAFE" });
  f.bot.entities.other = { position: { x: 0, y: 11, z: 0 }, width: 1, height: 2 };
  assert.throws(() => check({ completedDirt: 1, completedVolume: 1 }), { code: "SCHEMATIC_SITE_UNSAFE" });
  delete f.bot.entities.other;
  f.bot.interrupt_code = true;
  assert.throws(() => check({ completedDirt: 1, completedVolume: 1 }), { code: "SCHEMATIC_CLEAR_CANCELLED" });
  assert.deepEqual(f.actions, []);
});

test("revalidation rejects changed ground, air, halo, shape, entity, dimension and forged plans", async () => {
  for (const mutate of [
    f => f.values.set("0,9,0", block("dirt")),
    f => f.values.set("0,10,0", block("dirt")),
    f => f.values.set("-2,10,0", block("stone")),
    f => f.values.set("0,9,0", block("stone", { shapes: [] })),
    f => { f.bot.entities.other = { position: { x: 0, y: 10, z: 0 }, width: 1, height: 2 }; },
  ]) {
    const f = fixture(); const result = await plan(f); mutate(f); await refuse(revalidateRaiseSchematicSite(f.bot, result));
  }
  const f = fixture(); const result = await plan(f); await refuse(revalidateRaiseSchematicSite(f.bot, { ...result }));
  f.bot.game.dimension = "nether"; await refuse(revalidateRaiseSchematicSite(f.bot, result), "SCHEMATIC_CLEAR_CANCELLED");
});
