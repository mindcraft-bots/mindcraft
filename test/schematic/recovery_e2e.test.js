import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";
import { gzipSync } from "node:zlib";

import { SCHEMATICS_DIR } from "../../src/utils/schematic/paths.js";
import agentSettings from "../../src/agent/settings.js";
import { writeFixtureProvenance } from "./provenance_fixture.js";
import { syntheticSponge } from "./synthetic_sponge.js";

const require = createRequire(import.meta.url);
const nbt = require("prismarine-nbt");
const minecraftData = require("minecraft-data");
const Vec3 = require("vec3");
const Block = require("prismarine-block")("1.20.4");
const registry = minecraftData("1.20.4");
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const rootSettingsPath = path.resolve(SCHEMATICS_DIR, "../settings.js");
let createdSettingsStub = false;
let ActionManager;
let Agent;
let initModes;
let executeCommand;
let dispatchAddressedSchematicRequest;
let modulesLoaded;

async function loadProjectModules() {
  agentSettings.allow_nonvalidated_schematic_builds = true;
  if (!modulesLoaded) {
    modulesLoaded = (async () => {
      try {
        await access(rootSettingsPath);
      } catch {
        await writeFile(rootSettingsPath, "export default {};\n", { flag: "wx" });
        createdSettingsStub = true;
      }
      [{ ActionManager }, { Agent }, { initModes }, { executeCommand }, { dispatchAddressedSchematicRequest }] = await Promise.all([
        import("../../src/agent/action_manager.js"),
        import("../../src/agent/agent.js"),
        import("../../src/agent/modes.js"),
        import("../../src/agent/commands/index.js"),
        import("../../src/agent/schematic_request.js"),
      ]);
    })();
  }
  await modulesLoaded;
}

after(async () => {
  if (createdSettingsStub) await rm(rootSettingsPath, { force: true });
});

function singleStoneSchematic() {
  const root = {
    type: "compound",
    name: "Schematic",
    value: {
      Version: { type: "int", value: 2 },
      DataVersion: { type: "int", value: 3698 },
      Width: { type: "short", value: 1 },
      Height: { type: "short", value: 1 },
      Length: { type: "short", value: 1 },
      PaletteMax: { type: "int", value: 1 },
      Palette: { type: "compound", value: { "minecraft:stone": { type: "int", value: 0 } } },
      BlockData: { type: "byteArray", value: [0] },
    },
  };
  return gzipSync(nbt.writeUncompressed(root));
}

function makeLifecycle(fileName, { delayRestore = false } = {}) {
  const events = new EventEmitter();
  const world = new Map();
  const key = ({ x, y, z }) => `${x},${y},${z}`;
  const calls = { builds: 0, mode: [], logs: [], restoreStarted: null, releaseRestore: null };
  if (delayRestore) calls.restoreStarted = new Promise((resolve) => { calls.onRestoreStarted = resolve; });
  const bot = Object.assign(events, {
    version: "1.20.4",
    registry,
    game: { gameMode: "survival", dimension: "overworld" },
    world: {},
    _client: Object.assign(new EventEmitter(), { ended: false, socket: { destroyed: false } }),
    entity: { position: new Vec3(100, 64, 100), width: 0.6, height: 1.8 },
    position: new Vec3(0, 64, 0),
    output: "",
    interrupt_code: false,
    inventory: { slots: Array(46).fill(null) },
    health: 20,
    blockAt(position) {
      if (world.has(key(position))) return world.get(key(position));
      const block = Block.fromStateId(registry.blocksByName[position.y === 63 ? "dirt" : "air"].defaultState, 0);
      block.position = position;
      return block;
    },
    async dig() {},
    async placeBlock() {},
    chat(message) {
      const mode = message.split(" ").at(-1);
      this.game.gameMode = mode;
      calls.mode.push(mode);
      this.emit("game", { gameMode: mode });
    },
    creative: {
      async setInventorySlot(slot, item) {
        if (delayRestore && item == null && !calls.releaseRestore) {
          calls.onRestoreStarted();
          await new Promise((resolve) => { calls.releaseRestore = resolve; });
        }
        bot.inventory.slots[slot] = item;
      },
    },
    modes: {
      exists: (name) => name === "unstuck",
      isPaused: () => false,
      pause() {},
      unpause() {},
    },
    pathfinder: {
      movements: {},
      stop() {},
      setGoal() {},
      setMovements() {},
    },
    builder: {
      build(build) {
        calls.builds++;
        if (calls.builds < 3) {
          return new Promise((resolve) => {
            this.finishCurrent = resolve;
            this.currentBuild = build;
          });
        }
        for (const cell of build.cells) {
          const { x, y, z } = cell.position;
          world.set(`${x},${y},${z}`, { name: cell.name, getProperties: () => cell.properties });
        }
        build.actions.length = 0;
        return Promise.resolve();
      },
      stop() {
        this.finishCurrent?.();
        this.finishCurrent = null;
      },
      cancel() {},
    },
  });
  bot.entities = { self: bot.entity };
  bot.modes.pause = () => {};
  const agent = {
    bot,
    self_prompter: {
      isActive: () => false,
      handleUserPromptedCmd() {},
    },
    isIdle: () => !agent.actions.executing,
    requestInterrupt() { bot.interrupt_code = true; },
    clearBotLogs() { bot.output = ""; bot.interrupt_code = false; },
    getBotOutputSummary() { return ""; },
  };
  agent.actions = new ActionManager(agent);
  agent.name = "Builder";
  agent.routeResponse = async () => {};
  agent.checkTaskDone = async () => {};
  agent.shut_up = false;
  agent.blocked_actions = [];
  agent.history = { add() {}, save() {} };
  return { agent, bot, calls, fileName, world };
}

