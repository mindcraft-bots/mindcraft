import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { gzipSync } from "node:zlib";

import { SCHEMATICS_DIR } from "../../src/utils/schematic/paths.js";

const require = createRequire(import.meta.url);
const nbt = require("prismarine-nbt");
const minecraftData = require("minecraft-data");
const Vec3 = require("vec3");
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const rootSettingsPath = path.resolve(SCHEMATICS_DIR, "../settings.js");
let createdSettingsStub = false;
let ActionManager;
let Agent;
let initModes;
let executeCommand;
let modulesLoaded;

async function loadProjectModules() {
  if (!modulesLoaded) {
    modulesLoaded = (async () => {
      try {
        await access(rootSettingsPath);
      } catch {
        await writeFile(rootSettingsPath, "export default {};\n", { flag: "wx" });
        createdSettingsStub = true;
      }
      [{ ActionManager }, { Agent }, { initModes }, { executeCommand }] = await Promise.all([
        import("../../src/agent/action_manager.js"),
        import("../../src/agent/agent.js"),
        import("../../src/agent/modes.js"),
        import("../../src/agent/commands/index.js"),
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
      DataVersion: { type: "int", value: 3465 },
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
    registry: minecraftData("1.20.4"),
    game: { gameMode: "survival", dimension: "overworld" },
    world: {},
    _client: Object.assign(new EventEmitter(), { ended: false, socket: { destroyed: false } }),
    entity: { position: new Vec3(0, 64, 0) },
    position: new Vec3(0, 64, 0),
    output: "",
    interrupt_code: false,
    inventory: { slots: Array(46).fill(null) },
    health: 20,
    blockAt(position) {
      return world.get(key(position)) ?? { name: "air", getProperties: () => ({}) };
    },
    async dig() {},
    async placeBlock() {},
    async chat(message) {
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
  return { agent, bot, calls, fileName };
}

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
  const fileName = `recovery_e2e_${process.pid}.schem`;
  const filePath = path.join(SCHEMATICS_DIR, fileName);
  await writeFile(filePath, singleStoneSchematic());
  const { agent, calls } = makeLifecycle(fileName);
  try {
    const command = `!buildSchematic("${fileName}", 0, 64, 0)`;
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
  }
});

test("trusted stop during schematic cleanup cancels the not-yet-registered recovery", async () => {
  await loadProjectModules();
  const fileName = `recovery_cancel_e2e_${process.pid}.schem`;
  const filePath = path.join(SCHEMATICS_DIR, fileName);
  await writeFile(filePath, singleStoneSchematic());
  const { agent, calls } = makeLifecycle(fileName, { delayRestore: true });
  Object.setPrototypeOf(agent, Agent.prototype);
  try {
    const build = executeCommand(agent, `!buildSchematic("${fileName}", 0, 64, 0)`);
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
  }
});

test("replacement action cancels a managed schematic session before resume registration", async () => {
  await loadProjectModules();
  const fileName = `recovery_replace_e2e_${process.pid}.schem`;
  const filePath = path.join(SCHEMATICS_DIR, fileName);
  await writeFile(filePath, singleStoneSchematic());
  const { agent, calls } = makeLifecycle(fileName, { delayRestore: true });
  try {
    const build = executeCommand(agent, `!buildSchematic("${fileName}", 0, 64, 0)`);
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
  }
});

test("mode polling reserves an interrupt transition and treats temporary not-ready as retryable", async () => {
  await loadProjectModules();
  const { agent, bot } = makeLifecycle("unused.schem");
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
  agent.actions.registerResume("action:buildSchematic", async () => { attempts++; }, {
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
