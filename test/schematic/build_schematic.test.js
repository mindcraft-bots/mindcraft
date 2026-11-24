import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { buildSchematic } from "../../src/utils/schematic/build_schematic.js";
import { createModernBuild } from "../../src/utils/schematic/modern_build.js";
import { clearSchematicObstructions } from "../../src/utils/schematic/obstruction_policy.js";
import { acquireBuildLifecycle } from "../../src/utils/schematic/run_build.js";
import { provenanceFixtureDependencies } from "./provenance_fixture.js";

const require = createRequire(import.meta.url);
const nbt = require("prismarine-nbt");
const minecraftData = require("minecraft-data");
const mineflayerHealth = require("mineflayer/lib/plugins/health.js");
const { Schematic } = require("prismarine-schematic");
const Block = require("prismarine-block")("1.20.4");

function spongeBuffer(palette, blockData) {
  const entries = Object.fromEntries(Object.entries(palette).map(([name, id]) => [name, { type: "int", value: id }]));
  const root = {
    type: "compound",
    name: "Schematic",
    value: {
      Version: { type: "int", value: 2 },
      DataVersion: { type: "int", value: 3465 },
      Width: { type: "short", value: blockData.length },
      Height: { type: "short", value: 1 },
      Length: { type: "short", value: 1 },
      PaletteMax: { type: "int", value: Object.keys(palette).length },
      Palette: { type: "compound", value: entries },
      BlockData: { type: "byteArray", value: blockData },
    },
  };
  return gzipSync(nbt.writeUncompressed(root));
}

class FakeVec3 {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  offset(x, y, z) {
    return new FakeVec3(this.x + x, this.y + y, this.z + z);
  }

  floored() {
    return new FakeVec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
  }

  distanceTo(other) {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z);
  }
}

function fixture(overrides = {}) {
  const calls = { logs: [], modes: [], positions: [], paused: false, cancelled: 0, cleaned: 0, aborted: 0 };
  const bot = Object.assign(new EventEmitter(), {
    version: "1.20.4",
    registry: minecraftData("1.20.4"),
    game: { gameMode: "survival", dimension: "overworld" },
    position: new FakeVec3(1.2, 64.9, -3.2),
    entity: { position: new FakeVec3(1.2, 64.9, -3.2) },
    world: {},
    _client: Object.assign(new EventEmitter(), { ended: false, socket: { destroyed: false } }),
    interrupt_code: false,
    modes: {
      exists: (name) => name === "unstuck",
      isPaused: () => calls.paused,
      pause: () => { calls.paused = true; },
      unpause: () => { calls.paused = false; },
    },
    blockAt(position) {
      calls.positions.push(position);
      return { name: "stone", getProperties: () => ({ axis: "y" }) };
    },
    dig: async () => {},
    placeBlock: async () => {},
    builder: { clearArea: async () => {} },
    pathfinder: {
      movements: { canDig: true, allow1by1towers: true, scafoldingBlocks: [1] },
      setMovements(movements) { this.movements = movements; },
      goto: async () => {},
    },
  });
  const build = {
    dimensions: { width: 1, height: 1, length: 1 },
    plan: [{ position: { x: 3, y: 64, z: 5 }, name: "stone", properties: { axis: "y" } }],
    cells: [{ position: { x: 3, y: 64, z: 5 }, name: "stone", properties: { axis: "y" } }],
  };
  const dependencies = {
    resolvePath: (filename) => `/schematics/${filename}`,
    fsAccess: () => {},
    fsReadFile: () => Buffer.from("schematic"),
    SchematicClass: { read: () => ({ parsed: true }) },
    Vec3Class: FakeVec3,
    makeBuild: (_schematic, _bot, position) => {
      calls.startPosition = position;
      return build;
    },
    startSupply: () => {
      const cleanup = () => { calls.cleaned++; };
      cleanup.cancel = () => { calls.cancelled++; };
      cleanup.abort = () => { calls.aborted++; };
      return cleanup;
    },
    executeBuild: () => ({ status: "finished", errors: [] }),
    changeGameMode: (_bot, mode, timeout, options) => {
      calls.modes.push({ mode, timeout, force: options?.force ?? false });
      return true;
    },
    writeLog: (message) => calls.logs.push(message),
    cleanupTimeoutMs: 20,
  };
  Object.assign(dependencies, overrides);
  return { bot, build, calls, dependencies: provenanceFixtureDependencies(dependencies) };
}