test("addressed balanced suffix and configured settings select an actual build origin", async () => {
  await loadProjectModules();
  const pack = `pack${1000000 + process.pid}`;
  const directory = path.join(SCHEMATICS_DIR, "schems", pack);
  await mkdir(directory);
  const filePath = path.join(directory, "balanced.mc1.20.3.schem");
  const bytes = singleStoneSchematic();
  const old = [agentSettings.schematic_placement_mode, agentSettings.schematic_balanced_radius, agentSettings.schematic_balanced_threshold, agentSettings.schematic_balanced_strategy];
  try {
    await writeFile(path.join(directory, "index.json"), JSON.stringify({ schemaVersion: 2, groups: { 2: { 1: "balanced.schem" } } }));
    await writeFile(filePath, bytes);
    writeFixtureProvenance(filePath, bytes);
    const { agent, bot, calls, world } = makeLifecycle("balanced.schem");
    const responses = [];
    agent.routeResponse = (_source, message) => { responses.push(message); };
    bot.position = new Vec3(-2, 64, -2);
    bot.entity.position = new Vec3(100, 64, 100);
    bot.entity.width = 0.6;
    bot.entity.height = 1.8;
    bot.entities = { 1: bot.entity };
    const getBlock = bot.blockAt.bind(bot);
    bot.blockAt = position => position.y === 63
      ? { name: "dirt", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) }
      : getBlock(position);
    world.set("-1,64,0", { name: "stone", getProperties: () => ({}) });
    const origins = [];
    bot.builder.build = build => { origins.push({ ...build.cells[0].position }); build.actions.length = 0; return Promise.resolve(); };
    agentSettings.schematic_placement_mode = "balanced";
    agentSettings.schematic_balanced_radius = 0;
    agentSettings.schematic_balanced_threshold = 1;
    agentSettings.schematic_balanced_strategy = "all";
    assert.equal(await dispatchAddressedSchematicRequest(agent, "trusted", `Builder build id 1 from group 2 of ${pack} using balanced mode radius=1`, { trusted: true }), true);
    assert.deepEqual(origins, [{ x: -1, y: 64, z: 0 }]);
    assert.match(responses.join(" "), /Balanced site: origin -1,64,0/);
    agentSettings.schematic_balanced_radius = 1;
    bot.output = "";
    assert.equal(await dispatchAddressedSchematicRequest(agent, "trusted", `Builder build id 1 from group 2 of ${pack}`, { trusted: true }), true);
    assert.deepEqual(origins, [{ x: -1, y: 64, z: 0 }, { x: -1, y: 64, z: 0 }]);
    assert.deepEqual(calls.mode, ["creative", "survival", "creative", "survival"]);
  } finally {
    [agentSettings.schematic_placement_mode, agentSettings.schematic_balanced_radius, agentSettings.schematic_balanced_threshold, agentSettings.schematic_balanced_strategy] = old;
    await rm(directory, { recursive: true, force: true });
  }
});

