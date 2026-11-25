import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers";
import { buildSchematic, buildTrustedDestructiveSchematic } from "../../src/utils/schematic/build_schematic.js";
import { resolvePlacementOptions } from "../../src/utils/schematic/placement_options.js";
import { provenanceFixtureDependencies } from "./provenance_fixture.js";
import { authorizedGameplayEdit } from "../../src/utils/schematic/authorized_gameplay_edit.js";
import { captureSchematicAttemptIdentity, isSchematicAttemptIdentityCurrent } from "../../src/utils/schematic/obstruction_policy.js";
import { acquireBuildLifecycle, runBuild } from "../../src/utils/schematic/run_build.js";

const require = createRequire(import.meta.url);
const Vec3 = require("vec3");
const data = require("minecraft-data")("1.18.2");
const key = p => `${p.x},${p.y},${p.z}`;

function fixture(names = ["cobblestone", "air", "stone", "air"], width = names.length, version = "1.18.2") {
  const data = require("minecraft-data")(version);
  const Block = require("prismarine-block")(version);
  const world = new Map();
  const writes = [], logs = [], modes = [];
  const entity = { position: new Vec3(100, 64, 100), width: 0.6, height: 1.8 };
  const bot = Object.assign(new EventEmitter(), {
    version, registry: data, game: { gameMode: "survival", dimension: "overworld" },
    world: {}, _client: Object.assign(new EventEmitter(), { socket: {} }), entity, entities: { 1: entity },
    interrupt_code: false,
    supportFeature: data.supportFeature,
    digTime: () => dependencies.digTimeMs ?? 0,
    heldItem: { name: names.find(name => name !== "air") ?? "stone" },
    async lookAt() { await dependencies.onAim?.(); },
    swingArm() {},
    blockAt(position) {
      const value = world.has(key(position)) ? world.get(key(position)) : position.y === 63 ? "dirt" : "air";
      if (value == null) return null;
      if (typeof value === "object") return { ...value, position };
      const block = Block.fromStateId(data.blocksByName[value].defaultState, 0);
      block.position = position;
      return block;
    },
    async dig(block) { writes.push(["dig", key(block.position)]); world.set(key(block.position), "air"); await dependencies.onDig?.(block); },
    placeBlock(reference, face) {
      const position = reference.position.plus(face);
      writes.push(["place", key(position)]);
      world.set(key(position), names[position.x]);
    },
    pathfinder: {
      movements: { canDig: true, scafoldingBlocks: [1] },
      setMovements(movements) { this.movements = movements; },
      async goto() {
        assert.equal(this.movements.canDig, false);
        assert.deepEqual(this.movements.scafoldingBlocks, []);
        await dependencies.onNavigate?.();
      },
    },
    builder: {
      async build(build) {
        await dependencies.onBuilder?.(build);
        for (const cell of build.cells) {
          const position = new Vec3(cell.position.x, cell.position.y, cell.position.z);
          if (cell.name !== "air" && bot.blockAt(position).name === "air") {
            bot.heldItem = { name: cell.name };
            await bot.placeBlock({ position: position.offset(0, -1, 0) }, new Vec3(0, 1, 0));
          }
        }
        build.actions.length = 0;
      },
      async clearArea() {},
    },
  });
  const palette = names.map(name => data.blocksByName[name].defaultState);
  const schematic = { version, size: new Vec3(width, 1, names.length / width), offset: new Vec3(0, 0, 0), palette,
    blocks: names.map((_, i) => i), getBlock: p => Block.fromStateId(palette[p.x + p.z * width], 0) };
  const dependencies = provenanceFixtureDependencies({
    resolvePath: () => `/schematics/test.mc${version}.schem`, fsAccess: () => {}, fsReadFile: () => Buffer.from("synthetic"),
    validateSource: () => {}, SchematicClass: { read: () => schematic },
    placementOptions: resolvePlacementOptions({ schematic_placement_mode: "destructive" }),
    changeGameMode: async (_bot, mode) => {
      modes.push(mode);
      if (mode === "creative" && dependencies.denyCreative) return false;
      bot.game.gameMode = mode;
      if (mode === "creative") await dependencies.onTransition?.();
      return true;
    },
    startSupply: () => { const cleanup = () => {}; cleanup.cancel = () => {}; return cleanup; },
    executeBuild: (bot, build, options) => runBuild(bot, build, { ...options, pollMs: 1, graceMs: 10 }),
    writeLog: message => logs.push(message),
  });
  // The installed native plugins issue real gameplay API packets into this
  // simulated transport. Only an inbound packet updates this fixture's world.
  const inbound = (position, name) => {
    const oldBlock = bot.blockAt(position);
    world.set(key(position), name);
    const newBlock = bot.blockAt(position);
    bot.emit(`blockUpdate:${position}`, oldBlock, newBlock);
    bot._client.emit("block_change", { location: position, type: newBlock.stateId });
  };
  const inboundSection = (position, name) => {
    const oldBlock = bot.blockAt(position);
    world.set(key(position), name);
    const newBlock = bot.blockAt(position);
    bot.emit(`blockUpdate:${position}`, oldBlock, newBlock);
    bot._client.emit("multi_block_change", {
      chunkCoordinates: { x: Math.floor(position.x / 16), y: Math.floor(position.y / 16), z: Math.floor(position.z / 16) },
      records: [newBlock.stateId * 4096 + (position.x & 15) * 256 + (position.z & 15) * 16 + (position.y & 15)],
    });
  };
  const acknowledge = (position, { status = 0, name = "air", successful = true } = {}) => {
    bot._client.emit("acknowledge_player_digging", {
      location: position, block: data.blocksByName[name].defaultState, status, successful,
    });
  };
  bot._client.write = (name, packet) => {
    dependencies.onWrite?.(name, packet);
    if (name === "block_dig" && packet.status === 0) {
      writes.push(["dig", key(packet.location)]);
      if (!dependencies.noConfirmation) setImmediate(async () => {
        await dependencies.onDig?.(bot.blockAt(packet.location));
        inbound(packet.location, "air");
        acknowledge(packet.location);
      });
    } else if (name === "block_dig" && packet.status === 2) {
      // The native zero-delay timer can dispatch finish before the scheduled
      // start response. Every dispatched action still needs its own reply.
      if (!dependencies.noConfirmation) setImmediate(() => {
        inbound(packet.location, "air");
        acknowledge(packet.location, { status: 2 });
      });
    } else if (name === "block_place") {
      const offsets = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
      const position = packet.location.offset(...offsets[packet.direction]);
      writes.push(["place", key(position)]);
      if (!dependencies.noConfirmation) setImmediate(() => {
        inbound(packet.location, bot.blockAt(packet.location).name);
        inbound(position, bot.heldItem.name);
      });
    }
  };
  return { bot, world, writes, logs, modes, dependencies, inbound, inboundSection, acknowledge,
    run: () => buildTrustedDestructiveSchematic(bot, "test.schem", 0, 64, 0, dependencies),
    publicRun: () => buildSchematic(bot, "test.schem", 0, 64, 0, dependencies) };
}