test("rejects missing and escaping paths before reading or changing game mode", async () => {
  const missing = fixture({ fsAccess: () => { throw new Error("ENOENT: missing file"); } });
  assert.equal(await buildSchematic(missing.bot, "missing.schem", null, null, null, missing.dependencies), false);
  assert.deepEqual(missing.calls.modes, []);
  assert.match(missing.calls.logs[0], /Could not read schematic.*ENOENT/);

  const traversal = fixture({ resolvePath: () => { throw new Error("outside schematics directory"); } });
  assert.equal(await buildSchematic(traversal.bot, "../escape.schem", null, null, null, traversal.dependencies), false);
  assert.deepEqual(traversal.calls.modes, []);
  assert.match(traversal.calls.logs[0], /Could not read schematic/);

  const readError = fixture({ fsReadFile: () => { throw new Error("read denied"); } });
  assert.equal(await buildSchematic(readError.bot, "denied.schem", null, null, null, readError.dependencies), false);
  assert.deepEqual(readError.calls.modes, []);
  assert.match(readError.calls.logs[0], /Could not read schematic.*read denied/);
});

test("reports parse failures and explicitly rejects listed but unsupported litematic files", async () => {
  const parse = fixture({ SchematicClass: { read: () => { throw new Error("invalid NBT"); } } });
  assert.equal(await buildSchematic(parse.bot, "bad.schem", null, null, null, parse.dependencies), false);
  assert.match(parse.calls.logs[0], /Could not parse or build schematic.*invalid NBT.*\.litematic must be converted/);
  assert.deepEqual(parse.calls.modes, []);

  const litematic = fixture();
  assert.equal(await buildSchematic(litematic.bot, "listed.litematic", null, null, null, litematic.dependencies), false);
  assert.match(litematic.calls.logs[0], /not supported.*Convert this file/);
  assert.deepEqual(litematic.calls.modes, []);

  const resolvedExtension = fixture({ resolvePath: () => "/schematics/packs/actual-file.litematic" });
  assert.equal(await buildSchematic(resolvedExtension.bot, "pack1:actual-file.litematic", null, null, null, resolvedExtension.dependencies), false);
  assert.match(resolvedExtension.calls.logs[0], /not supported.*Convert this file/);
  assert.deepEqual(resolvedExtension.calls.modes, []);
});

test("rejects unknown source palette blocks before parser, Creative mode, or supply changes", async () => {
  const unknown = fixture({
    fsReadFile: () => spongeBuffer({
      "minecraft:stone": 0,
      "minecraft:modded_block": 1,
    }, [0, 1]),
    SchematicClass: { read: () => { throw new Error("lossy parser must not run"); } },
    startSupply: () => { throw new Error("supply must not start"); },
  });
  assert.equal(await buildSchematic(unknown.bot, "unknown.schem", null, null, null, unknown.dependencies), false);
  assert.deepEqual(unknown.calls.modes, []);
  assert.equal(unknown.calls.cleaned, 0);
  assert.match(unknown.calls.logs.join(" "), /unsupported block.*modded_block/i);

  const mixed = fixture({
    fsReadFile: () => spongeBuffer({
      "minecraft:stone": 0,
      "minecraft:future_block": 1,
    }, [0, 1]),
    SchematicClass: { read: () => { throw new Error("lossy parser must not run"); } },
    startSupply: () => { throw new Error("supply must not start"); },
  });
  assert.equal(await buildSchematic(mixed.bot, "mixed.schem", null, null, null, mixed.dependencies), false);
  assert.deepEqual(mixed.calls.modes, []);
  assert.match(mixed.calls.logs.join(" "), /minecraft:future_block/);
});

