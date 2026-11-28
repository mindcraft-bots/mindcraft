import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers";
import { buildSchematic } from "../../src/utils/schematic/build_schematic.js";
import { loadSchematicBuilder } from "../../src/utils/schematic/builder_compat.js";
import { resolvePlacementOptions } from "../../src/utils/schematic/placement_options.js";
import { provenanceFixtureDependencies } from "./provenance_fixture.js";
import agentSettings from "../../src/agent/settings.js";

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
      const block = Block.fromStateId(data.blocksByName[name].defaultState, 0);
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
    resolvePath: () => "/schematics/raise.mc1.20.4.schem", fsAccess: () => {}, fsReadFile: () => Buffer.from("synthetic"),
    validateSource: () => {}, SchematicClass: { read: () => schematic },
    placementOptions: resolvePlacementOptions({ schematic_placement_mode: "raise" }),
    changeGameMode: async (_bot, mode) => { modes.push(mode); bot.game.gameMode = mode; await dependencies.onTransition?.(mode); return true; },
    writeLog: message => logs.push(message),
  });
  function inbound(position, name) {
    const old = bot.blockAt(position); world.set(key(position), name); const block = bot.blockAt(position);
    bot.emit(`blockUpdate:${position}`, old, block);
    bot._client.emit("block_change", { location: position, type: block.stateId });
  }
  bot._client.write = (name, packet) => {
    if (name === "block_dig") throw new Error("Raise build must not dig");
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
    run: () => buildSchematic(bot, "raise.schem", 0, 64, 0, dependencies) };
}

test("production raise path raises the origin, fills dirt first, places and restores supply", async () => {
  const f = fixture();
  f.world.set("0,64,0", "dirt");
  assert.equal(await f.run(), true, f.logs.join("; "));
  assert.deepEqual(f.writes, [["1,64,0", "dirt"], ["0,65,0", "stone"], ["1,65,0", "stone"]]);
  assert.deepEqual(f.modes, ["creative", "survival"]);
  assert.deepEqual(f.slots, ["dirt", "stone", "stone", null]);
  assert.equal(f.bot.inventory.slots[36], null);
  assert.match(f.logs.join(" "), /origin 0,65,0/);
});