test("trusted fixed-anchor build clears reviewed mismatches and places while preserving exact matches and outside", async () => {
  const f = fixture();
  f.world.set("0,64,0", "dirt");
  f.world.set("1,64,0", "stone");
  f.world.set("2,64,0", "stone");
  f.world.set("4,64,0", "stone");
  assert.equal(await f.run(), true, f.logs.join("; "));
  assert.deepEqual(f.writes, [["dig", "0,64,0"], ["dig", "1,64,0"], ["place", "0,64,0"]]);
  assert.equal(f.world.get("2,64,0"), "stone");
  assert.equal(f.world.get("4,64,0"), "stone");
  assert.equal(f.bot.pathfinder.movements.canDig, true);
});

test("public build cannot obtain destructive authorization from request data", async () => {
  const f = fixture();
  f.world.set("0,64,0", "dirt");
  Object.assign(f.dependencies, { trusted: true, authorized: true, destructive: true, clearingQualification: () => true });
  assert.equal(await f.publicRun(), false);
  assert.match(f.logs.join(" "), /destructive.*unavailable/i);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.modes, []);
});

test("protected, unloaded, unsupported targets, unsafe neighbors and occupied sites fail before editing", async () => {
  for (const [position, value] of [["0,64,0", "chest"], ["0,64,0", null], ["1,64,0", "diamond_ore"],
    ["0,63,0", "sand"], ["4,64,0", "water"], ["4,64,0", null]]) {
    const f = fixture();
    f.world.set("0,64,0", "dirt");
    f.world.set(position, value);
    assert.equal(await f.run(), false, `${position} ${value}`);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.modes, []);
  }
  const target = fixture(["redstone_block"]);
  target.world.set("0,64,0", "dirt");
  assert.equal(await target.run(), false);
  assert.deepEqual(target.writes, []);
  const occupied = fixture();
  occupied.world.set("0,64,0", "dirt");
  occupied.bot.entities[2] = { position: new Vec3(0.5, 64, 0.5), width: 0.6, height: 1.8 };
  assert.equal(await occupied.run(), false);
  assert.deepEqual(occupied.writes, []);
});

test("Creative denial and stale world, target, neighbor, entity, and identity abort without writes", async () => {
  const cases = [
    f => { f.dependencies.denyCreative = true; },
    f => { f.dependencies.changeGameMode = () => true; },
    f => { f.dependencies.onTransition = () => f.world.set("0,64,0", "stone"); },
    f => { f.dependencies.onTransition = () => f.world.set("4,64,0", "stone"); },
    f => { f.dependencies.onTransition = () => { f.bot.entities[2] = { position: new Vec3(0.5, 64, 0.5), width: 0.6, height: 1.8 }; }; },
    f => { f.dependencies.onTransition = () => { f.bot.world = {}; }; },
    f => { f.dependencies.onNavigate = () => f.world.set("0,64,0", "stone"); },
    f => { f.dependencies.onNavigate = () => f.world.set("0,64,0", { name: "dirt", diggable: true, getProperties: () => ({}), nbt: {} }); },
    f => { f.dependencies.onNavigate = () => f.world.set("4,64,0", "water"); },
    f => { f.dependencies.onNavigate = () => { f.bot.game.gameMode = "survival"; }; },
  ];
  for (const setup of cases) {
    const f = fixture();
    f.world.set("0,64,0", "dirt");
    setup(f);
    assert.equal(await f.run(), false, f.logs.join("; "));
    assert.deepEqual(f.writes, []);
  }
});

test("guard rejects builder digs of matching and out-of-volume terrain", async () => {
  for (const position of [new Vec3(2, 64, 0), new Vec3(4, 64, 0)]) {
    const f = fixture();
    f.world.set("2,64,0", "stone");
    f.world.set("4,64,0", "stone");
    f.dependencies.onBuilder = () => f.bot.dig(f.bot.blockAt(position));
    assert.equal(await f.run(), false);
    assert.deepEqual(f.writes, []);
    assert.equal(f.world.get(key(position)), "stone");
    assert.match(f.logs.join(" "), /unapproved|outside/i);
  }
});

test("post-navigation and final guarded reads independently reapply the terrain classifier", async () => {
  for (const stage of ["post-navigation", "guarded-dig"]) {
    const f = fixture();
    f.world.set("0,64,0", "dirt");
    const read = f.bot.blockAt.bind(f.bot);
    let injected = false;
    f.bot.blockAt = position => {
      const block = read(position);
      const stack = new Error().stack;
      const targetRead = key(position) === "0,64,0" && (stage === "post-navigation"
        ? stack.includes("clearSchematicObstructions") && !stack.includes("inspectSchematicCell") && !stack.includes("guardedSchematicDig")
        : stack.includes("guardedSchematicDig") && !stack.includes("revalidateBalancedSite"));
      if (targetRead) { block.diggable = false; injected = true; }
      return block;
    };
    assert.equal(await f.run(), false, stage);
    assert.equal(injected, true, stage);
    assert.deepEqual(f.writes, [], stage);
  }
});

test("fixed-site inspection budget fails closed before Creative or editing", async () => {
  const f = fixture(Array(256 * 256).fill("air"), 256);
  assert.equal(await f.run(), false);
  assert.match(f.logs.join(" "), /inspection budget/i);
  assert.deepEqual(f.modes, []);
  assert.deepEqual(f.writes, []);
});

test("interrupted destructive clearing explicitly declines partial-terrain recovery", async () => {
  const f = fixture();
  const session = { cancelled: false };
  f.dependencies.resumeSession = session;
  f.world.set("0,64,0", "dirt");
  f.dependencies.onDig = () => { f.bot.interrupt_code = true; };
  assert.equal(await f.run(), false);
  assert.deepEqual(f.writes, [["dig", "0,64,0"]]);
  assert.equal(session.resumeEligible, false);
  assert.equal(session.context, null);
  assert.match(f.logs.join(" "), /recovery is unavailable.*partial terrain/i);
});

