import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers";
import { buildSchematic } from "../../src/utils/schematic/build_schematic.js";
import { loadSchematicBuilder } from "../../src/utils/schematic/builder_compat.js";
import { resolvePlacementOptions } from "../../src/utils/schematic/placement_options.js";
import { createModernBuild } from "../../src/utils/schematic/modern_build.js";
import { provenanceFixtureDependencies } from "./provenance_fixture.js";

const require = createRequire(import.meta.url);
const Vec3 = require("vec3");
const key = p => `${p.x},${p.y},${p.z}`;

function fixture(names = ["stone", "stone"]) {
  const version = "1.20.4";
  const data = require("minecraft-data")(version);
  const registry = { ...data, dimensionsByName: { overworld: { minY: -64, height: 384 } } };
  const Block = require("prismarine-block")(version);
  const world = new Map(), writes = [], modes = [], logs = [], slots = [];
  const entity = { position: new Vec3(-2.31, 63.5, 0.5), width: 0.6, height: 1.8 };
  const inventory = Object.assign(new EventEmitter(), { slots: Array(46).fill(null), items() { return this.slots.filter(Boolean); } });
  const bot = Object.assign(new EventEmitter(), {
    version, registry, game: { gameMode: "survival", dimension: "overworld", minY: -64, height: 384 },
    world: {}, entity, entities: { self: entity }, inventory, interrupt_code: false,
    _client: Object.assign(new EventEmitter(), { socket: {} }), supportFeature: data.supportFeature,
    digTime: () => 0, async lookAt() { await dependencies.onAim?.(); }, swingArm() {},
    blockAt(position) {
      const name = world.has(key(position)) ? world.get(key(position)) : position.y <= 63 ? "stone" : "air";
      if (name == null) return null;
      const block = Block.fromStateId(typeof name === "number" ? name : data.blocksByName[name].defaultState, 0);
      block.position = position;
      return block;
    },
    equip(item) { bot.heldItem = item; return Promise.resolve(); },
    creative: { setInventorySlot(slot, item) {
      slots.push(item?.name ?? null);
      const old = inventory.slots[slot]; inventory.slots[slot] = item;
      inventory.emit(`updateSlot:${slot}`, old, item);
    } },
    pathfinder: { movements: {}, setMovements(m) { this.movements = m; }, setGoal() {} },
    loadPlugin(plugin) { plugin(bot); },
  });
  loadSchematicBuilder(bot);
  const palette = names.map(name => data.blocksByName[name].defaultState);
  const schematic = { version: "1.20.4", size: new Vec3(names.length, 1, 1), offset: new Vec3(0, 0, 0), palette,
    blocks: names.map((_, i) => i), getBlock: p => Block.fromStateId(palette[p.x], 0) };
  const dependencies = provenanceFixtureDependencies({
    resolvePath: () => "/schematics/delicate.mc1.20.4.schem", fsAccess: () => {}, fsReadFile: () => Buffer.from("synthetic"),
    validateSource: () => {}, SchematicClass: { read: () => schematic },
    placementOptions: resolvePlacementOptions(),
    changeGameMode: async (_bot, mode) => { modes.push(mode); bot.game.gameMode = mode; await dependencies.onTransition?.(mode); return true; },
    writeLog: message => logs.push(message),
  });
  function inbound(position, name) {
    const old = bot.blockAt(position); world.set(key(position), name); const block = bot.blockAt(position);
    bot.emit(`blockUpdate:${position}`, old, block);
    bot._client.emit("block_change", { location: position, type: block.stateId });
  }
  bot._client.write = (name, packet) => {
    if (name === "block_dig") throw new Error("Delicate build must not dig");
    if (name === "set_creative_slot") {
      slots.push(null);
      setImmediate(() => inventory.emit(`updateSlot:${packet.slot}`, null, null));
      return;
    }
    if (name !== "block_place") return;
    const faces = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
    const target = packet.location.offset(...faces[packet.direction]);
    writes.push([key(target), bot.heldItem.name]);
    if (dependencies.noConfirmation) return;
    setImmediate(() => {
      inbound(packet.location, bot.blockAt(packet.location).name);
      inbound(target, bot.heldItem.name);
      dependencies.onConfirm?.(target);
    });
  };
  return { bot, world, writes, modes, logs, slots, dependencies, schematic,
    run: () => buildSchematic(bot, "delicate.schem", 0, 64, 0, dependencies) };
}

