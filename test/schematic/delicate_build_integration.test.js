import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers";
import { buildSchematic, continueSchematic } from "../../src/utils/schematic/build_schematic.js";
import { loadSchematicBuilder } from "../../src/utils/schematic/builder_compat.js";
import { resolvePlacementOptions } from "../../src/utils/schematic/placement_options.js";
import { createModernBuild } from "../../src/utils/schematic/modern_build.js";
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

test("ordinary delicate build refuses a partial match before mode or inventory changes", async () => {
  const f = fixture(["stone", "stone", "air"]); f.world.set("0,64,0", "stone");
  assert.equal(await f.run(), false, f.logs.join("; "));
  assert.deepEqual(f.writes, []);
  assert.equal(f.world.get("0,64,0"), "stone");
  assert.deepEqual(f.modes, []);
  assert.deepEqual(f.slots, []);
  assert.equal(f.bot.inventory.slots[36], null);
  assert.match(f.logs.join(" "), /partial; exact=1, missing=1, air=1/);
});

test("ordinary delicate build refuses a complete match without mutation", async () => {
  const f = fixture(["stone", "air"]); f.world.set("0,64,0", "stone");
  assert.equal(await f.run(), false, f.logs.join("; "));
  assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []); assert.deepEqual(f.slots, []);
  assert.match(f.logs.join(" "), /complete; exact=1/);
});

test("detection policies refuse implicit reuse, including rotated plans", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  try {
    for (const policy of ["ask", "allow", "deny"]) {
      agentSettings.schematic_continuation_policy = policy;
      const f = fixture(["air", "stone"]);
      f.dependencies.placementOptions = { ...resolvePlacementOptions(), orientation: "east" };
      f.world.set("0,64,1", "stone");
      assert.equal(await f.run(), false, `${policy}: ${f.logs.join("; ")}`);
      assert.match(f.logs.join(" "), /exact=1/);
      assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []); assert.deepEqual(f.slots, []);
    }
  } finally {
    if (previous === undefined) delete agentSettings.schematic_continuation_policy;
    else agentSettings.schematic_continuation_policy = previous;
  }
});

test("unloaded cells cannot conceal a match", async () => {
  const f = fixture(["stone"]); f.world.set("0,64,0", null);
  assert.equal(await f.run(), false);
  assert.match(f.logs.join(" "), /cannot inspect|unknown/i);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []); assert.deepEqual(f.slots, []);
});