test("addressed orientation reaches the real skill and produces rotated build cells", async () => {
  await loadProjectModules();
  const pack = `pack${2000000 + process.pid}`;
  const directory = path.join(SCHEMATICS_DIR, "schems", pack);
  await mkdir(directory);
  const filePath = path.join(directory, "oriented.mc1.20.3.schem");
  const bytes = syntheticSponge("1.20.3", ["minecraft:stone", "minecraft:air", "minecraft:glass"]);
  const old = [agentSettings.schematic_placement_mode, agentSettings.schematic_balanced_radius, agentSettings.schematic_balanced_threshold];
  try {
    await writeFile(path.join(directory, "index.json"), JSON.stringify({ schemaVersion: 2, groups: { 2: { 1: "oriented.schem" } } }));
    await writeFile(filePath, bytes);
    writeFixtureProvenance(filePath, bytes);
    const { agent, bot, world } = makeLifecycle("oriented.schem");
    bot.position = new Vec3(-2, 64, -2);
    agentSettings.schematic_placement_mode = "balanced";
    agentSettings.schematic_balanced_radius = 0;
    agentSettings.schematic_balanced_threshold = 9;
    let cells, dimensions;
    bot.builder.build = build => {
      cells = build.cells.map(cell => ({ name: cell.name, position: { ...cell.position } }));
      dimensions = build.dimensions;
      for (const cell of build.cells) world.set(`${cell.position.x},${cell.position.y},${cell.position.z}`, { name: cell.name, stateId: cell.stateId, getProperties: () => cell.properties });
      build.actions.length = 0;
      return Promise.resolve();
    };
    const responses = [];
    agent.routeResponse = (_source, message) => responses.push(message);
    assert.equal(await dispatchAddressedSchematicRequest(agent, "trusted", `Builder build id 1 from group 2 of ${pack} rotated to face E`, { trusted: true }), true);
    assert.deepEqual(dimensions, { width: 1, height: 1, length: 3 }, responses.join(' | ') + bot.output);
    assert.deepEqual(cells.map(cell => cell.name), ["stone", "air", "glass"]);
    assert.equal(cells[2].position.x, cells[0].position.x);
    assert.equal(cells[2].position.z - cells[0].position.z, 2);
    assert.equal(world.get(`${cells[2].position.x},${cells[2].position.y},${cells[2].position.z}`).name, "glass");
    assert.match(responses.join(" "), /Successfully built and verified/);
  } finally {
    [agentSettings.schematic_placement_mode, agentSettings.schematic_balanced_radius, agentSettings.schematic_balanced_threshold] = old;
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${message}`);
    await delay(5);
  }
}

async function interruptWithCombat(agent, buildPromise) {
  await agent.actions.runAction("mode:self_defense", async () => { await delay(10); });
  await buildPromise;
}

test("public build command retains eligible interrupted session across repeated combat recovery", async () => {
  await loadProjectModules();
  const fileName = `recovery_e2e_${process.pid}.mc1.20.3.schem`;
  const filePath = path.join(SCHEMATICS_DIR, fileName);
  await writeFile(filePath, singleStoneSchematic());
  writeFixtureProvenance(filePath, singleStoneSchematic());
  const { agent, calls } = makeLifecycle(fileName);
  try {
    const command = `!buildSchematic("${fileName}", 0, 64, 0, "balanced", 0)`;
    const first = executeCommand(agent, command);
    await waitFor(() => calls.builds === 1, "first real schematic builder invocation");
    const firstMode = agent.actions.runAction("mode:self_defense", async () => { await delay(10); });
    await first;
    await firstMode;
    assert.equal(typeof agent.actions.resume_func, "function");

    const second = agent.actions.resumeAction();
    await waitFor(() => calls.builds === 2, "first recovery attempt");
    const secondMode = agent.actions.runAction("mode:cowardice", async () => { await delay(10); });
    await second;
    await secondMode;
    assert.equal(typeof agent.actions.resume_func, "function", "a repeated combat interruption remains resumable");

    const third = await agent.actions.resumeAction();
    assert.equal(third.success, true);
    assert.equal(calls.builds, 3);
    assert.equal(agent.actions.resume_func, null);
  } finally {
    await rm(filePath, { force: true });
    await rm(`${filePath}.provenance.json`, { force: true });
    await rm(`${filePath}.provenance.sha256`, { force: true });
  }
});

test("trusted stop during schematic cleanup cancels the not-yet-registered recovery", async () => {
  await loadProjectModules();
  const fileName = `recovery_cancel_e2e_${process.pid}.mc1.20.3.schem`;
  const filePath = path.join(SCHEMATICS_DIR, fileName);
  await writeFile(filePath, singleStoneSchematic());
  writeFixtureProvenance(filePath, singleStoneSchematic());
  const { agent, calls } = makeLifecycle(fileName, { delayRestore: true });
  Object.setPrototypeOf(agent, Agent.prototype);
  try {
    const build = executeCommand(agent, `!buildSchematic("${fileName}", 0, 64, 0, "balanced", 0)`);
    await waitFor(() => calls.builds === 1, "schematic builder invocation before stop");
    const mode = agent.actions.runAction("mode:self_defense", async () => { await delay(10); });
    await calls.restoreStarted;
    const stop = Agent.prototype.handleMessage.call(agent, "trusted-player", "!stop");
    await waitFor(() => agent.actions.managedResumeSessions.size === 0, "managed session cancellation before registration");
    calls.releaseRestore?.();
    await Promise.all([build, mode, stop]);
    assert.equal(agent.actions.resume_func, null);
    assert.equal(calls.builds, 1, "cancelled recovery never invokes the public skill again");
  } finally {
    calls.releaseRestore?.();
    await rm(filePath, { force: true });
    await rm(`${filePath}.provenance.json`, { force: true });
    await rm(`${filePath}.provenance.sha256`, { force: true });
  }
});

test("replacement action cancels a managed schematic session before resume registration", async () => {
  await loadProjectModules();
  const fileName = `recovery_replace_e2e_${process.pid}.mc1.20.3.schem`;
  const filePath = path.join(SCHEMATICS_DIR, fileName);
  await writeFile(filePath, singleStoneSchematic());
  writeFixtureProvenance(filePath, singleStoneSchematic());
  const { agent, calls } = makeLifecycle(fileName, { delayRestore: true });
  try {
    const build = executeCommand(agent, `!buildSchematic("${fileName}", 0, 64, 0, "balanced", 0)`);
    await waitFor(() => calls.builds === 1, "schematic builder invocation before replacement");
    const mode = agent.actions.runAction("mode:self_defense", async () => { await delay(10); });
    await calls.restoreStarted;
    const replacement = agent.actions.runAction("action:goToPlayer", async () => {});
    await waitFor(() => agent.actions.managedResumeSessions.size === 0, "managed session cancellation on replacement");
    calls.releaseRestore?.();
    await Promise.all([build, mode, replacement]);
    assert.equal(agent.actions.resume_func, null);
    assert.equal(calls.builds, 1, "replacement prevents schematic resurrection");
  } finally {
    calls.releaseRestore?.();
    await rm(filePath, { force: true });
    await rm(`${filePath}.provenance.json`, { force: true });
    await rm(`${filePath}.provenance.sha256`, { force: true });
  }
});

test("mode polling reserves an interrupt transition and treats temporary not-ready as retryable", async () => {
  await loadProjectModules();
  const { agent, bot } = makeLifecycle("unused.schem");
  bot.entity.position = new Vec3(0, 64, 0);
  let resolvePath;
  let findEnemy = true;
  bot.nearestEntity = (predicate) => {
    if (!findEnemy) return null;
    const enemy = { name: "zombie", type: "mob", position: new Vec3(6, 64, 0) };
    return predicate(enemy) ? enemy : null;
  };
  bot.pathfinder.getPathTo = () => new Promise((resolve) => { resolvePath = resolve; });
  bot.pathfinder.goto = async () => {};
  bot.pvp = { attack() { findEnemy = false; }, stop() {} };
  bot.inventory.items = () => [];
  agent.prompter = {
    getInitModes: () => ({ self_preservation: false, unstuck: false, cowardice: false, self_defense: true }),
  };
  initModes(agent);
  let attempts = 0;
  const build = agent.actions.runAction("action:buildSchematic", async () => {
    while (!bot.interrupt_code) await delay(1);
  });
  await waitFor(() => agent.actions.executing, "schematic action start");
  const polling = bot.modes.update();
  await waitFor(() => agent.actions.transitionReservations > 0, "combat mode readiness reservation");
  bot.interrupt_code = true;
  await build;
  agent.actions.registerResume("action:buildSchematic", () => { attempts++; }, {
    guard: () => true,
    cancelOnReplacement: true,
  });
  const early = await agent.actions.resumeAction();
  assert.equal(early.success, false);
  assert.equal(attempts, 0);
  assert.equal(typeof agent.actions.resume_func, "function");
  resolvePath({ status: "success" });
  await polling;
  await waitFor(() => !agent.actions.executing, "combat mode completion");
  const resumed = await agent.actions.resumeAction();
  assert.equal(resumed.success, true);
  assert.equal(attempts, 1);
});