test("production schematic builder rejects boundary-crossing door, bed, and double-plant footprints before mutation", async () => {
  const cases = [
    {
      state: "minecraft:oak_door[facing=west,half=lower,hinge=left,open=false,powered=false]",
      secondary: "3,65,5",
    },
    {
      state: "minecraft:red_bed[facing=south,part=foot,occupied=false]",
      secondary: "3,64,6",
    },
    {
      state: "minecraft:sunflower[half=lower]",
      secondary: "3,65,5",
    },
  ];

  for (const { state, secondary } of cases) {
    const world = new Map([[secondary, { name: "poppy" }]]);
    let mutations = 0;
    const candidate = fixture({
      fsReadFile: () => spongeBuffer({ [state]: 0 }, [0]),
      SchematicClass: Schematic,
      makeBuild: createModernBuild,
      startSupply: () => { throw new Error("supply must not start for unsupported footprints"); },
      executeBuild: () => { throw new Error("production builder must reject before execution"); },
    });
    candidate.bot.blockAt = (position) => world.get(`${position.x},${position.y},${position.z}`)
      ?? { name: "air", getProperties: () => ({}) };
    candidate.bot.dig = async () => { mutations++; };
    candidate.bot.placeBlock = async () => { mutations++; };

    assert.equal(await buildSchematic(candidate.bot, "boundary.schem", 3, 64, 5, candidate.dependencies), false, state);
    assert.deepEqual(candidate.calls.modes, [], `${state} must fail before Creative mode`);
    assert.equal(mutations, 0, `${state} must not invoke any mutation`);
    assert.equal(world.get(secondary).name, "poppy", `${state} must preserve the modeled outside flower`);
    assert.match(candidate.calls.logs.join(" "), /unsupported blocks.*(?:door|bed|plant)/i);
  }
});

test("floors three finite coordinates and otherwise uses bot position offset and floor", async () => {
  const explicit = fixture();
  assert.equal(await buildSchematic(explicit.bot, "house.schem", 10.9, -4.2, 7, explicit.dependencies), true);
  assert.deepEqual(explicit.calls.startPosition, new FakeVec3(10, -5, 7));

  const fallback = fixture();
  assert.equal(await buildSchematic(fallback.bot, "house.schem", 10, Number.NaN, 7, fallback.dependencies), true);
  assert.deepEqual(fallback.calls.startPosition, new FakeVec3(3, 64, -2));
});

test("obstruction navigation timeout restores guards, mode, and lifecycle before builder startup", { timeout: 2000 }, async () => {
  let supplyStarted = false;
  let builderStarted = false;
  const candidate = fixture({
    clearObstructions: (bot, build, options) => clearSchematicObstructions(bot, build, { ...options, navigationTimeoutMs: 20 }),
    startSupply: () => { supplyStarted = true; },
    executeBuild: () => { builderStarted = true; },
  });
  const { bot, calls, dependencies } = candidate;
  let stops = 0;
  let digs = 0;
  bot.blockAt = (position) => ({ name: "poppy", position, diggable: true, getProperties: () => ({}) });
  bot.dig = () => { digs++; };
  bot.pathfinder.goto = () => new Promise(() => {});
  bot.pathfinder.setGoal = (goal) => { assert.equal(goal, null); stops++; };
  const originalDig = bot.dig;
  const originalPlace = bot.placeBlock;
  const originalClear = bot.builder.clearArea;
  const originalMovements = bot.pathfinder.movements;

  assert.equal(await buildSchematic(bot, "house.schem", null, null, null, dependencies), false);
  assert.match(calls.logs.join(" "), /obstruction preflight\/clearing failed:.*navigation timed out after 20ms.*3,64,5/i);
  assert.equal(stops, 1);
  assert.equal(digs, 0);
  assert.equal(supplyStarted, false);
  assert.equal(builderStarted, false);
  assert.equal(bot.dig, originalDig);
  assert.equal(bot.placeBlock, originalPlace);
  assert.equal(bot.builder.clearArea, originalClear);
  assert.equal(bot.pathfinder.movements, originalMovements);
  assert.deepEqual(calls.modes.map(({ mode }) => mode), ["creative", "survival"]);
  assert.equal(calls.modes[1].force, true);
  assert.equal(calls.paused, false);
  const nextLease = acquireBuildLifecycle(bot);
  assert.ok(nextLease, "failed clearing releases build ownership");
  nextLease.release();
});