test("flat raise build skips an already correct target", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  agentSettings.schematic_continuation_policy = "off";
  try {
  const f = fixture(); f.world.set("0,64,0", "stone");
  // Both columns are already at the requested height; first is correct.
  assert.equal(await f.run(), true, f.logs.join("; "));
  assert.deepEqual(f.writes, [["1,64,0", "stone"]]);
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("raise protects a matching anchor and its intended air through all candidate foundations", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  agentSettings.schematic_continuation_policy = "deny";
  try {
    const f = fixture(["stone", "air"]); f.world.set("0,64,0", "stone");
    assert.equal(await f.run(), false, f.logs.join("; "));
    assert.equal(f.bot.blockAt(new Vec3(0, 64, 0)).name, "stone");
    assert.equal(f.bot.blockAt(new Vec3(1, 64, 0)).name, "air");
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.modes, []);
    assert.match(f.logs.join(" "), /protected|no air-only site/i);
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("raise discovers higher matching volumes before selecting a lower overlapping site", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  agentSettings.schematic_continuation_policy = "deny";
  try {
    const f = fixture(["air", "stone"]);
    const Block = require("prismarine-block")("1.20.4");
    f.schematic.size = new Vec3(1, 2, 1);
    f.schematic.getBlock = p => Block.fromStateId(f.schematic.palette[p.y], 0);
    f.world.set("0,66,0", "stone");
    assert.equal(await f.run(), false, f.logs.join("; "));
    assert.equal(f.bot.blockAt(new Vec3(0, 65, 0)).name, "air");
    assert.equal(f.bot.blockAt(new Vec3(0, 66, 0)).name, "stone");
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.modes, []);
    assert.match(f.logs.join(" "), /protected|no air-only site/i);
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("raise refuses unavailable evidence at a later elevation before mutation", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  agentSettings.schematic_continuation_policy = "deny";
  try {
    const f = fixture(["stone", "air"]);
    f.world.set("0,90,0", null);
    assert.equal(await f.run(), false, f.logs.join("; "));
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.modes, []);
    assert.match(f.logs.join(" "), /candidate evidence|unavailable/i);
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("raise rechecks a remote candidate match after the mode transition", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  agentSettings.schematic_continuation_policy = "deny";
  try {
    const f = fixture(["stone", "air"]);
    f.dependencies.onTransition = mode => { if (mode === "creative") f.world.set("0,90,0", "stone"); };
    assert.equal(await f.run(), false, f.logs.join("; "));
    assert.deepEqual(f.writes, []);
    assert.equal(f.bot.blockAt(new Vec3(0, 90, 0)).name, "stone");
    assert.match(f.logs.join(" "), /protection evidence changed/i);
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("raise observes cancellation during later-elevation discovery", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  agentSettings.schematic_continuation_policy = "deny";
  try {
    const f = fixture(["stone", "air"]);
    const read = f.bot.blockAt.bind(f.bot);
    f.bot.blockAt = position => {
      const block = read(position);
      if (key(position) === "0,90,0") f.bot.interrupt_code = true;
      return block;
    };
    assert.equal(await f.run(), false, f.logs.join("; "));
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.modes, []);
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("raise discovery deadline cannot return an early site", async t => {
  const { performance } = await import("node:perf_hooks");
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const previous = agentSettings.schematic_continuation_policy;
  agentSettings.schematic_continuation_policy = "deny";
  try {
    const f = fixture(["stone", "air"]);
    const read = f.bot.blockAt.bind(f.bot);
    f.bot.blockAt = position => {
      const block = read(position);
      if (key(position) === "0,90,0") now = 2001;
      return block;
    };
    assert.equal(await f.run(), false, f.logs.join("; "));
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.modes, []);
    assert.match(f.logs.join(" "), /timed out/i);
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("raise can select a later site supported above a protected matching volume", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  agentSettings.schematic_continuation_policy = "deny";
  try {
    const f = fixture(["stone", "air"]);
    f.world.set("0,64,0", "stone");
    f.world.set("0,65,0", "dirt"); f.world.set("1,65,0", "dirt");
    assert.equal(await f.run(), true, f.logs.join("; "));
    assert.match(f.logs.join(" "), /origin 0,66,0/);
    assert.deepEqual(f.writes, [["0,66,0", "stone"]]);
    assert.equal(f.bot.blockAt(new Vec3(0,64,0)).name, "stone");
    assert.equal(f.bot.blockAt(new Vec3(1,64,0)).name, "air");
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("raise translates a rotated footprint and its air cells without decoding twice", async () => {
  const f = fixture(["stone", "air"]);
  f.dependencies.placementOptions = { ...f.dependencies.placementOptions, orientation: "east" };
  let reads = 0;
  const getBlock = f.schematic.getBlock;
  f.schematic.getBlock = p => { reads++; return getBlock(p); };
  f.world.set("0,64,0", "dirt");
  assert.equal(await f.run(), true, f.logs.join("; "));
  assert.equal(reads, 2);
  assert.deepEqual(f.writes, [["0,64,1", "dirt"], ["0,65,0", "stone"]]);
  assert.match(f.logs.join(" "), /origin 0,65,0/);
  assert.equal(f.bot.blockAt(new Vec3(0, 65, 1)).name, "air");
});

test("raise mode refuses unverified bounds, unsafe neighbors and unreachable placement before Creative", async () => {
  for (const change of [f => { delete f.bot.registry.dimensionsByName.overworld; },
    f => { f.bot.game.height = 256; },
    f => { f.bot.game.height = 130; f.bot.registry.dimensionsByName.overworld.height = 130; },
    f => f.world.set("-1,64,0", "chest"), f => { f.bot.entity.position = new Vec3(-20, 64, 0); }]) {
    const f = fixture(); change(f);
    assert.equal(await f.run(), false, f.logs.join("; "));
    assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []); assert.deepEqual(f.slots, []);
  }
});

test("raise mode rechecks site after Creative transition before any placement", async () => {
  const f = fixture();
  f.dependencies.onTransition = mode => { if (mode === "creative") f.world.set("-1,64,0", "chest"); };
  assert.equal(await f.run(), false);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.slots, []);
  assert.deepEqual(f.modes, ["creative", "survival"]);
});

test("raise final packet authorization refuses a site changed during native aiming", async () => {
  const f = fixture();
  f.dependencies.onAim = () => { f.world.set("-1,64,0", "chest"); };
  assert.equal(await f.run(), false);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.modes, ["creative", "survival"]);
  assert.match(f.logs.join(" "), /site changed|unsupported/i);
});

test("raise confirmation revalidates the exact prefix before further writes", async () => {
  const f = fixture(); f.world.set("0,64,0", "dirt");
  f.dependencies.onConfirm = () => { f.world.set("1,65,0", "stone"); };
  assert.equal(await f.run(), false);
  assert.deepEqual(f.writes, [["1,64,0", "dirt"]]);
  assert.match(f.logs.join(" "), /site changed/i);
  assert.deepEqual(f.modes, ["creative", "survival"]);
});

test("raise interruption never enables managed auto-resume", async () => {
  const f = fixture();
  const session = { cancelled: false, resumeEligible: false };
  f.dependencies.resumeSession = session;
  f.dependencies.onAim = () => { f.bot.interrupt_code = true; };
  assert.equal(await f.run(), false);
  assert.deepEqual(f.writes, []);
  assert.equal(session.resumeEligible, false);
  assert.equal(session.cancelled, true);
  assert.equal(session.context, null);
});

test("an unconfirmed raise placement quarantines subsequent authorized writes", async () => {
  const f = fixture(["stone"]); f.dependencies.noConfirmation = true;
  assert.equal(await f.run(), false);
  assert.deepEqual(f.writes, [["0,64,0", "stone"]]);
  f.dependencies.noConfirmation = false;
  assert.equal(await f.run(), false);
  assert.deepEqual(f.writes, [["0,64,0", "stone"]]);
  assert.match(f.logs.join(" "), /lacks server confirmation|still settling/i);
});
