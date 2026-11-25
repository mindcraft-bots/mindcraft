import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

import { beginCreativeSupply, loadSchematicBuilder } from "../../src/utils/schematic/builder_compat.js";
import { buildSchematic } from "../../src/utils/schematic/build_schematic.js";
import { runBuild } from "../../src/utils/schematic/run_build.js";
import { resolvePlacementOptions } from "../../src/utils/schematic/placement_options.js";
import { provenanceFixtureDependencies } from "./provenance_fixture.js";

const require = createRequire(import.meta.url);
const Vec3 = require("vec3");
const minecraftData = require("minecraft-data");
const prismarineItem = require("prismarine-item");
const realCreativePlugin = require("mineflayer/lib/plugins/creative");
const VERSION = "1.20.4";
const registry = minecraftData(VERSION);
const Item = prismarineItem(VERSION);
const stoneState = registry.blocksByName.stone.defaultState;
const Block = require("prismarine-block")(VERSION);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createBot({ realCreative = false, gameMode = "survival", supplyAckDelayMs = 6_000 } = {}) {
  const bot = new EventEmitter();
  const calls = { modes: [], supply: [], serverWrites: [], events: [], equip: [], chat: [], look: [], place: [], dig: [], movement: [] };
  const target = new Vec3(0, 64, 0);
  const support = target.offset(0, -1, 0);
  const lookGate = deferred();
  const lookStarted = deferred();
  let blockPlaced = false;
  let unstuckPaused = false;

  const inventory = Object.assign(new EventEmitter(), {
    slots: Array(46).fill(null),
    items() { return this.slots.filter(Boolean); },
  });
  Object.assign(bot, {
    version: VERSION,
    registry,
    game: { gameMode, dimension: "overworld" },
    world: {},
    _client: Object.assign(new EventEmitter(), { ended: false, socket: { destroyed: false } }),
    entity: { position: new Vec3(0, 64, 2), width: 0.6, height: 1.8 },
    position: new Vec3(0, 64, 2),
    interrupt_code: false,
    modes: {
      exists(name) { return name === "unstuck"; },
      isPaused() { return unstuckPaused; },
      pause(name) { calls.events.push({ type: "unstuck", action: "pause", name }); unstuckPaused = true; },
      unpause(name) { calls.events.push({ type: "unstuck", action: "unpause", name }); unstuckPaused = false; },
    },
    inventory,
    equip(item, destination) { calls.equip.push({ item, destination }); },
    chat(...args) {
      calls.chat.push(args);
      const match = /^\/gamemode (survival|creative|adventure|spectator)$/.exec(args[0]);
      if (match && bot.game.gameMode !== match[1]) {
        bot.game.gameMode = match[1];
        bot.emit("game", bot.game);
      }
    },
    pathfinder: {
      movements: { policy: "skill-default" },
      setMovements(movements) { this.movements = movements; },
      setGoal() {},
      goto(goal) { calls.movement.push(goal); },
    },
    loadPlugin(plugin) { plugin(bot); },
    blockAt(position) {
      const name = position.y === support.y || (position.x === target.x && position.y === target.y && position.z === target.z && blockPlaced) ? "stone" : "air";
      const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
      block.position = position;
      return block;
    },
    async lookAt(position) {
      calls.look.push(position);
      lookStarted.resolve();
      await lookGate.promise;
    },
    placeBlock(block, face) {
      calls.place.push({ block, face });
      blockPlaced = true;
    },
    dig(block) { calls.dig.push(block); },
    setControlState() {},
  });
  bot.entities = { self: bot.entity };

  if (realCreative) {
    bot.supportFeature = () => false;
    bot._client = Object.assign(new EventEmitter(), {
      write(packetName, packet) {
        assert.equal(packetName, "set_creative_slot");
        const appliedItem = packet.item == null ? null : Item.fromNotch(packet.item);
        calls.serverSlot = appliedItem;
        calls.serverWrites.push({ ...packet, item: appliedItem });
        calls.events.push({ type: "write", item: appliedItem });
        const delayMs = appliedItem?.type === registry.itemsByName.stone.id ? supplyAckDelayMs : 0;
        setTimeout(() => {
          const oldItem = bot.inventory.slots[packet.slot];
          bot.inventory.slots[packet.slot] = appliedItem;
          bot.inventory.emit(`updateSlot:${packet.slot}`, oldItem, appliedItem);
          calls.events.push({ type: "ack", item: appliedItem, serverSlot: calls.serverSlot });
        }, delayMs);
      },
    });
    realCreativePlugin(bot);
  } else {
    bot.creative = {
      setInventorySlot(slot, item) {
        calls.supply.push({ slot, item });
        bot.inventory.slots[slot] = item;
      },
    };
  }
  calls.getServerSlot = () => calls.serverSlot ?? null;

  loadSchematicBuilder(bot);
  return { bot, calls, lookGate, lookStarted };
}

const tinySchematic = {
  version: VERSION,
  size: new Vec3(1, 1, 1),
  palette: [stoneState],
  blocks: [0],
  offset: new Vec3(0, 0, 0),
  getBlock: () => require("prismarine-block")(VERSION).fromStateId(stoneState, 0),
};

function dependencies(calls) {
  return provenanceFixtureDependencies({
    resolvePath: (filename) => `/schematics/${filename}`,
    fsAccess: async () => {},
    fsReadFile: () => Buffer.from("tiny schematic fixture"),
    SchematicClass: { read: () => tinySchematic },
    placementOptions: resolvePlacementOptions({}, { mode: "balanced", radius: 0 }),
    executeBuild: (bot, build, options) => runBuild(bot, build, {
      ...options,
      pollMs: 5,
      stallMs: 2_000,
      graceMs: 20,
    }),
    changeGameMode: (bot, mode, _timeout, options) => {
      calls.modes.push({ mode, force: options?.force ?? false });
      calls.events.push({ type: "mode", mode });
      bot.game.gameMode = mode;
      return true;
    },
    writeLog: (message) => calls.logs.push(message),
  });
}