test("Creative permission denial aborts the build and still restores mode and unstuck state", async () => {
  const { bot, calls, dependencies } = fixture({
    changeGameMode: (_bot, mode, timeout, options) => {
      calls.modes.push({ mode, timeout, force: options?.force ?? false });
      return false;
    },
  });
  assert.equal(await buildSchematic(bot, "house.schem", null, null, null, dependencies), false);
  assert.match(calls.logs.join(" "), /\/op/);
  assert.equal(calls.modes.length, 2);
  assert.equal(calls.modes[1].force, true);
  assert.equal(calls.modes[1].mode, "survival");
  assert.equal(calls.paused, false);
});

test("build success is verified and cleans supply, restores game mode and prior unstuck state", async () => {
  const { bot, calls, dependencies } = fixture();
  assert.equal(await buildSchematic(bot, "house.schem", null, null, null, dependencies), true);
  assert.equal(calls.cleaned, 1);
  assert.equal(calls.cancelled, 1);
  assert.equal(calls.positions.length, 2, "the in-volume safety preflight and final verification both inspect the planned target");
  assert.deepEqual(calls.modes.map(({ mode }) => mode), ["creative", "survival"]);
  assert.equal(calls.modes[1].force, true);
  assert.equal(calls.paused, false);
  assert.match(calls.logs.at(-1), /Successfully built and verified/);

  const alreadyPaused = fixture();
  alreadyPaused.calls.paused = true;
  assert.equal(await buildSchematic(alreadyPaused.bot, "house.schem", null, null, null, alreadyPaused.dependencies), true);
  assert.equal(alreadyPaused.calls.paused, true);
});

test("successful public build output names the resolved file rather than its numeric selector", async () => {
  const { bot, calls, dependencies } = fixture({
    resolvePath: () => '/schematics/schems/pack3/garden.schem',
  });
  assert.equal(await buildSchematic(bot, 'pack3:8:13', null, null, null, dependencies), true);
  assert.equal(calls.logs.at(-1), 'Successfully built and verified schematic garden.mc1.20.4.schem.');
});

test("reports rejected and interrupted builds as failures while cancelling and restoring", async () => {
  const rejected = fixture({ executeBuild: () => { throw new Error("placement rejected"); } });
  assert.equal(await buildSchematic(rejected.bot, "house.schem", null, null, null, rejected.dependencies), false);
  assert.equal(rejected.calls.cancelled, 1);
  assert.equal(rejected.calls.modes.at(-1).force, true);
  assert.match(rejected.calls.logs.join(" "), /placement rejected/);

  const interrupted = fixture({ executeBuild: (_bot, _build, options) => {
    options.onCancel();
    return { status: "interrupted", errors: [] };
  } });
  assert.equal(await buildSchematic(interrupted.bot, "house.schem", null, null, null, interrupted.dependencies), false);
  assert.equal(interrupted.calls.cancelled, 2); // runBuild cancellation hook and lifecycle cleanup
  assert.equal(interrupted.calls.cleaned, 1);
  assert.equal(interrupted.calls.modes.at(-1).force, true);
});

