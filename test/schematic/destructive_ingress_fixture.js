import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers";
import { buildSchematic, buildTrustedDestructiveSchematic } from "../../src/utils/schematic/build_schematic.js";
import { resolvePlacementOptions } from "../../src/utils/schematic/placement_options.js";
import { provenanceFixtureDependencies } from "./provenance_fixture.js";
import { runBuild } from "../../src/utils/schematic/run_build.js";

const require = createRequire(import.meta.url);
const Vec3 = require("vec3");
const nbt = require("prismarine-nbt");
const { createSerializer, createDeserializer } = require("minecraft-protocol");
const key = p => `${p.x},${p.y},${p.z}`;

export function fixture(names = ["cobblestone", "air", "stone", "air"], width = names.length, version = "1.18.2") {
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
  const schematic = { size: new Vec3(width, 1, names.length / width), offset: new Vec3(0, 0, 0), palette,
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
  // Exercise the installed exact-version packet codecs, not guessed packet
  // shapes. This remains a deterministic in-memory transport, never a server.
  const serializers = version === "1.21.4" ? [false, true].map(isServer => createSerializer({ state: "play", version, isServer })) : null;
  const parsers = serializers && [true, false].map(isServer => createDeserializer({ state: "play", version, isServer }));
  const roundTrip = (name, params, inbound = false) => {
    if (!serializers) return params;
    const index = inbound ? 1 : 0;
    return parsers[index].parsePacketBuffer(serializers[index].createPacketBuffer({ name, params })).data.params;
  };
  const receive = (name, packet) => bot._client.emit(name, roundTrip(name, packet, true));
  // The installed native plugins issue real gameplay API packets into this
  // simulated transport. Only an inbound packet updates this fixture's world.
  const inbound = (position, name) => {
    const oldBlock = bot.blockAt(position);
    world.set(key(position), name);
    const newBlock = bot.blockAt(position);
    bot.emit(`blockUpdate:${position}`, oldBlock, newBlock);
    receive("block_change", { location: position, type: newBlock.stateId });
  };
  const inboundSection = (position, name) => {
    const oldBlock = bot.blockAt(position);
    world.set(key(position), name);
    const newBlock = bot.blockAt(position);
    bot.emit(`blockUpdate:${position}`, oldBlock, newBlock);
    receive("multi_block_change", {
      chunkCoordinates: { x: Math.floor(position.x / 16), y: Math.floor(position.y / 16), z: Math.floor(position.z / 16) },
      records: [newBlock.stateId * 4096 + (position.x & 15) * 256 + (position.z & 15) * 16 + (position.y & 15)],
    });
  };
  const acknowledge = (position, { status = 0, name = "air", successful = true, sequenceId } = {}) => {
    receive("acknowledge_player_digging", version === "1.21.4" ? { sequenceId } : {
      location: position, block: data.blocksByName[name].defaultState, status, successful,
    });
  };
  const commands = [];
  const replyRead = (packet, { token, isActionBar = false } = {}) => {
    const match = /^execute if loaded (-?\d+) (-?\d+) (-?\d+) if block \1 \2 \3 minecraft:([a-z0-9_]+) run tellraw @s (\{"text":"mindcraft-dig-[a-f0-9]+"\})$/.exec(packet.command);
    assert.ok(match, `Unexpected non-read-only fixture command: ${packet.command}`);
    const position = new Vec3(...match.slice(1, 4).map(Number));
    // This is a server-side state lookup, independent of the client's cache.
    const actual = dependencies.serverWorld?.get(key(position)) ?? bot.blockAt(position).name;
    if (actual !== match[4]) return;
    const text = token ?? JSON.parse(match[5]).text;
    receive("system_chat", { content: nbt.comp({ text: nbt.string(text) }), isActionBar });
  };
  bot._client.write = (name, packet) => {
    packet = roundTrip(name, packet);
    if (packet.location) packet.location = new Vec3(packet.location.x, packet.location.y, packet.location.z);
    dependencies.onWrite?.(name, packet);
    if (name === "chat_command") {
      commands.push(packet);
      if (!dependencies.noReadConfirmation) setImmediate(() => replyRead(packet));
    } else if (name === "block_dig" && packet.status === 0) {
      writes.push(["dig", key(packet.location)]);
      if (!dependencies.noConfirmation) setImmediate(async () => {
        await dependencies.onDig?.(bot.blockAt(packet.location));
        inbound(packet.location, "air");
        acknowledge(packet.location, { sequenceId: packet.sequence });
      });
    } else if (name === "block_dig" && packet.status === 2) {
      // The native zero-delay timer can dispatch finish before the scheduled
      // start response. Every dispatched action still needs its own reply.
      if (!dependencies.noConfirmation) setImmediate(() => {
        inbound(packet.location, "air");
        acknowledge(packet.location, { status: 2, sequenceId: packet.sequence });
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
  return { bot, world, writes, logs, modes, dependencies, inbound, inboundSection, acknowledge, commands, replyRead, receive, roundTrip,
    run: () => buildTrustedDestructiveSchematic(bot, "test.schem", 0, 64, 0, dependencies),
    publicRun: () => buildSchematic(bot, "test.schem", 0, 64, 0, dependencies) };
}