test("stale real plugin loop exits after suspended look; lifecycle quarantine rejects retry before mutations", async () => {
  const { bot, calls, lookGate, lookStarted } = createBot();
  calls.logs = [];
  const deps = dependencies(calls);
  const firstBuild = buildSchematic(bot, "one_block.schem", 0, 64, 0, deps);

  await lookStarted.promise;
  bot.interrupt_code = true;
  assert.equal(await firstBuild, false);
  assert.equal(calls.look.length, 1);

  const callsBeforeRetry = {
    modes: calls.modes.length,
    supply: calls.supply.length,
    equip: calls.equip.length,
    chat: calls.chat.length,
  };
  assert.equal(await buildSchematic(bot, "one_block.schem", 0, 64, 0, deps), false);
  assert.match(calls.logs.at(-1), /busy.*still settling/i);
  assert.deepEqual({
    modes: calls.modes.length,
    supply: calls.supply.length,
    equip: calls.equip.length,
    chat: calls.chat.length,
  }, callsBeforeRetry);

  lookGate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls.place, []);
  assert.deepEqual(calls.dig, []);
  assert.equal(calls.look.length, 1);
  assert.equal(calls.equip.length, 1);
  assert.deepEqual(calls.movement, []);
});

test("interrupted Creative supply forces reserved-slot restore despite delayed real-handler acknowledgement", async () => {
  const { bot, calls } = createBot({ realCreative: true });
  const original = new Item(registry.itemsByName.dirt.id, 3, 0);
  bot.inventory.slots[36] = original;
  calls.serverSlot = original;
  let supplyWriteStarted;
  const supplyStarted = new Promise((resolve) => { supplyWriteStarted = resolve; });
  const originalWrite = bot._client.write;
  bot._client.write = (name, packet) => {
    originalWrite(name, packet);
    if (calls.serverWrites.length === 1) supplyWriteStarted();
  };
  calls.logs = [];
  const build = buildSchematic(bot, "one_block.schem", 0, 64, 0, dependencies(calls));

  await supplyStarted;
  bot.interrupt_code = true;
  const startedAt = Date.now();
  assert.equal(await build, false);
  assert.ok(Date.now() - startedAt < 4_000, "cancellation cleanup remains bounded");

  assert.equal(calls.serverWrites.length, 2, "restore packet is sent even though local inventory still contains dirt");
  assert.equal(calls.serverWrites[0].item.type, registry.itemsByName.stone.id);
  assert.equal(calls.serverWrites[1].item.type, registry.itemsByName.dirt.id);
  const survivalEventIndex = calls.events.findIndex((event) => event.type === "mode" && event.mode === "survival");
  assert.ok(survivalEventIndex >= 0);
  assert.ok(calls.events.findIndex((event) => event.type === "write" && event.item?.type === registry.itemsByName.dirt.id)
    < survivalEventIndex, "restoration write is sent before switching to Survival");
  assert.equal(calls.getServerSlot().type, registry.itemsByName.dirt.id,
    "the fake server has applied restoration before Survival mode");
  assert.equal(bot.inventory.slots[36].type, registry.itemsByName.dirt.id,
    "the client shows the restored slot when the bounded cleanup returns");
  assert.match(calls.logs.join("\n"), /Creative inventory cleanup timed out/);
  assert.throws(() => beginCreativeSupply(bot), /already active/, "slot ownership remains quarantined until old ack settles");

  await new Promise((resolve) => setTimeout(resolve, 4_700));
  assert.equal(calls.getServerSlot().type, registry.itemsByName.dirt.id);
  assert.equal(bot.inventory.slots[36].type, registry.itemsByName.dirt.id,
    "the delayed stale supply acknowledgement cannot leave the client slot changed");
  assert.equal(calls.equip.length, 0, "cancelled supply never equips after its late acknowledgement");

  const nextCleanup = beginCreativeSupply(bot);
  await nextCleanup();
});

test("already-Creative build succeeds without a redundant mode command and restores slot and unstuck state", async () => {
  const { bot, calls, lookGate, lookStarted } = createBot({ realCreative: true, gameMode: "creative", supplyAckDelayMs: 0 });
  const original = new Item(registry.itemsByName.dirt.id, 3, 0);
  bot.inventory.slots[36] = original;
  calls.serverSlot = original;
  calls.logs = [];
  const deps = dependencies(calls);
  delete deps.changeGameMode; // Exercise the real setGameMode implementation.

  const build = buildSchematic(bot, "one_block.schem", 0, 64, 0, deps);
  await lookStarted.promise;
  lookGate.resolve();
  assert.equal(await build, true, calls.logs.join("\n"));
  assert.deepEqual(calls.chat, [], "no mode transition is attempted when already Creative");
  assert.equal(calls.serverWrites.length, 2, "supply slot is written and restored");
  assert.equal(calls.serverWrites[0].item.type, registry.itemsByName.stone.id);
  assert.equal(calls.serverWrites[1].item.type, registry.itemsByName.dirt.id);
  assert.equal(calls.getServerSlot().type, registry.itemsByName.dirt.id);
  assert.equal(bot.inventory.slots[36].type, registry.itemsByName.dirt.id);
  assert.deepEqual(calls.events.filter((event) => event.type === "unstuck").map(({ action }) => action), ["pause", "unpause"]);
  assert.equal(bot.modes.isPaused("unstuck"), false);
});