test("verification mismatch, cleanup rejection, and hanging cleanup never claim success", async () => {
  const mismatch = fixture();
  mismatch.bot.blockAt = () => ({ name: "dirt", getProperties: () => ({}) });
  assert.equal(await buildSchematic(mismatch.bot, "house.schem", null, null, null, mismatch.dependencies), false);
  assert.match(mismatch.calls.logs.join(" "), /Refusing obstruction dirt.*allowlist/);

  const wrongProperty = fixture();
  wrongProperty.bot.blockAt = () => ({ name: "stone", getProperties: () => ({ axis: "x" }) });
  assert.equal(await buildSchematic(wrongProperty.bot, "house.schem", null, null, null, wrongProperty.dependencies), false);
  assert.match(wrongProperty.calls.logs.join(" "), /Refusing obstruction stone.*protected/);

  const cleanupError = fixture({ startSupply: () => {
    const cleanup = () => { throw new Error("slot restore failed"); };
    cleanup.cancel = () => {};
    return cleanup;
  } });
  assert.equal(await buildSchematic(cleanupError.bot, "house.schem", null, null, null, cleanupError.dependencies), false);
  assert.match(cleanupError.calls.logs.join(" "), /slot restore failed/);

  const hanging = fixture({ startSupply: () => {
    const cleanup = () => new Promise(() => {});
    cleanup.cancel = () => {};
    cleanup.abort = () => { hanging.calls.aborted++; };
    return cleanup;
  }, cleanupTimeoutMs: 5 });
  const before = Date.now();
  assert.equal(await buildSchematic(hanging.bot, "house.schem", null, null, null, hanging.dependencies), false);
  assert.ok(Date.now() - before < 150);
  assert.equal(hanging.calls.aborted, 1);
  assert.match(hanging.calls.logs.join(" "), /cleanup timed out/);
  assert.equal(hanging.calls.modes.at(-1).force, true);
});

test("clears foliage only inside the transformed volume and verifies intended-air cells", async () => {
  const { bot, calls, dependencies, build } = fixture();
  const airPosition = { x: 4, y: 64, z: 5 };
  build.cells = [
    ...build.plan,
    { position: airPosition, name: "air", properties: {} },
  ];
  build.dimensions.width = 2;
  const world = new Map([
    ["3,64,5", { name: "poppy", diggable: true, getProperties: () => ({}) }],
    ["4,64,5", { name: "allium", diggable: true, getProperties: () => ({}) }],
    ["5,64,5", { name: "poppy", diggable: true, getProperties: () => ({}) }],
  ]);
  bot.blockAt = (position) => {
    const found = world.get(`${position.x},${position.y},${position.z}`);
    return found ? { ...found, position } : { name: "air", diggable: false, position, getProperties: () => ({}) };
  };
  bot.dig = async (target) => {
    calls.positions.push(target.position);
    world.set(`${target.position.x},${target.position.y},${target.position.z}`, { name: "air", getProperties: () => ({}) });
  };
  dependencies.executeBuild = async () => {
    world.set("3,64,5", { name: "stone", getProperties: () => ({ axis: "y" }) });
    return { status: "finished", errors: [] };
  };

  assert.equal(await buildSchematic(bot, "foliage.schem", null, null, null, dependencies), true);
  assert.deepEqual(calls.positions.map(({ x, y, z }) => `${x},${y},${z}`), ["3,64,5", "4,64,5"]);
  assert.equal(world.get("5,64,5").name, "poppy");
  assert.match(calls.logs.join(" "), /Cleared 2 allowlisted natural obstruction/);

  const obstructedAir = fixture();
  obstructedAir.build.cells = [
    ...obstructedAir.build.plan,
    { position: airPosition, name: "air", properties: {} },
  ];
  obstructedAir.build.dimensions.width = 2;
  const verifyWorld = new Map([
    ["3,64,5", { name: "stone", getProperties: () => ({ axis: "y" }) }],
    ["4,64,5", { name: "air", getProperties: () => ({}) }],
  ]);
  obstructedAir.bot.blockAt = (position) => verifyWorld.get(`${position.x},${position.y},${position.z}`);
  obstructedAir.dependencies.executeBuild = async () => {
    verifyWorld.set("4,64,5", { name: "dirt", getProperties: () => ({}) });
    return { status: "finished", errors: [] };
  };
  assert.equal(await buildSchematic(obstructedAir.bot, "air-cell.schem", null, null, null, obstructedAir.dependencies), false);
  assert.match(obstructedAir.calls.logs.join(" "), /expected air, found dirt/);
});