test("off restores legacy match handling", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  try {
    agentSettings.schematic_continuation_policy = "off";
    const f = fixture(["stone", "stone", "air"]); f.world.set("0,64,0", "stone");
    assert.equal(await f.run(), true, f.logs.join("; "));
    assert.deepEqual(f.writes, [["1,64,0", "stone"]]);
    assert.equal(f.world.get("0,64,0"), "stone");
    assert.deepEqual(f.modes, ["creative", "survival"]);
    const complete = fixture(["stone", "air"]); complete.world.set("0,64,0", "stone");
    assert.equal(await complete.run(), true, complete.logs.join("; "));
    assert.deepEqual(complete.modes, []); assert.deepEqual(complete.slots, []);
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("direct continuation and forged authorization fail closed", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  try {
    for (const policy of ["ask", "deny", "off"]) {
      agentSettings.schematic_continuation_policy = policy;
      const f = fixture(["stone"]); f.world.set("0,64,0", "stone");
      assert.equal(await continueSchematic(f.bot, "delicate.schem", 0, 64, 0, f.dependencies), false);
      assert.match(f.logs.join(" "), /policy/); assert.deepEqual(f.modes, []);
    }
    agentSettings.schematic_continuation_policy = "allow";
    for (const forged of [undefined, {}, Object.freeze({}), () => true]) {
      const f = fixture(["stone", "stone"]); f.world.set("0,64,0", "stone");
      f.dependencies.continuationGrant = forged;
      f.dependencies.continuationAuthorizationCurrent = () => true;
      assert.equal(await continueSchematic(f.bot, "delicate.schem", 0, 64, 0, f.dependencies), false);
      assert.match(f.logs.join(" "), /authorization/i);
      assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []); assert.deepEqual(f.slots, []);
    }
    const invalid = fixture(["stone"]); invalid.world.set("0,64,0", "stone");
    assert.equal(await continueSchematic(invalid.bot, "delicate.schem", null, 64, 0, invalid.dependencies), false);
    assert.deepEqual(invalid.modes, []);
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("caller-supplied recovery data cannot authorize an existing match", async () => {
  const f = fixture(["stone"]); f.world.set("0,64,0", "stone");
  f.dependencies.resumeSession = { cancelled: false, resumeEligible: true,
    context: { planContract: "rotated-local-v1", placementOptions: resolvePlacementOptions() } };
  assert.equal(await f.run(), false);
  assert.match(f.logs.join(" "), /not an eligible unmodified session/);
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

test("early interrupted recovery still rejects matching sites under every detection policy", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  try {
    for (const policy of ["deny", "ask", "allow"]) {
      agentSettings.schematic_continuation_policy = policy;
      const f = fixture();
      const session = f.dependencies.resumeSession = { cancelled: false };
      f.world.set("0,64,0", "stone");
      f.bot.interrupt_code = true;
      assert.equal(await f.run(), false, policy);
      assert.equal(session.resumeEligible, true, policy);
      assert.deepEqual(f.modes, []); assert.deepEqual(f.slots, []);
      // A public field cannot claim that the private preflight succeeded.
      session.preflightPassed = true;
      f.bot.interrupt_code = false;
      assert.equal(await f.run(), false, `${policy}: ${f.logs.join("; ")}`);
      assert.match(f.logs.join(" "), /existing matching blocks cannot be reused/i);
      assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []); assert.deepEqual(f.slots, []);
      assert.equal(f.world.get("0,64,0"), "stone");
      assert.equal(f.bot.blockAt(new Vec3(1, 64, 0)).name, "air");
      assert.equal(session.resumeEligible, false);
    }
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("repeated early interruptions can recover an empty fixed-origin site", async () => {
  const f = fixture();
  const session = f.dependencies.resumeSession = { cancelled: false };
  f.bot.interrupt_code = true;
  for (let i = 0; i < 2; i++) {
    assert.equal(await f.run(), false, f.logs.join("; "));
    assert.equal(session.resumeEligible, true);
    assert.deepEqual(session.context.origin, { x: 0, y: 64, z: 0 });
  }
  assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []); assert.deepEqual(f.slots, []);
  f.bot.interrupt_code = false;
  assert.equal(await f.run(), true, f.logs.join("; "));
  assert.deepEqual(f.writes, [["0,64,0", "stone"], ["1,64,0", "stone"]]);
});

test("early recovery checks the live saved site, not only the original snapshot", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  try {
    agentSettings.schematic_continuation_policy = "deny";
    const f = fixture();
    const session = f.dependencies.resumeSession = { cancelled: false };
    f.bot.interrupt_code = true;
    assert.equal(await f.run(), false);
    assert.equal(session.resumeEligible, true);
    f.world.set("0,64,0", "stone");
    f.bot.interrupt_code = false;
    assert.equal(await f.run(), false, f.logs.join("; "));
    assert.match(f.logs.join(" "), /existing matching blocks cannot be reused|refusing unsafe resume/i);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []); assert.deepEqual(f.slots, []);
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("off policy permits repeated managed recovery of observed placements", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  agentSettings.schematic_continuation_policy = "off";
  try {
  const f = fixture();
  const session = f.dependencies.resumeSession = { cancelled: false };
  let aims = 0;
  f.dependencies.onAim = () => { if (++aims === 2) f.bot.interrupt_code = true; };
  assert.equal(await f.run(), false, f.logs.join("; "));
  assert.equal(session.resumeEligible, true);
  assert.deepEqual(f.writes, [["0,64,0", "stone"]]);
  f.bot.interrupt_code = false;
  f.dependencies.onAim = () => { f.bot.interrupt_code = true; };
  assert.equal(await f.run(), false, f.logs.join("; "));
  assert.equal(session.resumeEligible, true, f.logs.join("; "));
  assert.deepEqual(f.writes, [["0,64,0", "stone"]]);
  f.bot.interrupt_code = false;
  delete f.dependencies.onAim;
  assert.equal(await f.run(), true, f.logs.join("; "));
  assert.deepEqual(f.writes, [["0,64,0", "stone"], ["1,64,0", "stone"]]);
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("passed recovery preflight rejects externally placed matches but off retains legacy behavior", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  try {
    for (const policy of ["deny", "ask", "allow", "off"]) {
      agentSettings.schematic_continuation_policy = policy;
      const f = fixture();
      const session = f.dependencies.resumeSession = { cancelled: false };
      f.dependencies.onAim = () => { f.bot.interrupt_code = true; };
      assert.equal(await f.run(), false, policy);
      assert.equal(session.resumeEligible, true, policy);
      assert.deepEqual(f.writes, []);
      f.world.set("0,64,0", "stone");
      // Public fields cannot manufacture evidence in the private record.
      session.placements = new Set(["0,64,0"]);
      f.bot.interrupt_code = false; delete f.dependencies.onAim;
      const modes = f.modes.length, slots = f.slots.length;
      assert.equal(await f.run(), policy === "off", `${policy}: ${f.logs.join("; ")}`);
      if (policy === "off") assert.deepEqual(f.writes, [["1,64,0", "stone"]]);
      else {
        assert.match(f.logs.join(" "), /refusing unsafe resume/i);
        assert.deepEqual(f.writes, []);
        assert.equal(f.modes.length, modes); assert.equal(f.slots.length, slots);
        assert.equal(session.resumeEligible, false); assert.equal(session.cancelled, true);
      }
    }
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("detection policies refuse reuse of observed delicate placements from an earlier attempt", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  try {
    for (const policy of ["deny", "ask", "allow"]) {
      agentSettings.schematic_continuation_policy = policy;
      const f = fixture(["stone", "stone", "stone"]);
      f.bot.entity.position = new Vec3(-1.31, 63.5, 0.5);
      const session = f.dependencies.resumeSession = { cancelled: false };
      let aims = 0;
      f.dependencies.onAim = () => { if (++aims === 2) f.bot.interrupt_code = true; };
      assert.equal(await f.run(), false, f.logs.join("; "));
      assert.equal(session.resumeEligible, false, policy);
      assert.equal(session.cancelled, true, policy);
      assert.equal(session.context, null, policy);
      assert.match(f.logs.join(" "), /recovery refused: prior placement updates cannot be attributed/i);
      assert.match(f.logs.join(" "), /review the original source, origin, orientation and world/i);
      assert.deepEqual(f.writes, [["0,64,0", "stone"]]);
    }
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("delicate recovery refuses another actor's post-reference matching update", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  try {
    for (const policy of ["deny", "ask", "allow"]) {
      agentSettings.schematic_continuation_policy = policy;
      const f = fixture(["stone", "stone"]);
      const session = f.dependencies.resumeSession = { cancelled: false };
      const originalWrite = f.bot._client.write;
      const phases = [];
      f.bot.on("schematicEditAuthorization", event => phases.push(event.phase));
      f.bot._client.write = (name, packet) => {
        if (name !== "block_place" || f.writes.length) return originalWrite(name, packet);
        const target = packet.location.offset(0, 1, 0);
        f.writes.push([key(target), "packet"]);
        setImmediate(() => {
          const reference = f.bot.blockAt(packet.location);
          f.bot.emit(`blockUpdate:${packet.location}`, reference, reference);
          f.bot._client.emit("block_change", { location: packet.location, type: reference.stateId });
          // A separate actor changes the destination after the reference reply.
          const old = f.bot.blockAt(target);
          f.world.set(key(target), "stone");
          const actual = f.bot.blockAt(target);
          f.bot.emit(`blockUpdate:${target}`, old, actual);
          f.bot._client.emit("block_change", { location: target, type: actual.stateId });
        });
      };
      let aims = 0;
      f.dependencies.onAim = () => { if (++aims === 2) f.bot.interrupt_code = true; };
      assert.equal(await f.run(), false, f.logs.join("; "));
      assert.equal(session.resumeEligible, false, policy);
      assert.equal(session.cancelled, true, policy);
      assert.ok(phases.includes("server-confirmed"), "ordered observations are not proof of actor ownership");
      assert.match(f.logs.join(" "), /recovery refused: prior placement updates cannot be attributed/i);
      assert.deepEqual(f.writes, [["0,64,0", "packet"]]);
      assert.equal(f.world.get("1,64,0"), undefined);
    }
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("recovery rechecks placement proof after asynchronous Creative transition", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  try {
    agentSettings.schematic_continuation_policy = "deny";
    const f = fixture();
    const session = f.dependencies.resumeSession = { cancelled: false };
    f.dependencies.onAim = () => { f.bot.interrupt_code = true; };
    assert.equal(await f.run(), false); assert.equal(session.resumeEligible, true);
    f.bot.interrupt_code = false; delete f.dependencies.onAim;
    f.dependencies.onTransition = mode => { if (mode === "creative") f.world.set("0,64,0", "stone"); };
    assert.equal(await f.run(), false, f.logs.join("; "));
    assert.match(f.logs.join(" "), /refusing unsafe resume/i);
    assert.deepEqual(f.writes, []); assert.equal(session.resumeEligible, false);
    assert.equal(f.bot.inventory.slots[36], null);
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("delicate recovery inspection reads scale linearly with volume", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  try {
    agentSettings.schematic_continuation_policy = "deny";
    const counts = [];
    for (const size of [64, 128]) {
      const f = fixture(["stone", ...Array(size - 1).fill("air")]);
      const session = f.dependencies.resumeSession = { cancelled: false };
      f.dependencies.onAim = () => { f.bot.interrupt_code = true; };
      assert.equal(await f.run(), false, f.logs.join("; "));
      assert.equal(session.resumeEligible, true, f.logs.join("; "));
      f.bot.interrupt_code = false;
      let reads = 0;
      const blockAt = f.bot.blockAt;
      f.bot.blockAt = function (position) { reads++; return blockAt.call(this, position); };
      assert.equal(await f.run(), false, f.logs.join("; "));
      assert.equal(session.resumeEligible, true, f.logs.join("; "));
      counts.push(reads);
    }
    assert.ok(counts[1] < counts[0] * 2.5, `recovery reads: ${counts.join(", ")}`);
    assert.ok(counts[1] < 25000, `recovery reads: ${counts.join(", ")}`);
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("delicate interrupted dispatched but unconfirmed placement is not recoverable", async () => {
  const f = fixture(["stone"]);
  const session = f.dependencies.resumeSession = { cancelled: false };
  f.dependencies.noConfirmation = true;
  const write = f.bot._client.write;
  f.bot._client.write = (name, packet) => {
    write(name, packet);
    if (name === "block_place") f.bot.interrupt_code = true;
  };
  assert.equal(await f.run(), false, f.logs.join("; "));
  assert.equal(f.writes.length, 1);
  assert.equal(session.resumeEligible, false);
  assert.equal(session.cancelled, true);
  assert.equal(session.context, null);
});

test("delicate cancelled undelivered aim preserves recovery while its writer is revoked", async () => {
  const f = fixture(["stone"]);
  const session = f.dependencies.resumeSession = { cancelled: false };
  let started, release;
  const aiming = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.dependencies.onAim = () => { started(); return gate; };
  const first = f.run();
  await aiming;
  f.bot.interrupt_code = true;
  assert.equal(await first, false, f.logs.join("; "));
  assert.equal(session.resumeEligible, true, f.logs.join("; "));
  assert.deepEqual(f.writes, []);
  release();
  await new Promise(resolve => setImmediate(resolve));
  f.bot.interrupt_code = false;
  delete f.dependencies.onAim;
  assert.equal(await f.run(), true, f.logs.join("; "));
  assert.deepEqual(f.writes, [["0,64,0", "stone"]]);
});

test("early recovery rejects tampering with the saved origin or world snapshot", async () => {
  for (const mutate of [
    session => { session.context.origin.x = 1; },
    session => { session.context.originalStates[0].name = "air"; },
  ]) {
    const f = fixture(); f.world.set("0,64,0", "stone");
    const session = f.dependencies.resumeSession = { cancelled: false };
    f.bot.interrupt_code = true;
    assert.equal(await f.run(), false);
    assert.equal(session.resumeEligible, true);
    mutate(session);
    f.bot.interrupt_code = false;
    assert.equal(await f.run(), false);
    assert.match(f.logs.join(" "), /not an eligible unmodified session/i);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []); assert.deepEqual(f.slots, []);
  }
});

test("recovery is bound to its original continuation policy, including legacy off", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  try {
    for (const [initial, next, phase] of [["off", "deny", "early"], ["off", "deny", "passed"], ["deny", "allow", "passed"]]) {
      agentSettings.schematic_continuation_policy = initial;
      const f = fixture();
      const session = f.dependencies.resumeSession = { cancelled: false };
      if (initial === "off") f.world.set("0,64,0", "stone");
      if (phase === "early") f.bot.interrupt_code = true;
      else f.dependencies.onAim = () => { f.bot.interrupt_code = true; };
      assert.equal(await f.run(), false, f.logs.join("; "));
      assert.equal(session.resumeEligible, true);
      f.bot.interrupt_code = false; delete f.dependencies.onAim;
      const writes = f.writes.length, modes = f.modes.length, slots = f.slots.length;
      agentSettings.schematic_continuation_policy = next;
      assert.equal(await f.run(), false, f.logs.join("; "));
      assert.match(f.logs.join(" "), /policy changed since the interrupted build/i);
      assert.equal(f.writes.length, writes); assert.equal(f.modes.length, modes); assert.equal(f.slots.length, slots);
      assert.equal(session.resumeEligible, false);
    }
    agentSettings.schematic_continuation_policy = "off";
    const legacy = fixture(); legacy.world.set("0,64,0", "stone");
    const session = legacy.dependencies.resumeSession = { cancelled: false };
    legacy.bot.interrupt_code = true;
    assert.equal(await legacy.run(), false);
    assert.equal(session.resumeEligible, true);
    legacy.bot.interrupt_code = false;
    assert.equal(await legacy.run(), true, legacy.logs.join("; "));
    assert.deepEqual(legacy.writes, [["1,64,0", "stone"]]);
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("policy changes during recovery stop placement and revoke the session", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  try {
    for (const phase of ["onTransition", "onAim"]) {
      agentSettings.schematic_continuation_policy = "off";
      const f = fixture(); f.world.set("0,64,0", "stone");
      const session = f.dependencies.resumeSession = { cancelled: false };
      f.bot.interrupt_code = true;
      assert.equal(await f.run(), false);
      f.bot.interrupt_code = false;
      f.dependencies[phase] = () => { agentSettings.schematic_continuation_policy = "deny"; };
      assert.equal(await f.run(), false, f.logs.join("; "));
      assert.deepEqual(f.writes, []);
      assert.equal(session.resumeEligible, false);
      assert.equal(session.cancelled, true);
      assert.match(f.logs.join(" "), /policy changed/i);
      assert.equal(f.bot.inventory.slots[36], null);
    }
  } finally { agentSettings.schematic_continuation_policy = previous; }
});

test("policy change after legacy preflight prevents the original build from placing", async () => {
  const previous = agentSettings.schematic_continuation_policy;
  try {
    agentSettings.schematic_continuation_policy = "off";
    const f = fixture(); f.world.set("0,64,0", "stone");
    const session = f.dependencies.resumeSession = { cancelled: false };
    f.dependencies.onTransition = mode => { if (mode === "creative") agentSettings.schematic_continuation_policy = "deny"; };
    assert.equal(await f.run(), false, f.logs.join("; "));
    assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, ["creative", "survival"]);
    assert.equal(session.resumeEligible, false);
    assert.match(f.logs.join(" "), /policy changed/i);
  } finally { agentSettings.schematic_continuation_policy = previous; }
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
