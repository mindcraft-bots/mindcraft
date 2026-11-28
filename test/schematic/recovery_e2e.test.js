import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";
import { setImmediate } from "node:timers";
import { gzipSync } from "node:zlib";

import { SCHEMATICS_DIR } from "../../src/utils/schematic/paths.js";
import agentSettings from "../../src/agent/settings.js";
import { writeFixtureProvenance } from "./provenance_fixture.js";
import { syntheticSponge } from "./synthetic_sponge.js";
import { loadSchematicBuilder } from "../../src/utils/schematic/builder_compat.js";

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
    _client: Object.assign(new EventEmitter(), { ended: false, socket: { destroyed: false }, write() {} }),
    supportFeature: name => ["usesMultiblockSingleLong", "usesMultiblock3DChunkCoords", "blockPlaceHasInsideBlock"].includes(name),
    digTime: () => 0,
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

test("addressed balanced builds refuse an existing match at the selected site", async () => {
  await loadProjectModules();
  const pack = `pack${1000000 + process.pid}`;
  const directory = path.join(SCHEMATICS_DIR, "schems", pack);
  await mkdir(directory);
  const filePath = path.join(directory, "balanced.mc1.20.3.schem");
  const bytes = singleStoneSchematic();
  const old = [agentSettings.schematic_placement_mode, agentSettings.schematic_balanced_radius, agentSettings.schematic_balanced_threshold, agentSettings.schematic_balanced_strategy, agentSettings.schematic_continuation_policy];
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
    world.set("-1,64,0", Block.fromStateId(registry.blocksByName.stone.defaultState, 0));
    const origins = [];
    bot.builder.build = build => { origins.push({ ...build.cells[0].position }); build.actions.length = 0; return Promise.resolve(); };
    agentSettings.schematic_placement_mode = "balanced";
    agentSettings.schematic_balanced_radius = 0;
    agentSettings.schematic_balanced_threshold = 1;
    agentSettings.schematic_balanced_strategy = "all";
    assert.equal(await dispatchAddressedSchematicRequest(agent, "trusted", `Builder build id 1 from group 2 of ${pack} using balanced mode radius=1`, { trusted: true }), true);
    assert.deepEqual(origins, []);
    agentSettings.schematic_balanced_radius = 1;
    bot.output = "";
    assert.equal(await dispatchAddressedSchematicRequest(agent, "trusted", `Builder build id 1 from group 2 of ${pack}`, { trusted: true }), true);
    assert.deepEqual(origins, []);
    assert.deepEqual(calls.mode, []);
    agentSettings.schematic_continuation_policy = "off";
    agentSettings.schematic_balanced_radius = 0;
    assert.equal(await dispatchAddressedSchematicRequest(agent, "trusted", `Builder build id 1 from group 2 of ${pack} using balanced mode radius=1`, { trusted: true }), true);
    assert.deepEqual(origins, [{ x: -1, y: 64, z: 0 }]);
    assert.match(responses.join(" "), /Balanced site: origin -1,64,0/);
    agentSettings.schematic_balanced_radius = 1;
    bot.output = "";
    assert.equal(await dispatchAddressedSchematicRequest(agent, "trusted", `Builder build id 1 from group 2 of ${pack}`, { trusted: true }), true);
    assert.deepEqual(origins, [{ x: -1, y: 64, z: 0 }, { x: -1, y: 64, z: 0 }]);
    assert.deepEqual(calls.mode, ["creative", "survival", "creative", "survival"]);
  } finally {
    [agentSettings.schematic_placement_mode, agentSettings.schematic_balanced_radius, agentSettings.schematic_balanced_threshold, agentSettings.schematic_balanced_strategy, agentSettings.schematic_continuation_policy] = old;
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

test("combat recovery refuses unreadable air state before registration across policies", async () => {
  await loadProjectModules();
  const fileName = `recovery_unreadable_${process.pid}.mc1.20.3.schem`;
  const filePath = path.join(SCHEMATICS_DIR, fileName);
  const bytes = singleStoneSchematic();
  await writeFile(filePath, bytes, { flag: "wx" });
  writeFixtureProvenance(filePath, bytes);
  const previous = agentSettings.schematic_continuation_policy;
  try {
    for (const policy of ["ask", "allow", "deny", "off"]) {
      for (const scenario of ["unchanged", "retry-throw", "throw", "hostile-alias", "hostile-fallback", "private-getter", "null-properties", "array-properties", "invalid-property", "null-block", "null-state", "invalid-air", "computed-air", "wrong-air-id", "unknown-air-id", "changed-air",
        ...["entity", "blockEntity", "_blockEntity", "nbt"].flatMap(key => [`inherited-data:${key}`, `inherited-getter:${key}`, `own-getter:${key}`]), "proxy-block", "proxy-prototype", "vanilla-entity"]) {
        agentSettings.schematic_continuation_policy = policy;
        const { agent, bot } = makeLifecycle(fileName);
        const originalBlockAt = bot.blockAt.bind(bot);
        let changed = false, started = 0, release, unreadableReads = 0, getterCalls = 0, observedBlock;
        const alias = { nested: { changed: false } };
        const writes = [], output = [];
        bot.blockAt = position => {
          const block = originalBlockAt(position);
          if (!changed || position.x !== 0 || position.y !== 64 || position.z !== 0) return block;
          unreadableReads++;
          if (scenario === "null-block") return null;
          if (scenario === "changed-air") {
            const other = Block.fromStateId(registry.blocksByName.cave_air.defaultState, 0);
            other.position = position;
            return other;
          }
          if (scenario === "computed-air") {
            if (!observedBlock) {
              observedBlock = block;
              observedBlock.computedStates.invalid = true;
            }
            return observedBlock;
          }
          if (scenario.startsWith("inherited-") || scenario.startsWith("own-getter:")) {
            const [kind, key] = scenario.split(":");
            const prototype = { getProperties: Block.prototype.getProperties };
            const candidate = Object.assign(Object.create(prototype), {
              name: block.name, stateId: block.stateId, _properties: {}, computedStates: {},
            });
            const target = kind === "own-getter" ? candidate : prototype;
            Object.defineProperty(target, key, kind === "inherited-data"
              ? { value: alias } : { get() { getterCalls++; throw new Error("unsafe entity getter"); } });
            observedBlock = candidate;
            return candidate;
          }
          if (scenario === "proxy-block") return new Proxy(block, { getOwnPropertyDescriptor() { getterCalls++; throw Error("proxy trap"); } });
          if (scenario === "proxy-prototype") {
            const prototype = new Proxy({}, { getOwnPropertyDescriptor() { getterCalls++; throw Error("proxy trap"); }, getPrototypeOf() { getterCalls++; throw Error("proxy trap"); } });
            return Object.assign(Object.create(prototype), { name: block.name, stateId: block.stateId, properties: {} });
          }
          if (scenario === "vanilla-entity") {
            block.entity = { type: "compound", value: {} };
            observedBlock = block;
            return block;
          }
          if (scenario === "null-state") block.stateId = null;
          if (scenario === "wrong-air-id") block.stateId = registry.blocksByName.stone.defaultState;
          if (scenario === "unknown-air-id") block.stateId = 999999999;
          if (scenario === "private-getter") {
            class PrivateBlock {
              #properties = {};
              constructor() { this.name = "air"; this.stateId = registry.blocksByName.air.defaultState; }
              getProperties() { getterCalls++; return this.#properties; }
            }
            return new PrivateBlock();
          }
          if (scenario === "hostile-fallback") return { name: "air", stateId: registry.blocksByName.air.defaultState, alias,
            getProperties() { getterCalls++; this.alias.nested.changed = true; return {}; } };
          if (scenario === "hostile-alias") {
            block.alias = alias;
            block.getProperties = function () { getterCalls++; this.alias.nested.changed = true; return {}; };
          }
          if (scenario === "throw" || scenario === "retry-throw") block.getProperties = () => { getterCalls++; throw new Error("unreadable"); };
          if (scenario === "null-properties") block.getProperties = () => null;
          if (scenario === "array-properties") block.getProperties = () => [];
          if (scenario === "invalid-property") block.getProperties = () => ({ invalid: {} });
          if (scenario === "invalid-air") block.getProperties = () => ({ invalid: true });
          return block;
        };
        bot._client.write = name => { if (name === "block_dig" || name === "block_place") writes.push(name); };
        agent.clearBotLogs = () => { output.push(bot.output); bot.output = ""; bot.interrupt_code = false; };
        bot.builder.build = () => { started++; return new Promise(resolve => { release = resolve; }); };
        bot.builder.stop = () => release?.();
        const building = executeCommand(agent, `!buildSchematic("${fileName}", 0, 64, 0, "balanced", 0)`);
        await waitFor(() => started === 1, `${policy}/${scenario} pre-edit builder`);
        changed = scenario !== "retry-throw";
        await interruptWithCombat(agent, building);
        const eligible = ["unchanged", "retry-throw"].includes(scenario) || (policy === "off" && ["changed-air", "vanilla-entity"].includes(scenario));
        assert.equal(typeof agent.actions.resume_func === "function", eligible, `${policy}/${scenario}: ${output.join(" ")}`);
        assert.deepEqual(writes, [], `${policy}/${scenario}: no edit packets`);
        assert.equal(getterCalls, 0, `${policy}/${scenario}: no observed getter calls`);
        assert.deepEqual(alias, { nested: { changed: false } });
        if (scenario.startsWith("inherited-") || scenario.startsWith("own-getter:")) {
          assert.deepEqual(observedBlock._properties, {}, `${policy}/${scenario}: state remains unchanged`);
          assert.deepEqual(observedBlock.computedStates, {}, `${policy}/${scenario}: computed state remains unchanged`);
        }
        if (scenario === "computed-air") assert.deepEqual(observedBlock._properties, {}, `${policy}: recovery reads do not mutate cached properties`);
        if (scenario === "vanilla-entity") assert.deepEqual(observedBlock.entity, { type: "compound", value: {} });
        if (!eligible) {
          assert.equal((await agent.actions.resumeAction()).success, false, `${policy}/${scenario}: no retry`);
          assert.equal(started, 1);
          assert.deepEqual(writes, []);
        } else if (scenario === "retry-throw") {
          changed = true;
          await agent.actions.resumeAction();
          assert.equal(agent.actions.resume_func, null, `${policy}: failed retry cannot be registered again`);
          assert.equal(started, 1);
          assert.ok(unreadableReads > 0, `${policy}: retry actually inspected the unreadable state`);
          assert.equal(getterCalls, 0, `${policy}: retry does not invoke getter`);
          assert.deepEqual(writes, []);
        } else if (scenario === "unchanged") {
          const retry = agent.actions.resumeAction();
          await waitFor(() => started === 2, `${policy} valid pre-edit recovery`);
          await interruptWithCombat(agent, retry);
          assert.equal(typeof agent.actions.resume_func, "function", `${policy}: repeated recovery`);
          assert.deepEqual(writes, []);
        }
      }
    }
  } finally {
    agentSettings.schematic_continuation_policy = previous;
    await rm(filePath, { force: true });
    await rm(`${filePath}.provenance.json`, { force: true });
    await rm(`${filePath}.provenance.sha256`, { force: true });
  }
});

test("combat recovery checks clearing and unowned changes before registration under every policy", async () => {
  await loadProjectModules();
  const fileName = `recovery_clearing_${process.pid}.mc1.18.2.schem`;
  const filePath = path.join(SCHEMATICS_DIR, fileName);
  const bytes = syntheticSponge("1.18.2", ["minecraft:stone"]);
  await writeFile(filePath, bytes, { flag: "wx" });
  writeFixtureProvenance(filePath, bytes);
  const previous = agentSettings.schematic_continuation_policy;
  const data = minecraftData("1.18.2"), LegacyBlock = require("prismarine-block")("1.18.2");
  const key = p => `${p.x},${p.y},${p.z}`;
  try {
    for (const policy of ["ask", "allow", "deny", "off"]) {
      for (const scenario of ["unchanged", "cleared", "restored", "external", "protected", "unloaded", "forged", "forged-unchanged", "forged-event", "forged-event-changed", "stale-callback"]) {
        agentSettings.schematic_continuation_policy = policy;
        const { agent, bot, world } = makeLifecycle(fileName);
        bot.version = "1.18.2"; bot.registry = data;
        bot.entity.position = new Vec3(-2.31, 63.5, 0.5);
        bot.blockAt = position => {
          if (world.has(key(position)) && world.get(key(position)) === null) return null;
          const name = world.get(key(position)) ?? (position.y === 63 ? "dirt" : "air");
          const block = LegacyBlock.fromStateId(data.blocksByName[name].defaultState, 0);
          block.position = position;
          return block;
        };
        if (["cleared", "restored"].includes(scenario)) world.set("0,64,0", "poppy");
        const writes = [], output = [];
        agent.clearBotLogs = () => { output.push(bot.output); bot.output = ""; bot.interrupt_code = false; };
        bot.lookAt = async () => {};
        bot.swingArm = () => {};
        bot._client.write = (name, packet) => {
          if (name === "block_place") {
            writes.push({ kind: "place", interrupted: bot.interrupt_code });
            return;
          }
          if (name !== "block_dig") return;
          writes.push({ kind: "dig", status: packet.status, interrupted: bot.interrupt_code });
          setImmediate(() => {
            const old = bot.blockAt(packet.location);
            world.set(key(packet.location), "air");
            const air = bot.blockAt(packet.location);
            bot.emit(`blockUpdate:${packet.location}`, old, air);
            bot._client.emit("block_change", { location: packet.location, type: air.stateId });
            bot._client.emit("acknowledge_player_digging", { location: packet.location, block: air.stateId, status: packet.status, successful: true });
          });
        };
        let started = 0, release, callback;
        bot.builder.build = build => {
          if (scenario === "external") world.set("0,64,0", "poppy");
          if (scenario === "protected") world.set("0,64,0", "chest");
          if (scenario === "unloaded") world.set("0,64,0", null);
          if (scenario === "forged") world.set("0,64,0", "stone");
          if (scenario === "forged" || scenario === "forged-unchanged") build.afterSchematicEdit(new Vec3(0, 64, 0));
          if (scenario === "forged-event-changed") world.set("0,64,0", "stone");
          if (scenario.startsWith("forged-event")) bot.emit("schematicEditAuthorization", { phase: "server-confirmed", kind: "dig", position: new Vec3(0, 64, 0) });
          if (scenario === "restored") world.set("0,64,0", "poppy");
          callback = build.afterSchematicEdit;
          started++;
          return new Promise(resolve => { release = resolve; });
        };
        bot.builder.stop = () => {
          if (scenario === "stale-callback") {
            world.set("0,64,0", "stone");
            callback(new Vec3(0, 64, 0));
          }
          release?.();
        };
        let result;
        const building = executeCommand(agent, `!buildSchematic("${fileName}", 0, 64, 0, "balanced", 0)`)
          .then(value => { result = value; return value; });
        try { await waitFor(() => started === 1, `${policy}/${scenario} builder`); }
        catch (error) { throw new Error(`${error.message}; ${JSON.stringify(result)} ${output.join(" ")} ${bot.output}`, { cause: error }); }
        const beforeInterrupt = writes.length;
        await interruptWithCombat(agent, building);
        await delay(25);
        const safe = ["unchanged", "forged-unchanged", "forged-event"].includes(scenario)
          || (policy === "off" && scenario !== "unloaded");
        assert.equal(typeof agent.actions.resume_func === "function", safe, `${policy}/${scenario}: ${output.join(" ")}`);
        assert.equal(writes.length, beforeInterrupt, `${policy}/${scenario}: no post-interrupt edits`);
        assert.ok(writes.every(write => !write.interrupted));
        if (!safe) {
          assert.match(output.join(" "), /recovery refused: clearing occurred or the original volume changed/i, `${policy}/${scenario}`);
          assert.equal((await agent.actions.resumeAction()).success, false);
          assert.equal(writes.length, beforeInterrupt);
        }
        if (policy === "off" && scenario === "cleared") {
          const resumed = agent.actions.resumeAction();
          await waitFor(() => started === 2, "legacy recovery after clearing");
          assert.equal(writes.length, beforeInterrupt, "legacy retry reaches placement without another clearing dig");
          await interruptWithCombat(agent, resumed);
        }
        if (["cleared", "restored"].includes(scenario)) assert.ok(writes.some(write => write.kind === "dig"), `${policy}/${scenario} performed a real dig`);
        else assert.equal(beforeInterrupt, 0);
      }
    }
  } finally {
    agentSettings.schematic_continuation_policy = previous;
    await rm(filePath, { force: true });
    await rm(`${filePath}.provenance.json`, { force: true });
    await rm(`${filePath}.provenance.sha256`, { force: true });
  }
});

test("combat before clearing distinguishes unchanged from externally cleared poppies under every policy", async () => {
  await loadProjectModules();
  const fileName = `recovery_pre_clear_${process.pid}.mc1.18.2.schem`;
  const filePath = path.join(SCHEMATICS_DIR, fileName);
  const bytes = syntheticSponge("1.18.2", ["minecraft:stone"]);
  await writeFile(filePath, bytes, { flag: "wx" });
  writeFixtureProvenance(filePath, bytes);
  const previous = agentSettings.schematic_continuation_policy;
  const data = minecraftData("1.18.2"), LegacyBlock = require("prismarine-block")("1.18.2");
  try {
    for (const policy of ["ask", "allow", "deny", "off"]) for (const externalClear of [false, true]) {
      agentSettings.schematic_continuation_policy = policy;
      const { agent, bot, world } = makeLifecycle(fileName);
      bot.version = "1.18.2"; bot.registry = data;
      bot.entity.position = new Vec3(-2.31, 63.5, 0.5);
      world.set("0,64,0", "poppy");
      bot.blockAt = position => {
        const name = world.get(`${position.x},${position.y},${position.z}`) ?? (position.y === 63 ? "dirt" : "air");
        const block = LegacyBlock.fromStateId(data.blocksByName[name].defaultState, 0);
        block.position = position;
        return block;
      };
      let releaseCreative, writes = 0;
      const output = [];
      agent.clearBotLogs = () => { output.push(bot.output); bot.output = ""; bot.interrupt_code = false; };
      bot._client.write = name => { if (name === "block_dig" || name === "block_place") writes++; };
      bot.chat = message => {
        const mode = message.split(" ").at(-1);
        const acknowledge = () => { bot.game.gameMode = mode; bot.emit("game", { gameMode: mode }); };
        if (mode === "creative") releaseCreative = acknowledge;
        else acknowledge();
      };
      const building = executeCommand(agent, `!buildSchematic("${fileName}", 0, 64, 0, "balanced", 0)`);
      await waitFor(() => releaseCreative, `${policy} Creative transition`);
      const combat = agent.actions.runAction("mode:self_defense", async () => { await delay(10); });
      await waitFor(() => bot.interrupt_code, `${policy} combat interruption`);
      if (externalClear) world.set("0,64,0", "air");
      releaseCreative();
      await Promise.all([building, combat]);
      await delay(25);
      const eligible = !externalClear || policy === "off";
      assert.equal(typeof agent.actions.resume_func === "function", eligible, `${policy}/${externalClear}`);
      assert.equal(world.get("0,64,0"), externalClear ? "air" : "poppy", policy);
      if (!eligible) assert.match(output.join(" "), /recovery refused: clearing occurred or the original volume changed/i);
      assert.equal(writes, 0, policy);
    }
  } finally {
    agentSettings.schematic_continuation_policy = previous;
    await rm(filePath, { force: true });
    await rm(`${filePath}.provenance.json`, { force: true });
    await rm(`${filePath}.provenance.sha256`, { force: true });
  }
});

test("combat recovery requires registry-coherent observed states under every policy", async () => {
  await loadProjectModules();
  const fileName = `recovery_registry_${process.pid}.mc1.18.2.schem`;
  const filePath = path.join(SCHEMATICS_DIR, fileName);
  const bytes = syntheticSponge("1.18.2", ["minecraft:stone"]);
  await writeFile(filePath, bytes, { flag: "wx" });
  writeFixtureProvenance(filePath, bytes);
  const previous = agentSettings.schematic_continuation_policy;
  const data = minecraftData("1.18.2"), RuntimeBlock = require("prismarine-block")("1.18.2");
  try {
    for (const policy of ["ask", "allow", "deny", "off"]) {
      for (const scenario of ["valid", "unknown-id", "wrong-name", "wrong-properties", "wrong-axis", "missing-registry"]) {
        agentSettings.schematic_continuation_policy = policy;
        const { agent, bot } = makeLifecycle(fileName);
        bot.version = "1.18.2"; bot.registry = data;
        bot.entity.position = new Vec3(-2.31, 63.5, 0.5);
        let changed = false, releaseCreative, writes = 0;
        const output = [];
        bot.blockAt = position => {
          const target = position.x === 0 && position.y === 64 && position.z === 0;
          const name = target ? "poppy" : position.y === 63 ? "dirt" : "air";
          const block = RuntimeBlock.fromStateId(data.blocksByName[name].defaultState, 0);
          block.position = position;
          if (target && changed) {
            if (scenario === "unknown-id") block.stateId = 999999999;
            if (scenario === "wrong-name") block.stateId = data.blocksByName.stone.defaultState;
            if (scenario === "wrong-properties") block._properties = { axis: "x" };
            if (scenario === "wrong-axis") {
              const log = RuntimeBlock.fromProperties("oak_log", { axis: "x" }, 0);
              log._properties.axis = "z";
              log.position = position;
              return log;
            }
          }
          return block;
        };
        bot._client.write = name => { if (name === "block_dig" || name === "block_place") writes++; };
        agent.clearBotLogs = () => { output.push(bot.output); bot.output = ""; bot.interrupt_code = false; };
        bot.chat = message => {
          const mode = message.split(" ").at(-1);
          const acknowledge = () => { bot.game.gameMode = mode; bot.emit("game", { gameMode: mode }); };
          if (mode === "creative") releaseCreative = acknowledge; else acknowledge();
        };
        const building = executeCommand(agent, `!buildSchematic("${fileName}", 0, 64, 0, "balanced", 0)`);
        await waitFor(() => releaseCreative, `${policy}/${scenario} Creative transition`);
        const combat = agent.actions.runAction("mode:self_defense", async () => { await delay(10); });
        await waitFor(() => bot.interrupt_code, `${policy}/${scenario} combat interruption`);
        changed = true;
        if (scenario === "missing-registry") bot.registry = undefined;
        releaseCreative();
        await Promise.all([building, combat]);
        await delay(25);
        const eligible = scenario === "valid";
        assert.equal(typeof agent.actions.resume_func === "function", eligible, `${policy}/${scenario}: ${output.join(" ")}`);
        assert.equal(writes, 0, `${policy}/${scenario}: no edit packets`);
        if (!eligible) assert.equal((await agent.actions.resumeAction()).success, false);
      }
    }
  } finally {
    agentSettings.schematic_continuation_policy = previous;
    await rm(filePath, { force: true });
    await rm(`${filePath}.provenance.json`, { force: true });
    await rm(`${filePath}.provenance.sha256`, { force: true });
  }
});

test("combat recovery fails closed after a real confirmed partial placement in delicate and balanced modes", async () => {
  await loadProjectModules();
  const fileName = `recovery_partial_${process.pid}.mc1.20.3.schem`;
  const filePath = path.join(SCHEMATICS_DIR, fileName);
  const bytes = syntheticSponge("1.20.3", ["minecraft:stone", "minecraft:oak_planks"]);
  await writeFile(filePath, bytes, { flag: "wx" });
  writeFixtureProvenance(filePath, bytes);
  const previous = agentSettings.schematic_continuation_policy;
  try {
    for (const mode of ["delicate", "balanced"]) for (const policy of ["ask", "allow", "deny"]) {
      agentSettings.schematic_continuation_policy = policy;
      const { agent, bot, world } = makeLifecycle(fileName);
      bot.entity.position = new Vec3(-2.31, 63.5, 0.5);
      bot.inventory = Object.assign(new EventEmitter(), { slots: Array(46).fill(null), items() { return this.slots.filter(Boolean); } });
      bot.creative.setInventorySlot = (slot, item) => {
        const old = bot.inventory.slots[slot]; bot.inventory.slots[slot] = item;
        bot.inventory.emit(`updateSlot:${slot}`, old, item);
      };
      bot.equip = item => { bot.heldItem = item; return Promise.resolve(); };
      bot.swingArm = () => {};
      bot.loadPlugin = plugin => plugin(bot);
      loadSchematicBuilder(bot);
      let aims = 0, releaseAim;
      let blocked = false;
      bot.lookAt = async () => {
        if (++aims === 2) { blocked = true; await new Promise(resolve => { releaseAim = resolve; }); }
      };
      let placed = 0, confirmed = 0;
      bot.on("schematicEditAuthorization", event => { if (event.phase === "server-confirmed") confirmed++; });
      bot._client.write = (name, packet) => {
        if (name === "set_creative_slot") { setImmediate(() => bot.inventory.emit(`updateSlot:${packet.slot}`, null, null)); return; }
        if (name !== "block_place") return;
        placed++;
        const target = packet.location.offset(0, 1, 0);
        setImmediate(() => {
          const reference = bot.blockAt(packet.location);
          bot.emit(`blockUpdate:${packet.location}`, reference, reference);
          bot._client.emit("block_change", { location: packet.location, type: reference.stateId });
          const old = bot.blockAt(target);
          const block = Block.fromStateId(registry.blocksByName.stone.defaultState, 0); block.position = target;
          world.set(`${target.x},${target.y},${target.z}`, block);
          bot.emit(`blockUpdate:${target}`, old, block);
          bot._client.emit("block_change", { location: target, type: block.stateId });
        });
      };
      if (mode === "balanced") {
        let releaseBuilder;
        bot.builder.stop = () => releaseBuilder?.();
        bot.builder.build = async build => {
          const cell = build.cells[0];
          await bot.builder.equipItem(registry.itemsByName[cell.name].id);
          const reference = bot.blockAt(new Vec3(cell.position.x, cell.position.y - 1, cell.position.z));
          await bot.placeBlock(reference, new Vec3(0, 1, 0));
          await new Promise(resolve => { releaseBuilder = resolve; blocked = true; });
        };
      }
      const output = [];
      agent.clearBotLogs = () => { output.push(bot.output); bot.output = ""; bot.interrupt_code = false; };
      let result;
      const building = executeCommand(agent, `!buildSchematic("${fileName}", 0, 64, 0, "${mode}"${mode === "balanced" ? ", 0" : ""})`).then(value => { result = value; return value; });
      try { await waitFor(() => blocked, `${mode}/${policy} second placement aim`); }
      catch (error) { throw new Error(`${error.message}; result: ${JSON.stringify(result)}; output: ${output.join(" ")} ${bot.output}`, { cause: error }); }
      assert.equal(placed, 1); assert.equal(confirmed, 1);
      const combat = agent.actions.runAction("mode:self_defense", async () => { await delay(10); });
      await waitFor(() => bot.interrupt_code, "combat interruption");
      releaseAim?.();
      await Promise.all([building, combat]);
      assert.equal(agent.actions.resume_func, null, `${mode}/${policy}: ${output.join(" ")}`);
      assert.equal(placed, 1, `${mode}/${policy} must not place after refusal`);
      assert.match(output.join(" "), /recovery refused: prior placement updates cannot be attributed/i);
      assert.equal((await agent.actions.resumeAction()).success, false, "a consumed recovery cannot be replayed");
      assert.equal(placed, 1);
    }
  } finally {
    agentSettings.schematic_continuation_policy = previous;
    await rm(filePath, { force: true });
    await rm(`${filePath}.provenance.json`, { force: true });
    await rm(`${filePath}.provenance.sha256`, { force: true });
  }
});

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