test("does not restore unchanged Creative mode and restores after a timed-out switch", async () => {
  const creative = fixture();
  creative.bot.game.gameMode = "creative";
  assert.equal(await buildSchematic(creative.bot, "house.schem", null, null, null, creative.dependencies), true);
  assert.deepEqual(creative.calls.modes.map(({ mode }) => mode), ["creative"]);

  const lateTimeout = fixture({ changeGameMode: (_bot, mode, timeout, options) => {
    lateTimeout.calls.modes.push({ mode, timeout, force: options?.force ?? false });
    if (mode === "creative") return false;
    // Simulates the client still reporting survival while a previous creative
    // acknowledgement may arrive late: forced restoration must still be sent.
    assert.equal(options?.force, true);
    return true;
  } });
  lateTimeout.bot.game.gameMode = "invalid-mode";
  assert.equal(await buildSchematic(lateTimeout.bot, "house.schem", null, null, null, lateTimeout.dependencies), false);
  assert.equal(lateTimeout.calls.modes[1].mode, "survival");
  assert.equal(lateTimeout.calls.modes[1].force, true);
});

test("combat interruption resumes with the captured source and origin after the bot moves", async () => {
  const { bot, calls, dependencies } = fixture();
  const session = { cancelled: false };
  let reads = 0;
  let attempts = 0;
  dependencies.fsReadFile = () => { reads++; return Buffer.from("original schematic bytes"); };
  dependencies.executeBuild = (_bot, _build, options) => {
    attempts++;
    if (attempts === 1) {
      options.onCancel();
      return { status: "interrupted", errors: [] };
    }
    return { status: "finished", errors: [] };
  };

  assert.equal(await buildSchematic(bot, "house.schem", null, null, null, { ...dependencies, resumeSession: session }), false);
  assert.equal(session.resumeEligible, true);
  assert.deepEqual(session.context.origin, { x: 3, y: 64, z: -2 });
  const firstSchematic = session.context.schematic;
  bot.position = new FakeVec3(100.7, 80.2, 200.9);
  bot.entity.position = bot.position;

  assert.equal(await buildSchematic(bot, "different-name-is-ignored.schem", null, null, null, { ...dependencies, resumeSession: session }), true);
  assert.equal(reads, 2);
  assert.equal(attempts, 2);
  assert.equal(session.context, null);
  assert.equal(session.cancelled, true);
  assert.deepEqual(calls.startPosition, new FakeVec3(3, 64, -2));
  assert.equal(session.schematic, undefined);
  assert.equal(firstSchematic.parsed, true);
});

test("real Mineflayer respawn to a same-dimension named world cancels recovery with stable object references", async () => {
  const { bot, dependencies } = fixture();
  const session = { cancelled: false };
  let attempts = 0;
  dependencies.executeBuild = (_bot, _build, options) => {
    attempts++;
    options.onCancel();
    return { status: "interrupted", errors: [] };
  };
  mineflayerHealth(bot, { respawn: false });
  const world = bot.world;
  const entity = bot.entity;

  assert.equal(await buildSchematic(bot, "house.schem", null, null, null, { ...dependencies, resumeSession: session }), false);
  assert.equal(session.resumeEligible, true);
  assert.equal(session.context.worldIdentity.worldGeneration, 0);

  // This is the real Mineflayer health plugin's client-respawn handler path.
  // Keep dimension, world, entity and client references unchanged, while the
  // packet names a different overworld.
  bot._client.emit("respawn", {
    worldState: { dimension: "minecraft:overworld", name: "minecraft:overworld_copy" },
    copyMetadata: true,
  });
  assert.equal(bot.game.dimension, "overworld");
  assert.equal(bot.world, world);
  assert.equal(bot.entity, entity);

  dependencies.executeBuild = () => { attempts++; return { status: "finished", errors: [] }; };
  assert.equal(await buildSchematic(bot, "ignored-on-resume.schem", null, null, null, { ...dependencies, resumeSession: session }), false);
  assert.equal(attempts, 1, "a prior session is rejected before the builder is registered again");
  assert.equal(session.cancelled, true);
  assert.equal(session.context, null);
});