test("an alleged original terrain snapshot cannot authorize resuming from air", async () => {
  const f = fixture();
  const session = { cancelled: false, resumeEligible: true, context: {
    placementOptions: f.dependencies.placementOptions,
    originalStates: [{ position: { x: 0, y: 64, z: 0 }, name: "dirt", properties: {} }],
  } };
  f.dependencies.resumeSession = session;
  assert.equal(await f.run(), false);
  assert.match(f.logs.join(" "), /refusing ambiguous partial terrain resume/i);
  assert.equal(session.cancelled, true);
  assert.equal(session.context, null);
  assert.deepEqual(f.modes, []);
  assert.deepEqual(f.writes, []);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("installed native aim await cannot outlive cancellation, identity, mode, or live-state authorization", async () => {
  const invalidations = [
    ["cancel", f => { f.bot.interrupt_code = true; }],
    ["world", f => { f.bot.world = {}; }],
    ["dimension", f => { f.bot.game.dimension = "the_nether"; }],
    ["respawn generation", f => { f.bot._client.emit("respawn", {}); }],
    ["entity", f => { f.bot.entity = { ...f.bot.entity }; }],
    ["registry", f => { f.bot.registry = { ...data }; }],
    ["connection", f => { f.bot._client.ended = true; }],
    ["death", f => { f.bot.health = 0; }],
    ["mode", f => { f.bot.game.gameMode = "survival"; }],
    ["mode round-trip", f => {
      f.bot.game.gameMode = "survival";
      f.bot.emit("game");
      f.bot.game.gameMode = "creative";
      f.bot.emit("game");
    }],
    ["target", f => { f.world.set("0,64,0", "stone"); }],
    ["target air state", f => { f.world.set("0,64,0", "cave_air"); }],
    ["unloaded target", f => { f.world.set("0,64,0", null); }],
    ["neighbor", f => { f.world.set("1,64,0", "water"); }],
    ["reference", f => { f.world.set("0,63,0", "stone"); }],
    ["same-name state replacement", (f, kind) => {
      const position = new Vec3(0, kind === "dig" ? 64 : 63, 0);
      f.world.set(key(position), { ...f.bot.blockAt(position), stateId: data.blocksByName.stone.defaultState });
    }],
  ];
  for (const kind of ["dig", "place"]) for (const [reason, invalidate] of invalidations) {
    const f = fixture([kind === "dig" ? "air" : "cobblestone"]);
    if (kind === "dig") f.world.set("0,64,0", "dirt");
    const entered = deferred(), aim = deferred();
    f.dependencies.onAim = async () => { entered.resolve(); await aim.promise; };
    const writer = f.bot._client.write;
    const result = f.run();
    await entered.promise;
    invalidate(f, kind);
    aim.resolve();
    assert.equal(await result, false, `${kind}: ${reason}`);
    assert.deepEqual(f.writes, [], `${kind}: ${reason}`);
    assert.equal(f.bot._client.write, writer, "shared packet writer is untouched");
    assert.equal(f.bot._client.listenerCount("block_change"), 0);
    assert.equal(f.bot._client.listenerCount("multi_block_change"), 0);
    assert.equal(f.bot.eventNames().some(name => String(name).startsWith("blockUpdate:")), false);
  }
});

test("placement rechecks the held item and rejects non-cardinal faces", async () => {
  const f = fixture(["cobblestone"]);
  f.dependencies.onAim = () => { f.bot.heldItem = { name: "tnt" }; };
  assert.equal(await f.run(), false);
  assert.deepEqual(f.writes, []);
  assert.match(f.logs.join(" "), /held item/i);

  const invalid = fixture(["cobblestone"]);
  invalid.dependencies.onBuilder = () => invalid.bot.placeBlock(
    invalid.bot.blockAt(new Vec3(-2, 64, 0)), new Vec3(2, 0, 0));
  assert.equal(await invalid.run(), false);
  assert.deepEqual(invalid.writes, []);
  assert.match(invalid.logs.join(" "), /invalid face/i);
});

test("unsettled native aim retains build ownership and a revoked writer cannot edit later", async () => {
  const f = fixture(["air"]);
  f.world.set("0,64,0", "dirt");
  const entered = deferred(), aim = deferred();
  f.dependencies.onAim = async () => { entered.resolve(); await aim.promise; };
  const result = f.run();
  await entered.promise;
  f.bot.interrupt_code = true;
  assert.equal(await result, false);
  f.bot.interrupt_code = false;
  assert.equal(await f.run(), false);
  assert.match(f.logs.join(" "), /still settling/i);
  assert.deepEqual(f.writes, []);
  aim.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(f.writes, [], "late native continuation is revoked");
  f.dependencies.onAim = null;
  assert.equal(await f.run(), true, f.logs.join("; "));
});

function directDig(f, { timeoutMs = 60, position = new Vec3(0, 64, 0) } = {}) {
  f.bot.game.gameMode = "creative";
  f.world.set(key(position), "dirt");
  const identity = captureSchematicAttemptIdentity(f.bot);
  const assertCurrent = () => {
    assert.equal(isSchematicAttemptIdentityCurrent(f.bot, identity), true, "current identity");
    assert.equal(f.bot.interrupt_code, false, "not cancelled");
    assert.equal(f.bot.game.gameMode, "creative", "Creative authorization");
  };
  return authorizedGameplayEdit(f.bot, {
    kind: "dig", block: f.bot.blockAt(position), target: position, identity, timeoutMs,
    assertCurrent, authorize: assertCurrent,
  });
}

test("installed native dig prediction is suppressed and local air events are not server confirmation", async () => {
  for (const localPrediction of [false, true]) {
    const f = fixture(["air"]);
    f.dependencies.noConfirmation = true;
    let predictions = 0;
    f.bot._updateBlockState = () => { predictions++; };
    if (localPrediction) f.dependencies.onWrite = (name, packet) => {
      if (name === "block_dig" && packet.status === 0) setImmediate(() => {
        const before = f.bot.blockAt(packet.location);
        f.world.set(key(packet.location), "air");
        f.bot.emit(`blockUpdate:${packet.location}`, before, f.bot.blockAt(packet.location));
      });
    };
    await assert.rejects(directDig(f), /server-observed.*confirmation/i);
    assert.equal(predictions, 0, "no native timer cache mutation reaches the real bot");
    assert.equal(f.bot._client.listenerCount("block_change"), 0);
    assert.equal(f.bot._client.listenerCount("multi_block_change"), 0);
    assert.equal(f.bot.eventNames().some(name => String(name).startsWith("blockUpdate:")), false);
  }
});

test("native digs require an action-correlated acknowledgement, including after section updates at negative coordinates", async () => {
  for (const update of ["single", "multi", "no-ack", "wrong-position", "wrong-state", "pre-write"]) {
    const f = fixture(["air"]);
    f.dependencies.noConfirmation = true;
    const position = new Vec3(-1, 64, -2);
    const diagnostics = [];
    f.bot.on("schematicEditAuthorization", event => diagnostics.push(event.phase));
    const inbound = () => {
      if (update === "multi") {
        const before = f.bot.blockAt(position);
        f.world.set(key(position), "air");
        f.bot.emit(`blockUpdate:${position}`, before, f.bot.blockAt(position));
        f.bot._client.emit("multi_block_change", {
          chunkCoordinates: { x: -1, y: 4, z: -1 }, records: [(15 << 8) | (14 << 4)],
        });
      } else f.inbound(update === "wrong-position" ? position.offset(1, 0, 0) : position,
        update === "wrong-state" ? "stone" : "air");
      if (["single", "multi", "pre-write"].includes(update)) f.acknowledge(position);
    };
    f.dependencies.onWrite = (name, packet) => {
      if (name === "block_dig" && packet.status === 0 && update !== "pre-write") setImmediate(inbound);
      // A zero-delay native finish may be sent before the start reply. Respond
      // to both actions in the positive cases; negative cases remain unacknowledged.
      if (name === "block_dig" && packet.status === 2 && ["single", "multi"].includes(update)) {
        setImmediate(() => f.acknowledge(position, { status: 2 }));
      }
    };
    if (update === "pre-write") f.dependencies.onAim = inbound;
    const result = directDig(f, { position });
    if (["single", "multi"].includes(update)) {
      await result;
      assert.ok(diagnostics.includes("server-confirmed"));
    } else {
      await assert.rejects(result, /server.*confirm/i, update);
      assert.equal(diagnostics.includes("server-confirmed"), false, update);
    }
  }
});

test("native delayed finish reauthorizes and aborts safely instead of throwing from its timer", async () => {
  const f = fixture(["air"]);
  f.dependencies.noConfirmation = true;
  f.dependencies.digTimeMs = 10;
  const statuses = [];
  f.dependencies.onWrite = (name, packet) => {
    if (name !== "block_dig") return;
    statuses.push(packet.status);
    if (packet.status === 0) f.bot.game.gameMode = "survival";
  };
  await assert.rejects(directDig(f), /Creative authorization/);
  assert.deepEqual(statuses, [0, 1], "only start and harmless abort reach the transport");
});

test("a missing reply after native dig finish quarantines later operations even after a late update", async () => {
  const f = fixture(["air"]);
  f.dependencies.noConfirmation = true;
  const statuses = [];
  f.dependencies.onWrite = (name, packet) => {
    if (name === "block_dig") statuses.push(packet.status);
  };
  await assert.rejects(directDig(f), /server-observed.*confirmation/i);
  assert.deepEqual(statuses, [0, 2], "the native finish timer already ran");
  assert.equal(f.world.get("0,64,0"), "dirt");
  await new Promise(setImmediate);
  f.dependencies.noConfirmation = false;
  await assert.rejects(directDig(f), /lacks server confirmation/i);
  f.inbound(new Vec3(0, 64, 0), "air");
  await assert.rejects(directDig(f), /lacks server confirmation/i);
  assert.deepEqual(statuses, [0, 2], "late replies cannot authorize another destructive operation");
});

test("placement requires a known exact expected state before invoking native gameplay", async () => {
  const f = fixture(["cobblestone"]);
  const identity = captureSchematicAttemptIdentity(f.bot);
  await assert.rejects(authorizedGameplayEdit(f.bot, {
    kind: "place", block: f.bot.blockAt(new Vec3(0, 63, 0)), face: new Vec3(0, 1, 0),
    target: new Vec3(0, 64, 0), expectedStateId: undefined, identity, timeoutMs: 30,
    authorize() {}, assertCurrent() {},
  }), /expected.*state/i);
  assert.deepEqual(f.writes, []);
});

test("native placement requires ordered exact inbound states, not local prediction or an unrelated update", async () => {
  for (const update of ["valid", "missing", "local", "wrong-position", "wrong-state", "pre-write", "no-reference"]) {
    const f = fixture(["cobblestone"]);
    f.dependencies.noConfirmation = true;
    f.bot.game.gameMode = "creative";
    const position = new Vec3(0, 64, 0);
    const diagnostics = [];
    f.bot.on("schematicEditAuthorization", event => diagnostics.push(event.phase));
    const inbound = () => {
      if (!["no-reference", "pre-write"].includes(update)) f.inbound(position.offset(0, -1, 0), "dirt");
      if (update === "local") {
        const before = f.bot.blockAt(position);
        f.world.set(key(position), "cobblestone");
        f.bot.emit(`blockUpdate:${position}`, before, f.bot.blockAt(position));
      } else f.inbound(update === "wrong-position" ? position.offset(1, 0, 0) : position,
        update === "wrong-state" ? "stone" : "cobblestone");
    };
    f.dependencies.onWrite = name => {
      if (name === "block_place" && !["missing", "pre-write"].includes(update)) setImmediate(inbound);
    };
    if (update === "pre-write") f.dependencies.onAim = inbound;
    const identity = captureSchematicAttemptIdentity(f.bot);
    const assertCurrent = () => assert.equal(isSchematicAttemptIdentityCurrent(f.bot, identity), true);
    const result = authorizedGameplayEdit(f.bot, {
      kind: "place", block: f.bot.blockAt(position.offset(0, -1, 0)), face: new Vec3(0, 1, 0), target: position,
      expectedStateId: data.blocksByName.cobblestone.defaultState, identity, timeoutMs: 60,
      authorize: assertCurrent, assertCurrent,
    });
    if (update === "valid") {
      await result;
      assert.ok(diagnostics.includes("server-confirmed"));
    } else {
      await assert.rejects(result, /server.*confirm/i, update);
      assert.equal(diagnostics.includes("server-confirmed"), false, update);
    }
    await new Promise(setImmediate);
    assert.equal(f.bot._client.listenerCount("block_change"), 0);
    assert.equal(f.bot._client.listenerCount("multi_block_change"), 0);
    assert.equal(f.bot.listenerCount("game"), 0);
    assert.equal(f.bot.eventNames().some(name => String(name).startsWith("blockUpdate:")), false);
  }
});

function directPlace(f, { position = new Vec3(0, 64, 0), timeoutMs = 80 } = {}) {
  f.bot.game.gameMode = "creative";
  const identity = captureSchematicAttemptIdentity(f.bot);
  const assertCurrent = () => {
    assert.equal(isSchematicAttemptIdentityCurrent(f.bot, identity), true, "current identity");
    assert.equal(f.bot.interrupt_code, false, "not cancelled");
  };
  return authorizedGameplayEdit(f.bot, {
    kind: "place", block: f.bot.blockAt(position.offset(0, -1, 0)), face: new Vec3(0, 1, 0), target: position,
    expectedStateId: f.bot.registry.blocksByName.cobblestone.defaultState, identity, timeoutMs,
    authorize: assertCurrent, assertCurrent,
  });
}

function assertConfirmationListenersClean(f) {
  for (const event of ["block_change", "multi_block_change", "acknowledge_player_digging"]) {
    assert.equal(f.bot._client.listenerCount(event), 0, event);
  }
  assert.equal(f.bot.listenerCount("game"), 0);
  assert.equal(f.bot.eventNames().some(name => String(name).startsWith("blockUpdate:")), false);
}

test("regression: stale matching destination before reference followed by refusal never succeeds", async () => {
  for (const version of ["1.18.2", "1.20.4"]) {
    const f = fixture(["cobblestone"], 1, version);
    f.dependencies.noConfirmation = true;
    const position = new Vec3(0, 64, 0);
    const phases = [];
    f.bot.on("schematicEditAuthorization", event => phases.push(event.phase));
    const staleSent = deferred(), respond = deferred();
    f.dependencies.onWrite = name => {
      if (name !== "block_place") return;
      setImmediate(async () => {
        f.inbound(position, "cobblestone"); // native's type-change waiter can settle here
        staleSent.resolve();
        await respond.promise;
        f.inbound(position.offset(0, -1, 0), "dirt");
        f.inbound(position, "air"); // actual refusal
      });
    };
    let settled = false;
    const result = directPlace(f, { timeoutMs: 500 });
    result.then(() => { settled = true; }, () => { settled = true; });
    await staleSent.promise;
    await new Promise(setImmediate);
    assert.equal(settled, false, version);
    assert.equal(phases.includes("server-confirmed"), false);
    assert.ok(phases.includes("placement-target-before-reference-response"));
    const rejected = assert.rejects(result, /Server did not confirm destructive place/);
    respond.resolve();
    await rejected;
    await new Promise(setImmediate);
    assert.equal(phases.includes("server-confirmed"), false);
    assertConfirmationListenersClean(f);
    await assert.rejects(directPlace(f), /lacks server confirmation/);
  }
});

test("pre-reference destination updates of either state are ignored until an ordered successful reply", async () => {
  for (const stale of ["air", "cobblestone", "stone"]) {
    const f = fixture(["cobblestone"]);
    f.dependencies.noConfirmation = true;
    f.dependencies.onWrite = (name, packet) => {
      if (name === "block_place") setImmediate(() => {
        f.inbound(packet.location.offset(0, 1, 0), stale);
        f.inbound(packet.location, "dirt");
        f.inbound(packet.location.offset(0, 1, 0), "cobblestone");
      });
    };
    // Even if native's type-change waiter settles early, only the later ordered
    // exact-state reply may grant this adapter's independent confirmation.
    await directPlace(f);
    await new Promise(setImmediate);
    assertConfirmationListenersClean(f);
  }
});

test("stale destination followed only by a reference response cannot be reused as placement confirmation", async () => {
  const f = fixture(["cobblestone"]);
  f.dependencies.noConfirmation = true;
  const diagnostics = [];
  f.bot.on("schematicEditAuthorization", event => diagnostics.push(event));
  f.dependencies.onWrite = (name, packet) => {
    if (name === "block_place") setImmediate(() => {
      f.inbound(packet.location.offset(0, 1, 0), "cobblestone");
      f.inbound(packet.location, "dirt");
    });
  };
  await assert.rejects(directPlace(f), /Timed out.*confirmation/);
  assert.ok(diagnostics.some(event => event.phase === "placement-target-before-reference-response"
    && event.confirmationState === "place-awaiting-reference"));
  assert.ok(diagnostics.some(event => event.phase === "placement-reference-observed"
    && event.confirmationState === "place-awaiting-target"));
  assert.equal(diagnostics.some(event => event.phase === "server-confirmed"), false);
  assertConfirmationListenersClean(f);
  await assert.rejects(directPlace(f), /lacks server confirmation/);
});

test("mixed placement transports never reuse a stale target across the reference fence", async () => {
  for (const referenceTransport of ["inbound", "inboundSection"]) {
    for (const targetTransport of ["inbound", "inboundSection"]) {
      for (const reply of ["success", "refusal", "missing"]) {
        const f = fixture(["cobblestone"]);
        f.dependencies.noConfirmation = true;
        const position = new Vec3(-1, -1, -2);
        const diagnostics = [];
        f.bot.on("schematicEditAuthorization", event => diagnostics.push(event));
        const staleSent = deferred(), sendReference = deferred(), referenceSent = deferred(), sendTarget = deferred();
        f.dependencies.onWrite = (name, packet) => {
          if (name !== "block_place") return;
          setImmediate(async () => {
            f[targetTransport](position, "cobblestone");
            staleSent.resolve();
            await sendReference.promise;
            f[referenceTransport](packet.location, "dirt");
            referenceSent.resolve();
            await sendTarget.promise;
            if (reply !== "missing") f[targetTransport](position, reply === "success" ? "cobblestone" : "air");
          });
        };
        let settled = false;
        const result = directPlace(f, { position, timeoutMs: 500 });
        result.then(() => { settled = true; }, () => { settled = true; });
        const checked = reply === "success" ? result : assert.rejects(result,
          reply === "missing" ? /Timed out.*confirmation/ : /Server did not confirm destructive place/);
        await staleSent.promise;
        await new Promise(setImmediate);
        assert.equal(settled, false, "native type-change completion is not confirmation");
        sendReference.resolve();
        await referenceSent.promise;
        await new Promise(setImmediate);
        assert.equal(settled, false, "the reference cannot confirm the retained stale state");
        assert.equal(diagnostics.some(event => event.phase === "server-confirmed"), false);
        sendTarget.resolve();
        await checked;
        const confirmations = diagnostics.filter(event => event.phase === "server-confirmed");
        assert.equal(confirmations.length, reply === "success" ? 1 : 0);
        if (reply === "success") assert.ok(confirmations[0].packetOrder > confirmations[0].referenceOrder);
        assertConfirmationListenersClean(f);
        if (reply !== "success") await assert.rejects(directPlace(f, { position }), /lacks server confirmation/);
      }
    }
  }
});

test("a repeated reference response is ambiguous and cannot establish a new placement fence", async () => {
  const f = fixture(["cobblestone"]);
  f.dependencies.noConfirmation = true;
  const diagnostics = [];
  f.bot.on("schematicEditAuthorization", event => diagnostics.push(event));
  f.dependencies.onWrite = (name, packet) => {
    if (name === "block_place") setImmediate(() => {
      f.inbound(packet.location, "dirt");
      f.inbound(packet.location, "dirt");
      f.inbound(packet.location.offset(0, 1, 0), "cobblestone");
    });
  };
  await assert.rejects(directPlace(f), /ambiguous repeated reference/);
  assert.equal(diagnostics.some(event => event.phase === "server-confirmed"), false);
  assert.equal(diagnostics.filter(event => event.phase === "placement-reference-observed").length, 1);
  assertConfirmationListenersClean(f);
  await assert.rejects(directPlace(f), /lacks server confirmation/);
});

test("stale matching section destination requires a fresh post-reference result", async () => {
  for (const version of ["1.18.2", "1.20.4"]) for (const reply of ["success", "refusal", "missing"]) {
    const f = fixture(["cobblestone"], 1, version);
    f.dependencies.noConfirmation = true;
    const position = new Vec3(-1, -1, -2);
    const diagnostics = [];
    f.bot.on("schematicEditAuthorization", event => diagnostics.push(event));
    const staleSent = deferred(), respond = deferred();
    f.dependencies.onWrite = (name, packet) => {
      if (name !== "block_place") return;
      setImmediate(async () => {
        f.inboundSection(position, "cobblestone");
        staleSent.resolve();
        await respond.promise;
        f.inbound(packet.location, "dirt");
        if (reply !== "missing") f.inboundSection(position, reply === "success" ? "cobblestone" : "air");
      });
    };
    let settled = false;
    const result = directPlace(f, { position, timeoutMs: 500 });
    result.then(() => { settled = true; }, () => { settled = true; });
    await staleSent.promise;
    await new Promise(setImmediate);
    assert.equal(settled, false, `${version}: ${reply}`);
    assert.ok(diagnostics.some(event => event.phase === "placement-target-before-reference-response"
      && event.stateId === f.bot.registry.blocksByName.cobblestone.defaultState
      && event.referenceOrder === null));
    const checked = reply === "success" ? result : assert.rejects(result,
      reply === "missing" ? /Timed out.*confirmation/ : /Server did not confirm destructive place/);
    respond.resolve();
    await checked;
    assert.equal(diagnostics.filter(event => event.phase === "server-confirmed").length, reply === "success" ? 1 : 0);
    assertConfirmationListenersClean(f);
    if (reply !== "success") await assert.rejects(directPlace(f, { position }), /lacks server confirmation/);
  }
});

test("local reference events and sequence-only acknowledgements cannot correlate placement", async () => {
  for (const marker of ["local-reference", "sequence-ack"]) {
    const f = fixture(["cobblestone"], 1, "1.20.4");
    f.dependencies.noConfirmation = true;
    f.dependencies.onWrite = (name, packet) => {
      if (name === "block_place") setImmediate(() => {
        if (marker === "local-reference") {
          const reference = f.bot.blockAt(packet.location);
          f.bot.emit(`blockUpdate:${packet.location}`, reference, reference);
        } else f.bot._client.emit("acknowledge_player_digging", { sequenceId: packet.sequence });
        f.inbound(packet.location.offset(0, 1, 0), "cobblestone");
      });
    };
    await assert.rejects(directPlace(f), /server-observed.*confirmation/i, marker);
    await new Promise(setImmediate);
    assertConfirmationListenersClean(f);
    f.inbound(new Vec3(0, 63, 0), "dirt");
    f.inbound(new Vec3(0, 64, 0), "cobblestone");
    await assert.rejects(directPlace(f), /lacks server confirmation/);
  }
});

test("a combined section reply is ambiguous in either record order, even with a later matching destination", async () => {
  for (const reverse of [false, true]) {
    const f = fixture(["cobblestone"]);
    f.dependencies.noConfirmation = true;
    const position = new Vec3(-1, -1, -2);
    f.dependencies.onWrite = name => {
      if (name === "block_place") setImmediate(() => {
        const ref = data.blocksByName.dirt.defaultState * 4096 + (15 << 8) + (14 << 4) + 14;
        const dest = data.blocksByName.cobblestone.defaultState * 4096 + (15 << 8) + (14 << 4) + 15;
        f.bot._client.emit("multi_block_change", {
          chunkCoordinates: { x: -1, y: -1, z: -1 }, records: reverse ? [dest, ref] : [ref, dest],
        });
        f.inbound(position, "cobblestone"); // cannot repair an ambiguous reply
      });
    };
    await assert.rejects(directPlace(f, { position }), /ambiguous.*section/i);
    await new Promise(setImmediate);
    assertConfirmationListenersClean(f);
    await assert.rejects(directPlace(f, { position }), /lacks server confirmation/);
  }
});

test("a section containing only the reference can fence a separate destination packet", async () => {
  const f = fixture(["cobblestone"]);
  f.dependencies.noConfirmation = true;
  const position = new Vec3(-1, -1, -2);
  f.dependencies.onWrite = name => {
    if (name === "block_place") setImmediate(() => {
      const reference = f.bot.blockAt(position.offset(0, -1, 0));
      f.bot.emit(`blockUpdate:${reference.position}`, reference, reference);
      f.bot._client.emit("multi_block_change", {
        chunkCoordinates: { x: -1, y: -1, z: -1 },
        records: [reference.stateId * 4096 + (15 << 8) + (14 << 4) + 14],
      });
      f.inbound(position, "cobblestone");
    });
  };
  await directPlace(f, { position });
  assertConfirmationListenersClean(f);
});

test("duplicate relevant section records cannot be interpreted as an ordered placement reply", async () => {
  for (const duplicate of ["reference", "target"]) for (const reverse of [false, true]) {
    const f = fixture(["cobblestone"]);
    f.dependencies.noConfirmation = true;
    const position = new Vec3(-1, -1, -2);
    const diagnostics = [];
    f.bot.on("schematicEditAuthorization", event => diagnostics.push(event));
    f.dependencies.onWrite = (name, packet) => {
      if (name !== "block_place") return;
      setImmediate(() => {
        if (duplicate === "target") f.inbound(packet.location, "dirt");
        const y = duplicate === "reference" ? 14 : 15;
        const state = f.bot.registry.blocksByName[duplicate === "reference" ? "dirt" : "cobblestone"].defaultState;
        const matching = state * 4096 + (15 << 8) + (14 << 4) + y;
        const conflicting = (15 << 8) + (14 << 4) + y; // air at the same coordinate
        f.bot._client.emit("multi_block_change", {
          chunkCoordinates: { x: -1, y: -1, z: -1 },
          records: reverse ? [conflicting, matching] : [matching, conflicting],
        });
        f.inbound(position, "cobblestone");
      });
    };
    await assert.rejects(directPlace(f, { position }), /ambiguous.*section/);
    assert.equal(diagnostics.some(event => event.phase === "server-confirmed"), false);
    assertConfirmationListenersClean(f);
    await assert.rejects(directPlace(f, { position }), /lacks server confirmation/);
  }
});

test("ordered single-reference then section-destination confirmation works at negative coordinates", async () => {
  const f = fixture(["cobblestone"], 1, "1.20.4");
  f.dependencies.noConfirmation = true;
  const position = new Vec3(-1, -1, -2);
  f.dependencies.onWrite = (name, packet) => {
    if (name === "block_place") setImmediate(() => {
      f.inbound(packet.location, "dirt");
      const before = f.bot.blockAt(position);
      f.world.set(key(position), "cobblestone");
      f.bot.emit(`blockUpdate:${position}`, before, f.bot.blockAt(position));
      f.bot._client.emit("multi_block_change", {
        chunkCoordinates: { x: -1, y: -1, z: -1 },
        records: [f.bot.registry.blocksByName.cobblestone.defaultState * 4096 + (15 << 8) + (14 << 4) + 15],
      });
    });
  };
  await directPlace(f, { position });
  assertConfirmationListenersClean(f);
});

test("regression: unchanged dig-start update and acknowledgement tolerate native finish, without quarantine", async () => {
  for (const version of ["1.16.5", "1.17.1", "1.18.2"]) {
    const f = fixture(["air"], 1, version);
    f.dependencies.noConfirmation = true;
    f.dependencies.digTimeMs = 15;
    const phases = [], statuses = [];
    f.bot.on("schematicEditAuthorization", event => phases.push(event.phase));
    f.dependencies.onWrite = (name, packet) => {
      if (name !== "block_dig") return;
      statuses.push(packet.status);
      if (packet.status === 0) setImmediate(() => {
        f.inbound(packet.location, "dirt");
        f.acknowledge(packet.location, { name: "dirt" });
      });
      if (packet.status === 2) setImmediate(() => {
        f.inbound(packet.location, "air");
        f.acknowledge(packet.location, { status: 2 });
      });
    };
    await directDig(f, { timeoutMs: 500 });
    assert.deepEqual(statuses, [0, 2], version);
    assert.ok(phases.includes("dig-update-unconfirmed"));
    assert.ok(phases.includes("dig-start-acknowledged"));
    assert.ok(phases.includes("server-confirmed"));
    await new Promise(setImmediate);
    assertConfirmationListenersClean(f);
    await directDig(f, { timeoutMs: 500 });
    assert.deepEqual(statuses, [0, 2, 0, 2], "successful confirmation releases quarantine lease");
  }
});

test("dig diagnostics distinguish unchanged start acknowledgement from dispatched finish confirmation", async () => {
  const f = fixture(["air"]);
  f.dependencies.noConfirmation = true;
  f.dependencies.digTimeMs = 20;
  const diagnostics = [];
  f.bot.on("schematicEditAuthorization", event => diagnostics.push(event));
  f.dependencies.onWrite = (name, packet) => {
    if (name !== "block_dig") return;
    if (packet.status === 0) setImmediate(() => {
      f.inbound(packet.location, "dirt");
      f.acknowledge(packet.location, { name: "dirt" });
      f.inbound(packet.location, "dirt"); // still not a refusal after the start acknowledgement
    });
    if (packet.status === 2) setImmediate(() => f.acknowledge(packet.location, { status: 2 }));
  };
  await directDig(f, { timeoutMs: 500 });
  assert.deepEqual(diagnostics.filter(event => ["authorized", "dig-start-acknowledged", "server-confirmed"].includes(event.phase))
    .map(event => [event.phase, event.confirmationState, event.pendingDigStatuses]), [
    ["authorized", "dig-awaiting-start-ack", [0]],
    ["dig-start-acknowledged", "dig-awaiting-finish-write", []],
    ["authorized", "dig-awaiting-finish-ack", [2]],
    ["server-confirmed", "confirmed", []],
  ]);
  assert.equal(f.world.get("0,64,0"), "dirt", "the acknowledgement only wakes the private waiter, never predicts world state");
  assertConfirmationListenersClean(f);
});

test("a successful non-air start acknowledgement for a different block state is not correlated authorization", async () => {
  for (const version of ["1.16.5", "1.17.1", "1.18.2"]) {
    const f = fixture(["air"], 1, version);
    f.dependencies.noConfirmation = true;
    f.dependencies.digTimeMs = 100;
    const diagnostics = [];
    f.bot.on("schematicEditAuthorization", event => diagnostics.push(event));
    f.dependencies.onWrite = (name, packet) => {
      if (name === "block_dig" && packet.status === 0) setImmediate(() => {
        f.acknowledge(packet.location, { name: "stone" });
        f.acknowledge(packet.location); // a later air reply cannot repair revocation
      });
    };
    await assert.rejects(directDig(f, { timeoutMs: 500 }), /start acknowledgement changed the authorized state/);
    assert.equal(diagnostics.some(event => event.phase === "server-confirmed"), false);
    assertConfirmationListenersClean(f);
    await assert.rejects(directDig(f), /lacks server confirmation/);
  }
});

test("detailed successful start acknowledgement confirms instant native digging without cache prediction", async () => {
  for (const version of ["1.16.5", "1.17.1", "1.18.2"]) {
    const f = fixture(["air"], 1, version);
    f.dependencies.noConfirmation = true;
    f.dependencies.digTimeMs = 100;
    f.dependencies.onWrite = (name, packet) => {
      if (name === "block_dig" && packet.status === 0) setImmediate(() => f.acknowledge(packet.location));
    };
    await directDig(f, { timeoutMs: 500 });
    assert.equal(f.world.get("0,64,0"), "dirt", "authoritative acknowledgement does not mutate the world cache");
    assertConfirmationListenersClean(f);
  }
});

test("unchanged start updates also permit instant Creative dig acknowledgements and release the lease", async () => {
  for (const version of ["1.16.5", "1.17.1", "1.18.2"]) {
    for (const transport of ["inbound", "inboundSection"]) {
      const f = fixture(["air"], 1, version);
      f.dependencies.noConfirmation = true;
      // Keep the native finish timer out of this start-only response path.
      f.dependencies.digTimeMs = 1_000;
      const statuses = [], diagnostics = [];
      f.bot.on("schematicEditAuthorization", event => diagnostics.push(event));
      f.dependencies.onWrite = (name, packet) => {
        if (name !== "block_dig") return;
        statuses.push(packet.status);
        if (packet.status === 0) setImmediate(() => {
          f[transport](packet.location, "dirt");
          f.acknowledge(packet.location);
        });
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        await directDig(f, { position: new Vec3(-1, -1, -2), timeoutMs: 500 });
        await new Promise(setImmediate);
        assertConfirmationListenersClean(f);
      }
      assert.deepEqual(statuses, [0, 0], "both edits settle without a finish or cancellation write");
      assert.equal(diagnostics.filter(event => event.phase === "dig-update-unconfirmed"
        && event.unchanged && !event.finishDispatched).length, 2);
      assert.equal(diagnostics.filter(event => event.phase === "server-confirmed").length, 2);
      assert.equal(f.world.get("-1,-1,-2"), "dirt", "the acknowledgement never predicts world state");
    }
  }
});

test("delayed start acknowledgement cannot release a dig with an outstanding dispatched finish", async () => {
  for (const startState of ["air", "dirt"]) {
    const f = fixture(["air"]);
    f.dependencies.noConfirmation = true;
    f.dependencies.digTimeMs = 5;
    const startObserved = deferred(), finishReply = deferred();
    const phases = [];
    f.bot.on("schematicEditAuthorization", event => phases.push(event.phase));
    f.dependencies.onWrite = (name, packet) => {
      if (name === "block_dig" && packet.status === 2) setImmediate(async () => {
        f.acknowledge(packet.location, { name: startState });
        startObserved.resolve();
        await finishReply.promise;
        f.acknowledge(packet.location, { status: 2 });
      });
    };
    let settled = false;
    const result = directDig(f, { timeoutMs: 500 });
    result.then(() => { settled = true; }, () => { settled = true; });
    await startObserved.promise;
    await new Promise(setImmediate);
    assert.equal(settled, false, startState);
    assert.equal(phases.includes("server-confirmed"), false, startState);
    finishReply.resolve();
    await result;
    assert.equal(phases.filter(phase => phase === "server-confirmed").length, 1);
    assertConfirmationListenersClean(f);
  }
});

test("missing or duplicate start acknowledgements cannot be mistaken for a fully correlated dig", async () => {
  for (const reply of ["missing-start", "duplicate-start", "finish-refused"]) {
    const f = fixture(["air"]);
    f.dependencies.noConfirmation = true;
    f.dependencies.digTimeMs = 5;
    f.dependencies.onWrite = (name, packet) => {
      if (name === "block_dig" && packet.status === 2) setImmediate(() => {
        if (reply !== "missing-start") f.acknowledge(packet.location, { name: "dirt" });
        if (reply === "duplicate-start") f.acknowledge(packet.location, { name: "dirt" });
        f.acknowledge(packet.location, { status: 2, successful: reply !== "finish-refused" });
      });
    };
    await assert.rejects(directDig(f), /Server did not confirm destructive dig/);
    await new Promise(setImmediate);
    assertConfirmationListenersClean(f);
    await assert.rejects(directDig(f), /lacks server confirmation/);
  }
});

test("an unchanged start update alone neither aborts digging nor confirms its result", async () => {
  const f = fixture(["air"]);
  f.dependencies.noConfirmation = true;
  f.dependencies.digTimeMs = 5;
  const statuses = [], phases = [];
  f.bot.on("schematicEditAuthorization", event => phases.push(event.phase));
  f.dependencies.onWrite = (name, packet) => {
    if (name !== "block_dig") return;
    statuses.push(packet.status);
    if (packet.status === 0) setImmediate(() => f.inbound(packet.location, "dirt"));
  };
  await assert.rejects(directDig(f), /Timed out.*confirmation/);
  assert.deepEqual(statuses, [0, 2]);
  assert.ok(phases.includes("dig-update-unconfirmed"));
  assert.equal(phases.includes("server-confirmed"), false);
  assertConfirmationListenersClean(f);
});

test("unchanged pre-finish dig updates tolerate success but cannot mask refused or missing finish acknowledgement", async () => {
  for (const transport of ["single", "section"]) for (const reply of ["success", "refusal", "missing"]) {
    const f = fixture(["air"]);
    f.dependencies.noConfirmation = true;
    f.dependencies.digTimeMs = 30;
    const position = new Vec3(-1, -1, -2);
    const diagnostics = [], statuses = [];
    f.bot.on("schematicEditAuthorization", event => diagnostics.push(event));
    const inbound = transport === "single" ? f.inbound : f.inboundSection;
    f.dependencies.onWrite = (name, packet) => {
      if (name !== "block_dig") return;
      statuses.push(packet.status);
      if (packet.status === 0) setImmediate(() => {
        inbound(position, "dirt");
        f.acknowledge(position, { name: "dirt" });
        inbound(position, "dirt");
      });
      if (packet.status === 2) setImmediate(() => {
        inbound(position, "air"); // even authoritative air is not an action acknowledgement
        if (reply !== "missing") f.acknowledge(position, { status: 2, successful: reply === "success" });
      });
    };
    const result = directDig(f, { position, timeoutMs: 500 });
    if (reply === "success") await result;
    else await assert.rejects(result, reply === "missing" ? /Timed out.*confirmation/ : /digging acknowledgement refused status 2/);
    assert.deepEqual(statuses, [0, 2], `${transport}: ${reply}`);
    assert.equal(diagnostics.filter(event => event.phase === "dig-update-unconfirmed"
      && event.unchanged && !event.finishDispatched).length, 2);
    assert.equal(diagnostics.filter(event => event.phase === "server-confirmed").length, reply === "success" ? 1 : 0);
    assertConfirmationListenersClean(f);
    if (reply !== "success") await assert.rejects(directDig(f, { position }), /lacks server confirmation/);
  }
});

test("dig acknowledgement correlates dispatched action and target, and rejects explicit refusal", async () => {
  for (const reply of ["pre-write", "wrong-target", "unsent-finish", "cancel", "missing-success", "unknown-state", "refusal", "finished-non-air"]) {
    const f = fixture(["air"]);
    f.dependencies.noConfirmation = true;
    f.dependencies.digTimeMs = reply === "finished-non-air" ? 5 : 100;
    const position = new Vec3(0, 64, 0);
    const phases = [];
    f.bot.on("schematicEditAuthorization", event => phases.push(event.phase));
    const send = () => {
      const packet = { location: position, block: data.blocksByName.air.defaultState, status: 0, successful: true };
      if (reply === "wrong-target") packet.location = position.offset(1, 0, 0);
      if (["unsent-finish", "finished-non-air"].includes(reply)) packet.status = 2;
      if (reply === "cancel") packet.status = 1;
      if (reply === "missing-success") delete packet.successful;
      if (reply === "unknown-state") packet.block = Number.MAX_SAFE_INTEGER;
      if (reply === "refusal") packet.successful = false;
      if (reply === "finished-non-air") packet.block = data.blocksByName.dirt.defaultState;
      f.bot._client.emit("acknowledge_player_digging", packet);
    };
    if (reply === "pre-write") f.dependencies.onAim = send;
    else f.dependencies.onWrite = (name, packet) => {
      if (name === "block_dig" && packet.status === (reply === "finished-non-air" ? 2 : 0)) setImmediate(send);
    };
    await assert.rejects(directDig(f), /server.*confirm/i, reply);
    assert.equal(phases.includes("server-confirmed"), false, reply);
    await new Promise(setImmediate);
    assertConfirmationListenersClean(f);
    await assert.rejects(directDig(f), /lacks server confirmation/);
  }
});

test("sequence-only digging protocols fail closed before aim, authorization or dispatch; placement remains supported", async () => {
  for (const version of ["1.19", "1.20.4", "1.21.4"]) {
    const f = fixture(["cobblestone"], 1, version);
    let aims = 0, authorizations = 0;
    f.dependencies.onAim = () => { aims++; };
    const position = new Vec3(0, 64, 0);
    await assert.rejects(authorizedGameplayEdit(f.bot, {
      kind: "dig", block: f.bot.blockAt(position), target: position,
      identity: captureSchematicAttemptIdentity(f.bot),
      authorize() { authorizations++; }, assertCurrent() {},
    }), /sequence-only.*cannot distinguish/i);
    assert.equal(aims, 0);
    assert.equal(authorizations, 0);
    assert.deepEqual(f.writes, []);
    assertConfirmationListenersClean(f);
    await directPlace(f);
    assertConfirmationListenersClean(f);
  }
});

test("normal ordered placement confirmation remains supported across the admitted protocol features", async () => {
  for (const version of ["1.16.5", "1.17.1", "1.18.2", "1.19", "1.20.4", "1.21.4"]) {
    const f = fixture(["cobblestone"], 1, version);
    await directPlace(f);
    assert.equal(f.world.get("0,64,0"), "cobblestone", version);
    assertConfirmationListenersClean(f);
  }
});

test("cancellation between operation-specific replies revokes confirmation and quarantines the dispatched edit", async () => {
  for (const kind of ["dig", "place"]) {
    const f = fixture([kind === "dig" ? "air" : "cobblestone"]);
    f.dependencies.noConfirmation = true;
    f.dependencies.digTimeMs = 100;
    const diagnostics = [];
    f.bot.on("schematicEditAuthorization", event => diagnostics.push(event));
    f.dependencies.onWrite = (name, packet) => {
      if (kind === "dig" ? name !== "block_dig" || packet.status !== 0 : name !== "block_place") return;
      setImmediate(() => {
        if (kind === "dig") f.acknowledge(packet.location, { name: "dirt" });
        else f.inbound(packet.location, "dirt");
        f.bot.interrupt_code = true;
        if (kind === "dig") f.acknowledge(packet.location);
        else f.inbound(packet.location.offset(0, 1, 0), "cobblestone");
      });
    };
    const edit = kind === "dig" ? directDig : directPlace;
    await assert.rejects(edit(f, { timeoutMs: 500 }), /not cancelled/);
    assert.equal(diagnostics.some(event => event.phase === "server-confirmed"), false);
    assertConfirmationListenersClean(f);
    f.bot.interrupt_code = false;
    await assert.rejects(edit(f), /lacks server confirmation/);
  }
});

test("all-air build cannot succeed without inbound destructive confirmation", async () => {
  const f = fixture(["air"]);
  f.world.set("0,64,0", "dirt");
  f.dependencies.noConfirmation = true;
  assert.equal(await f.run(), false);
  assert.equal(f.world.get("0,64,0"), "dirt", "native finish never predicts local air");
  assert.match(f.logs.join(" "), /server-observed.*confirmation/i);
});

test("unsupported protocol capabilities fail closed without editing", async () => {
  const f = fixture(["air"]);
  f.world.set("0,64,0", "dirt");
  f.bot.supportFeature = () => false;
  assert.equal(await f.run(), false);
  assert.deepEqual(f.writes, []);
  assert.match(f.logs.join(" "), /reviewed Mineflayer.*protocol support/i);
});