test("default delicate rejects plants, intended-air blockers and occupied mismatches before Creative", async () => {
  for (const [names, position, block] of [
    [["stone"], "0,64,0", "short_grass"],
    [["air"], "0,64,0", "poppy"],
    [["air"], "0,64,0", "stone"],
    [["stone"], "0,64,0", "dirt"],
  ]) {
    const f = fixture(names); f.world.set(position, block);
    assert.equal(await f.run(), false, f.logs.join("; "));
    assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []); assert.deepEqual(f.slots, []);
    assert.equal(f.world.get(position), block);
    assert.match(f.logs.join(" "), /delicate blocked/i);
  }
});

test("delicate rejects a matching block name with a different state and missing support", async () => {
  const state = fixture(["oak_log"]);
  state.world.set("0,64,0", state.bot.registry.blocksByName.oak_log.defaultState + 1);
  assert.equal(await state.run(), false);
  assert.deepEqual(state.modes, []); assert.deepEqual(state.writes, []); assert.deepEqual(state.slots, []);
  assert.match(state.logs.join(" "), /delicate blocked/i);
  const support = fixture(["stone"]); support.world.set("0,63,0", "air");
  assert.equal(await support.run(), false);
  assert.deepEqual(support.modes, []); assert.deepEqual(support.writes, []); assert.deepEqual(support.slots, []);
});

test("delicate retains matching blocks and places only into air at fixed origin", async () => {
  const f = fixture(["stone", "stone", "air"]); f.world.set("0,64,0", "stone");
  assert.equal(await f.run(), true, f.logs.join("; "));
  assert.deepEqual(f.writes, [["1,64,0", "stone"]]);
  assert.equal(f.world.get("0,64,0"), "stone");
  assert.deepEqual(f.modes, ["creative", "survival"]);
  assert.deepEqual(f.slots, ["stone", null]);
  assert.equal(f.bot.inventory.slots[36], null);
});

test("delicate all-matching build does not switch mode or supply inventory", async () => {
  const f = fixture(["stone", "air"]); f.world.set("0,64,0", "stone");
  assert.equal(await f.run(), true, f.logs.join("; "));
  assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []); assert.deepEqual(f.slots, []);
});

test("rotated delicate uses a realizable vertical log and guards rotated intended air", async () => {
  const f = fixture(["oak_log", "air"]);
  f.dependencies.placementOptions = { ...resolvePlacementOptions(), orientation: "east" };
  assert.equal(await f.run(), true, f.logs.join("; "));
  assert.deepEqual(f.writes, [["0,64,0", "oak_log"]]);
  const blocked = fixture(["oak_log", "air"]);
  blocked.dependencies.placementOptions = { ...resolvePlacementOptions(), orientation: "east" };
  blocked.world.set("0,64,1", "stone");
  assert.equal(await blocked.run(), false);
  assert.deepEqual(blocked.writes, []); assert.deepEqual(blocked.modes, []); assert.deepEqual(blocked.slots, []);
  assert.match(blocked.logs.join(" "), /delicate blocked/i);
});

test("rotated unrepresentable state fails before mode, supply, or edits", async () => {
  for (const name of ["oak_stairs", "oak_sign", "rail", "oak_door"]) {
    const f = fixture([name]);
    f.dependencies.placementOptions = { ...resolvePlacementOptions(), orientation: "west" };
    assert.equal(await f.run(), false, name);
    assert.deepEqual(f.writes, [], name); assert.deepEqual(f.modes, [], name); assert.deepEqual(f.slots, [], name);
    assert.match(f.logs.join(" "), /cannot be realized|second block half/i, name);
  }
});