test("interrupted recovery accepts only already-cleared natural cells and preserves the original volume snapshot", async () => {
  const { bot, dependencies, build } = fixture();
  const foliagePosition = { x: 4, y: 64, z: 5 };
  build.cells = [
    ...build.plan,
    { position: foliagePosition, name: "air", properties: {} },
  ];
  build.dimensions.width = 2;
  const world = new Map([
    ["3,64,5", { name: "poppy", diggable: true, getProperties: () => ({}) }],
    ["4,64,5", { name: "poppy", diggable: true, getProperties: () => ({}) }],
  ]);
  bot.blockAt = (position) => {
    const found = world.get(`${position.x},${position.y},${position.z}`);
    return found ? { ...found, position } : { name: "air", position, getProperties: () => ({}) };
  };
  bot.dig = async (target) => world.set(`${target.position.x},${target.position.y},${target.position.z}`, {
    name: "air", getProperties: () => ({}),
  });
  const session = { cancelled: false };
  let attempts = 0;
  dependencies.executeBuild = async () => {
    attempts++;
    if (attempts === 1) return { status: "interrupted", errors: [] };
    world.set("3,64,5", { name: "stone", getProperties: () => ({ axis: "y" }) });
    return { status: "finished", errors: [] };
  };

  assert.equal(await buildSchematic(bot, "foliage.schem", null, null, null, { ...dependencies, resumeSession: session }), false);
  assert.equal(session.resumeEligible, true);
  assert.deepEqual(session.context.originalStates.map(({ name }) => name), ["poppy", "poppy"]);
  assert.equal(world.get("3,64,5").name, "air");
  assert.equal(world.get("4,64,5").name, "air");
  assert.equal(await buildSchematic(bot, "ignored-on-resume.schem", null, null, null, { ...dependencies, resumeSession: session }), true);
  assert.equal(attempts, 2);
  assert.equal(session.context, null);
});

test("recovery rejects an unsafe fluid-bearing obstruction in the saved world snapshot", async () => {
  const { bot, dependencies } = fixture();
  const session = { cancelled: false };
  let executions = 0;
  dependencies.executeBuild = (_bot, _build, options) => {
    executions++;
    options.onCancel();
    return { status: "interrupted", errors: [] };
  };
  assert.equal(await buildSchematic(bot, "house.schem", null, null, null, { ...dependencies, resumeSession: session }), false);
  assert.equal(session.resumeEligible, true);

  const waterlogged = Block.fromProperties("mangrove_propagule", {
    age: 0, hanging: false, stage: 0, waterlogged: true,
  }).getProperties();
  session.context.originalStates[0] = {
    position: { x: 3, y: 64, z: 5 },
    name: "mangrove_propagule",
    properties: waterlogged,
  };
  bot.blockAt = (position) => ({
    name: "mangrove_propagule",
    position,
    getProperties: () => waterlogged,
  });
  dependencies.executeBuild = () => { executions++; return { status: "finished", errors: [] }; };

  assert.equal(await buildSchematic(bot, "ignored-on-resume.schem", null, null, null, { ...dependencies, resumeSession: session }), false);
  assert.equal(executions, 1, "unsafe snapshot fails before another build or dig");
  assert.equal(session.context, null);
  assert.equal(session.cancelled, true);
});

