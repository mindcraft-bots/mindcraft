import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { buildSchematic } from "../../src/utils/schematic/build_schematic.js";

const require = createRequire(import.meta.url);
const nbt = require("prismarine-nbt");

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
}

function fixture(overrides = {}) {
  const calls = { logs: [], modes: [], positions: [], paused: false, cancelled: 0, cleaned: 0, aborted: 0 };
  const bot = {
    version: "1.20.4",
    game: { gameMode: "survival" },
    position: new FakeVec3(1.2, 64.9, -3.2),
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
  };
  const build = {
    plan: [{ position: { x: 3, y: 64, z: 5 }, name: "stone", properties: { axis: "y" } }],
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
  return { bot, build, calls, dependencies };
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

test("floors three finite coordinates and otherwise uses bot position offset and floor", async () => {
  const explicit = fixture();
  assert.equal(await buildSchematic(explicit.bot, "house.schem", 10.9, -4.2, 7, explicit.dependencies), true);
  assert.deepEqual(explicit.calls.startPosition, new FakeVec3(10, -5, 7));

  const fallback = fixture();
  assert.equal(await buildSchematic(fallback.bot, "house.schem", 10, Number.NaN, 7, fallback.dependencies), true);
  assert.deepEqual(fallback.calls.startPosition, new FakeVec3(3, 64, -2));
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
  assert.equal(calls.positions.length, 1);
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
    resolvePath: () => '/schematics/schems/pack1/02_bee_hot_air_balloon.schem',
  });
  assert.equal(await buildSchematic(bot, 'pack1:2:1', null, null, null, dependencies), true);
  assert.equal(calls.logs.at(-1), 'Successfully built and verified schematic 02_bee_hot_air_balloon.schem.');
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
  assert.match(mismatch.calls.logs.join(" "), /expected stone, found dirt/);

  const wrongProperty = fixture();
  wrongProperty.bot.blockAt = () => ({ name: "stone", getProperties: () => ({ axis: "x" }) });
  assert.equal(await buildSchematic(wrongProperty.bot, "house.schem", null, null, null, wrongProperty.dependencies), false);
  assert.match(wrongProperty.calls.logs.join(" "), /expected stone axis=y, found x/);
  assert.match(wrongProperty.calls.logs.join(" "), /limited orientation metadata/);

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