test("production delicate path builds asymmetric east, south and west volumes with exact registry states", async () => {
  const expected = {
    east: ["air", "stone", "glass", "air", "air", "oak_log"],
    south: ["air", "glass", "air", "oak_log", "air", "stone"],
    west: ["oak_log", "air", "air", "glass", "stone", "air"],
  };
  for (const orientation of Object.keys(expected)) {
    const f = fixture(["stone", "air", "oak_log", "air", "glass", "air"]);
    f.schematic.size = new Vec3(3, 1, 2);
    f.schematic.offset = new Vec3(5, -2, 7);
    const Block = require("prismarine-block")("1.20.4");
    f.schematic.getBlock = p => Block.fromStateId(f.schematic.palette[(p.z - 7) * 3 + p.x - 5], 0);
    f.bot.entity.position = new Vec3(-1, 63.5, 0.5);
    f.dependencies.placementOptions = { ...resolvePlacementOptions(), orientation };
    let planned;
    f.dependencies.makeBuild = (schematic, bot, origin, options) => (planned = createModernBuild(schematic, bot, origin, options));
    assert.equal(await f.run(), true, `${orientation}: ${f.logs.join("; ")}`);
    assert.deepEqual(planned.cells.map(c => c.name), expected[orientation]);
    const odd = orientation !== "south";
    assert.deepEqual(planned.dimensions, { width: odd ? 2 : 3, height: 1, length: odd ? 3 : 2 });
    for (const cell of planned.cells) {
      const actual = f.bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z));
      assert.equal(actual.stateId, cell.stateId, `${orientation}: ${key(cell.position)}`);
      assert.deepEqual(actual.getProperties(), cell.properties);
    }
  }
});

test("delicate refuses changes during transition and final aiming without writing", async () => {
  for (const phase of ["onTransition", "onAim"]) {
    const f = fixture();
    f.dependencies[phase] = () => { f.world.set("0,64,0", "poppy"); };
    assert.equal(await f.run(), false);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.modes, ["creative", "survival"]);
    assert.equal(f.bot.inventory.slots[36], null);
  }
});

test("delicate stops after a confirmed placement if a later target changes", async () => {
  const f = fixture();
  f.dependencies.onConfirm = () => { f.world.set("1,64,0", "poppy"); };
  assert.equal(await f.run(), false);
  assert.deepEqual(f.writes, [["0,64,0", "stone"]]);
  assert.equal(f.world.get("0,64,0"), "stone");
  assert.equal(f.world.get("1,64,0"), "poppy");
  assert.deepEqual(f.modes, ["creative", "survival"]);
  assert.equal(f.bot.inventory.slots[36], null);
});

test("delicate interruption cleans up and preserves an eligible fixed-origin resume", async () => {
  const f = fixture();
  const session = { cancelled: false, resumeEligible: false };
  f.dependencies.resumeSession = session;
  f.dependencies.onAim = () => { f.bot.interrupt_code = true; };
  assert.equal(await f.run(), false);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, ["creative", "survival"]);
  assert.equal(f.bot.inventory.slots[36], null);
  assert.equal(session.resumeEligible, true);
  assert.equal(session.context.placementOptions.mode, "delicate");
  f.bot.interrupt_code = false; delete f.dependencies.onAim;
  assert.equal(await f.run(), true, f.logs.join("; "));
  assert.deepEqual(f.writes, [["0,64,0", "stone"], ["1,64,0", "stone"]]);
  assert.equal(session.context, null);
});

test("delicate cancellation during aim prevents final packet and restores inventory", async () => {
  const f = fixture();
  const session = { cancelled: false, resumeEligible: false };
  f.dependencies.resumeSession = session;
  f.dependencies.onAim = () => { session.cancelled = true; };
  assert.equal(await f.run(), false);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, ["creative", "survival"]);
  assert.equal(f.bot.inventory.slots[36], null);
  assert.equal(session.resumeEligible, false);
});

test("delicate holds the lifecycle lease until a cancelled native aim settles", async () => {
  const f = fixture(["stone"]);
  let started, release;
  const aiming = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.dependencies.onAim = () => { started(); return gate; };
  const first = f.run();
  await aiming;
  f.bot.interrupt_code = true;
  assert.equal(await first, false);
  f.bot.interrupt_code = false;
  assert.equal(await f.run(), false);
  assert.match(f.logs.join(" "), /busy.*settling/i);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.writes, []);
  assert.equal(f.bot.inventory.slots[36], null);
});