test("repeated combat interruptions remain resumable but block changes fail closed", async () => {
  const repeated = fixture();
  const session = { cancelled: false };
  let attempts = 0;
  repeated.dependencies.executeBuild = (_bot, _build, options) => {
    attempts++;
    if (attempts < 3) {
      options.onCancel();
      return { status: "interrupted", errors: [] };
    }
    return { status: "finished", errors: [] };
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await buildSchematic(repeated.bot, "house.schem", null, null, null, { ...repeated.dependencies, resumeSession: session }), false);
    assert.equal(session.resumeEligible, true);
  }
  assert.equal(await buildSchematic(repeated.bot, "house.schem", null, null, null, { ...repeated.dependencies, resumeSession: session }), true);
  assert.equal(attempts, 3);

  const changed = fixture();
  const changedSession = { cancelled: false };
  changed.dependencies.executeBuild = (_bot, _build, options) => {
    options.onCancel();
    return { status: "interrupted", errors: [] };
  };
  assert.equal(await buildSchematic(changed.bot, "house.schem", null, null, null, { ...changed.dependencies, resumeSession: changedSession }), false);
  changed.bot.blockAt = () => ({ name: "dirt", getProperties: () => ({}) });
  let resumedRuns = 0;
  changed.dependencies.executeBuild = () => { resumedRuns++; return { status: "finished", errors: [] }; };
  assert.equal(await buildSchematic(changed.bot, "house.schem", null, null, null, { ...changed.dependencies, resumeSession: changedSession }), false);
  assert.equal(resumedRuns, 0);
  assert.equal(changedSession.context, null);
  assert.match(changed.calls.logs.join(" "), /World blocks no longer match/);
});

test("death, dimension changes, disconnects, failures, and unsettled cleanup prohibit resume", async () => {
  for (const boundary of ["death", "dimension", "disconnect"]) {
    const { bot, dependencies } = fixture();
    const session = { cancelled: false };
    dependencies.executeBuild = (_bot, _build, options) => {
      options.onCancel();
      return { status: "interrupted", errors: [] };
    };
    assert.equal(await buildSchematic(bot, "house.schem", null, null, null, { ...dependencies, resumeSession: session }), false);
    if (boundary === "death") bot.health = 0;
    if (boundary === "dimension") bot.game.dimension = "nether";
    if (boundary === "disconnect") bot._client = { ended: true };
    let resumedRuns = 0;
    dependencies.executeBuild = () => { resumedRuns++; return { status: "finished", errors: [] }; };
    assert.equal(await buildSchematic(bot, "house.schem", null, null, null, { ...dependencies, resumeSession: session }), false);
    assert.equal(resumedRuns, 0, boundary);
    assert.equal(session.context, null, boundary);
  }

  const failed = fixture();
  const failedSession = { cancelled: false };
  failed.dependencies.executeBuild = () => ({ status: "error", errors: [new Error("placement failed")] });
  assert.equal(await buildSchematic(failed.bot, "house.schem", null, null, null, { ...failed.dependencies, resumeSession: failedSession }), false);
  assert.equal(failedSession.context, null);

  const cleanup = fixture({ startSupply: () => {
    const cancel = () => new Promise(() => {});
    cancel.cancel = () => {};
    cancel.abort = () => {};
    return cancel;
  }, cleanupTimeoutMs: 5 });
  const cleanupSession = { cancelled: false };
  cleanup.dependencies.executeBuild = (_bot, _build, options) => {
    options.onCancel();
    return { status: "interrupted", errors: [] };
  };
  assert.equal(await buildSchematic(cleanup.bot, "house.schem", null, null, null, { ...cleanup.dependencies, resumeSession: cleanupSession }), false);
  assert.equal(cleanupSession.context, null);
  assert.match(cleanup.calls.logs.join(" "), /cleanup timed out/);
});
