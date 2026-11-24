import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { goals } = require("mineflayer-pathfinder");
const minecraftData = require("minecraft-data");
import {
  getBotWorldGeneration,
  isBotWorldLifecycleTracked,
  trackBotWorldLifecycle,
} from "./world_lifecycle.js";
const AIR_NAMES = new Set(["air", "cave_air", "void_air"]);
const vanillaBlockNames = new Map();
// Per-obstruction approach budget, separate from the later builder stall watchdog.
// Allow time for long routes and path recomputation without waiting indefinitely.
const DEFAULT_NAVIGATION_TIMEOUT_MS = 120_000;
const NAVIGATION_POLL_MS = 50;

// Exact vanilla name classes only. Leaves are excluded because their removal
// can trigger neighboring leaf-decay updates. Dependent plants (for example
// sugar cane, bamboo, vines, tall flowers, and crops with upper halves) are
// excluded because one dig may cause physics outside this cell.
const SAFE_NATURAL_NAME = /^(?:[a-z]+_sapling|mangrove_propagule|short_grass|fern|dead_bush|dandelion|poppy|blue_orchid|allium|azure_bluet|red_tulip|orange_tulip|white_tulip|pink_tulip|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|brown_mushroom|red_mushroom|crimson_fungus|warped_fungus|azalea|flowering_azalea|moss_carpet|spore_blossom|pink_petals|wildflowers|leaf_litter|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|nether_wart|torchflower_crop)$/;
const PROTECTED_NAME = /(?:chest|barrel|shulker_box|furnace|smoker|blast_furnace|hopper|dispenser|dropper|spawner|beacon|ore|ancient_debris|diamond_block|emerald_block|netherite_block|gold_block|iron_block|copper_block|amethyst|structure|command_block|bedrock|obsidian|planks|bricks|stone|deepslate|concrete|terracotta|glass|wool|banner|sign|door|trapdoor|fence|wall|stairs|slab|anvil|enchanting_table|brewing_stand|crafting_table|bookshelf|lectern|bell|jukebox|note_block|redstone|rail|torch|lantern|campfire|candle|pot|decorated_pot|head|skull|bed|door|button|lever|pressure_plate)/;

function positionKey(position) {
  return `${position.x},${position.y},${position.z}`;
}

function cancellationError(message) {
  const error = new Error(message);
  error.code = "SCHEMATIC_CLEAR_CANCELLED";
  return error;
}

/** Snapshot observable bot/world identity for one obstruction/build attempt. */
export function captureSchematicAttemptIdentity(bot, lifecycle = null) {
  trackBotWorldLifecycle(bot);
  const client = bot?._client;
  const dimension = bot?.game?.dimension;
  const world = bot?.world;
  const entity = bot?.entity;
  return Object.freeze({
    dimension,
    world,
    client,
    version: bot?.version,
    registry: bot?.registry,
    entity,
    worldGeneration: getBotWorldGeneration(bot),
    lifecycle,
    observable: typeof dimension === "string" && dimension.length > 0
      && world != null && client != null && entity != null
      && isBotWorldLifecycleTracked(bot),
  });
}

export function isSchematicAttemptIdentityCurrent(bot, identity) {
  return Boolean(identity?.observable
      && bot?.game?.dimension === identity.dimension
      && bot?.world === identity.world
      && bot?._client === identity.client
      && bot?.version === identity.version
      && bot?.registry === identity.registry
      && bot?.entity === identity.entity
      && identity.worldGeneration != null
      && getBotWorldGeneration(bot) === identity.worldGeneration
      && !(typeof bot?.health === "number" && bot.health <= 0)
      && !identity.client?.ended
      && !identity.client?.socket?.destroyed
      && (!identity.lifecycle || identity.lifecycle.isCurrent?.() === true));
}

function assertAttemptIdentity(bot, identity, isInterrupted, message = "Schematic obstruction attempt") {
  if (isInterrupted?.()) throw cancellationError(`${message} cancelled`);
  if (!isSchematicAttemptIdentityCurrent(bot, identity)) {
    throw cancellationError(`${message} stopped because world, dimension, connection, entity, or build lifecycle identity changed or is unavailable`);
  }
}

async function navigateWithoutEditing(bot, goal, position, assertAttempt, timeoutMs) {
  const assertNavigationAttempt = () => {
    try {
      assertAttempt();
    } catch (error) {
      throw cancellationError(`Schematic obstruction clearing cancelled while moving to ${positionKey(position)}: ${error.message}`);
    }
  };
  assertNavigationAttempt();
  const startedAt = performance.now();
  const remainingTime = () => timeoutMs - (performance.now() - startedAt);
  let terminated = false;
  let outcome = null;
  let wake = null;
  // Attach only once: a pending goto must not accumulate handlers on every poll.
  // Observe late rejection even when cancellation or the deadline wins.
  Promise.resolve().then(() => {
    if (terminated) return;
    assertNavigationAttempt();
    if (remainingTime() <= 0) return;
    return bot.pathfinder.goto(goal);
  }).then(
    () => { outcome = { ok: true }; wake?.(); },
    (error) => { outcome = { ok: false, error }; wake?.(); },
  );
  const stopMovement = () => {
    try {
      if (typeof bot.pathfinder.setGoal === "function") bot.pathfinder.setGoal(null);
      else bot.pathfinder.stop?.();
    } catch {
      // Cancellation or timeout remains authoritative; never proceed to dig.
    }
  };
  while (true) {
    try {
      assertNavigationAttempt();
    } catch (error) {
      terminated = true;
      stopMovement();
      throw error;
    }
    const remainingMs = remainingTime();
    if (remainingMs <= 0) {
      terminated = true;
      stopMovement();
      const error = new Error(`Schematic obstruction clearing navigation timed out after ${timeoutMs}ms while moving to ${positionKey(position)}; obstruction is inaccessible`);
      error.code = "SCHEMATIC_CLEAR_NAVIGATION_TIMEOUT";
      throw error;
    }
    if (outcome) {
      if (!outcome.ok) throw outcome.error;
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { wake = null; resolve(); }, Math.min(NAVIGATION_POLL_MS, remainingMs));
      wake = () => { clearTimeout(timer); wake = null; resolve(); };
    });
  }
}

function getProperties(block) {
  try {
    return block?.getProperties?.() ?? block?._properties ?? block?.properties ?? {};
  } catch {
    return {};
  }
}

function copyProperties(block) {
  return { ...getProperties(block) };
}

function sameProperties(left, right) {
  const leftKeys = Object.keys(left ?? {}).sort();
  const rightKeys = Object.keys(right ?? {}).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function isExpected(block, cell) {
  return block?.name === cell.name
    && Object.entries(cell.properties ?? {}).every(([key, value]) => getProperties(block)[key] === value);
}

function vanillaBlocksFor(version) {
  if (!version) return null;
  if (!vanillaBlockNames.has(version)) {
    try {
      vanillaBlockNames.set(version, new Set(Object.keys(minecraftData(version)?.blocksByName ?? {})));
    } catch {
      vanillaBlockNames.set(version, new Set());
    }
  }
  return vanillaBlockNames.get(version);
}

function hasUnsafeFluidState(block, version) {
  let states;
  try {
    states = minecraftData(version)?.blocksByName?.[block?.name]?.states;
  } catch {
    return true;
  }
  // Registry metadata must prove which fluid properties exist. In particular,
  // a missing or unreadable waterlogged property is not evidence of dryness.
  if (!Array.isArray(states)) return true;
  const fluidStates = states.filter(({ name }) => /(?:water|fluid)/i.test(name));
  let properties;
  try {
    properties = typeof block?.getProperties === "function"
      ? block.getProperties() : (block?._properties ?? block?.properties);
  } catch {
    properties = null;
  }
  if ((!properties || typeof properties !== "object") && fluidStates.length) return true;
  properties ??= {};
  if (fluidStates.some(({ name }) => !Object.hasOwn(properties, name))) return true;
  return Object.entries(properties).some(([key, value]) => {
    if (!/(?:water|fluid)/i.test(key)) return false;
    if (/waterlogged/i.test(key)) return value !== false && value !== "false";
    return value !== false && !["false", "none", "empty", "dry"].includes(String(value).toLowerCase());
  });
}

function obstructionReason(block, version) {
  if (!block?.name) return "unknown block type";
  if (!vanillaBlocksFor(version)?.has(block.name)) return "block type is unknown to the vanilla registry";
  if (block.entity || block.blockEntity || block._blockEntity || block.nbt) return "block entity / attached data is protected";
  if (PROTECTED_NAME.test(block.name)) return "valuable, interactive, or structural block is protected";
  if (!SAFE_NATURAL_NAME.test(block.name)) return "block is not on the conservative natural-obstruction allowlist";
  if (hasUnsafeFluidState(block, version)) return "block state contains water or another fluid, or fluid state is unknown";
  if (block.diggable !== true) return "block breakability is unknown or the block is unbreakable";
  return null;
}

export function isKnownNaturalObstructionName(name, version) {
  return typeof name === "string" && vanillaBlocksFor(version)?.has(name)
    && SAFE_NATURAL_NAME.test(name) && !PROTECTED_NAME.test(name);
}

/** State-aware counterpart used for preflight, TOCTOU checks, and recovery. */
export function isSafeNaturalObstruction(block, version) {
  return Boolean(block?.name && !hasUnsafeFluidState(block, version)
    && isKnownNaturalObstructionName(block.name, version));
}

export function isSchematicAirName(name) {
  return AIR_NAMES.has(name);
}

function readBlock(bot, position, Vec3Class) {
  try {
    return bot.blockAt(new Vec3Class(position.x, position.y, position.z));
  } catch (error) {
    throw new Error(`Could not inspect ${positionKey(position)}: ${error?.message ?? error}`);
  }
}

function requireCells(build) {
  if (!Array.isArray(build?.cells) || build.cells.length === 0) {
    throw new Error("Schematic obstruction safety requires the complete transformed-volume cell plan; refusing to build without it");
  }
  const { width, height, length } = build.dimensions ?? {};
  const volume = width * height * length;
  if (![width, height, length].every((dimension) => Number.isSafeInteger(dimension) && dimension > 0)
      || !Number.isSafeInteger(volume) || volume > 1_000_000 || build.cells.length !== volume) {
    throw new Error("Schematic obstruction safety requires every cell in the declared transformed volume");
  }
  const seen = new Set();
  const min = { x: Infinity, y: Infinity, z: Infinity };
  for (const cell of build.cells) {
    const key = positionKey(cell.position ?? {});
    if (!Number.isSafeInteger(cell.position?.x) || !Number.isSafeInteger(cell.position?.y)
        || !Number.isSafeInteger(cell.position?.z) || seen.has(key)) {
      throw new Error("Schematic transformed-volume plan contains an invalid or duplicate cell");
    }
    seen.add(key);
    min.x = Math.min(min.x, cell.position.x);
    min.y = Math.min(min.y, cell.position.y);
    min.z = Math.min(min.z, cell.position.z);
  }
  for (const { position: { x, y, z } } of build.cells) {
    if (x < min.x || x >= min.x + width || y < min.y || y >= min.y + height || z < min.z || z >= min.z + length) {
      throw new Error("Schematic transformed-volume cells do not form the declared rectangular bounds");
    }
  }
  return build.cells;
}

/** Clear only allowlisted natural blocks after a complete, fail-closed volume preflight. */
export async function clearSchematicObstructions(bot, build, {
  Vec3Class,
  isInterrupted = () => Boolean(bot.interrupt_code),
  attemptIdentity = captureSchematicAttemptIdentity(bot),
  navigationTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
} = {}) {
  if (!bot || typeof bot.blockAt !== "function" || typeof bot.dig !== "function" || !Vec3Class) {
    throw new Error("Safe schematic clearing requires block inspection, digging, and a vector implementation");
  }
  if (!Number.isFinite(navigationTimeoutMs) || navigationTimeoutMs <= 0) {
    throw new RangeError("Schematic obstruction clearing navigation timeout must be a positive finite number of milliseconds");
  }
  const cells = requireCells(build);
  const assertAttempt = () => assertAttemptIdentity(
    bot,
    attemptIdentity,
    () => isInterrupted() || Boolean(build?.isCancelled),
    "Schematic obstruction clearing",
  );
  assertAttempt();
  build.approvedObstructions = new Map();
  const snapshots = [];

  // Inspect the full exact volume before the first destructive action. This
  // prevents partial clearing when a chest/structure/unloaded cell is present.
  for (const cell of cells) {
    assertAttempt();
    const block = readBlock(bot, cell.position, Vec3Class);
    assertAttempt();
    if (!block) throw new Error(`Schematic obstruction at ${positionKey(cell.position)} is unavailable or unloaded; refusing to clear`);
    if (AIR_NAMES.has(block.name) || isExpected(block, cell)) continue;
    const reason = obstructionReason(block, bot.version);
    if (reason) throw new Error(`Refusing obstruction ${block.name ?? "unknown"} at ${positionKey(cell.position)}: ${reason}`);
    snapshots.push({ cell, name: block.name, properties: copyProperties(block) });
  }
  build.approvedObstructions = new Map(snapshots.map((snapshot) => [
    positionKey(snapshot.cell.position),
    Object.freeze({ name: snapshot.name, properties: Object.freeze({ ...snapshot.properties }) }),
  ]));

  for (const snapshot of snapshots) {
    if (isInterrupted()) throw cancellationError(`Schematic obstruction clearing cancelled at ${positionKey(snapshot.cell.position)}`);
    const targetPosition = new Vec3Class(
      snapshot.cell.position.x,
      snapshot.cell.position.y,
      snapshot.cell.position.z,
    );
    const botPosition = bot.entity?.position;
    if (!botPosition || typeof botPosition.distanceTo !== "function") {
      throw new Error(`Cannot determine digging reach for obstruction at ${positionKey(snapshot.cell.position)}`);
    }
    if (botPosition.distanceTo(targetPosition) > 4.5) {
      if (typeof bot.pathfinder?.goto !== "function") {
        throw new Error(`Obstruction at ${positionKey(snapshot.cell.position)} is inaccessible: pathfinder.goto is unavailable`);
      }
      try {
        await navigateWithoutEditing(bot, new goals.GoalNear(
          snapshot.cell.position.x,
          snapshot.cell.position.y,
          snapshot.cell.position.z,
          3,
        ), snapshot.cell.position, assertAttempt, navigationTimeoutMs);
      } catch (error) {
        if (error?.code === "SCHEMATIC_CLEAR_CANCELLED" || error?.code === "SCHEMATIC_CLEAR_NAVIGATION_TIMEOUT") throw error;
        throw new Error(`Obstruction at ${positionKey(snapshot.cell.position)} is inaccessible: ${error?.message ?? error}`);
      }
      assertAttempt();
    }
    assertAttempt();
    const before = readBlock(bot, snapshot.cell.position, Vec3Class);
    assertAttempt();
    if (!before) throw new Error(`Obstruction at ${positionKey(snapshot.cell.position)} became unavailable before digging`);
    if (before.name !== snapshot.name || !sameProperties(getProperties(before), snapshot.properties)) {
      throw new Error(`Obstruction at ${positionKey(snapshot.cell.position)} changed after preflight; refusing destructive action`);
    }
    const reason = obstructionReason(before, bot.version);
    if (reason) throw new Error(`Refusing changed obstruction ${before.name} at ${positionKey(snapshot.cell.position)}: ${reason}`);
    assertAttempt();
    try {
      assertAttempt();
      await bot.dig(before);
      assertAttemptIdentity(
        bot,
        attemptIdentity,
        () => isInterrupted() || Boolean(build?.isCancelled),
        `Schematic obstruction clearing cancelled after clearing ${positionKey(snapshot.cell.position)}`,
      );
    } catch (error) {
      if (error?.code === "SCHEMATIC_CLEAR_CANCELLED") throw error;
      throw new Error(`Could not dig obstruction at ${positionKey(snapshot.cell.position)}: ${error?.message ?? error}`);
    }

    // Verify even if cancellation arrived while dig was in flight. Never claim
    // an intended-air cell is clear based only on dig() resolving.
    const after = readBlock(bot, snapshot.cell.position, Vec3Class);
    assertAttempt();
    if (!after || !AIR_NAMES.has(after.name)) {
      throw new Error(`Could not verify air after clearing ${snapshot.name} at ${positionKey(snapshot.cell.position)}; found ${after?.name ?? "unavailable"}`);
    }
    build.approvedObstructions.delete(positionKey(snapshot.cell.position));
    assertAttempt();
  }

  return { cleared: snapshots.length };
}

function cloneMovements(movements) {
  const scoped = Object.assign(Object.create(Object.getPrototypeOf(movements)), movements);
  for (const key of ["blocksCantBreak", "blocksToAvoid", "replaceables", "emptyBlocks", "climbables", "interactableBlocks", "entitiesToAvoid"]) {
    if (movements[key] instanceof Set) scoped[key] = new Set(movements[key]);
  }
  for (const key of ["scafoldingBlocks", "exclusionAreasStep", "exclusionAreasBreak", "exclusionAreasPlace"]) {
    if (Array.isArray(movements[key])) scoped[key] = [...movements[key]];
  }
  scoped.canDig = false;
  scoped.canOpenDoors = false;
  scoped.allow1by1towers = false;
  scoped.scafoldingBlocks = [];
  return scoped;
}

/** Temporarily prevent implicit builder digs and pathfinder excavation/scaffolding. */
export async function withSchematicDestructionGuards(bot, build, Vec3Class, operation, getPendingSettlement = () => null, attemptIdentity = captureSchematicAttemptIdentity(bot)) {
  const cells = requireCells(build);
  const volume = new Map(cells.map((cell) => [positionKey(cell.position), cell]));
  const priorDig = bot.dig;
  const priorPlaceBlock = bot.placeBlock;
  const builder = bot.builder;
  const priorClearArea = builder?.clearArea;
  const pathfinder = bot.pathfinder;
  const priorMovements = pathfinder?.movements;
  if (typeof priorDig !== "function" || typeof priorPlaceBlock !== "function" || !pathfinder || !priorMovements
      || typeof pathfinder.setMovements !== "function") {
    throw new Error("Cannot enforce safe schematic building: block dig/place and pathfinder movement controls are required");
  }
  let operationEnded = false;
  const assertAttempt = () => assertAttemptIdentity(bot, attemptIdentity, () => Boolean(operationEnded || build?.isCancelled || bot.interrupt_code), "Schematic builder");

  bot.dig = async function guardedSchematicDig(block, ...args) {
    assertAttempt();
    const position = block?.position;
    const cell = position && volume.get(positionKey(position));
    if (!cell) throw new Error("Blocked mineflayer-schem dig outside the exact schematic volume");
    const approved = build.approvedObstructions?.get(positionKey(position));
    if (!approved) throw new Error(`Blocked unapproved schematic dig at ${positionKey(position)}`);
    const current = readBlock(bot, position, Vec3Class);
    assertAttempt();
    if (!current || current.name !== block.name || !sameProperties(getProperties(current), getProperties(block))) {
      throw new Error(`Blocked stale schematic dig at ${positionKey(position)} after a world-state change`);
    }
    if (isExpected(current, cell)) {
      throw new Error(`Blocked mineflayer-schem dig of an already-correct cell at ${positionKey(position)}`);
    }
    if (current.name !== approved.name || !sameProperties(getProperties(current), approved.properties)) {
      throw new Error(`Blocked schematic dig of a changed obstruction at ${positionKey(position)}`);
    }
    const reason = obstructionReason(current, bot.version);
    if (reason) throw new Error(`Blocked unsafe schematic dig of ${current.name} at ${positionKey(position)}: ${reason}`);
    assertAttempt();
    const result = await priorDig.call(this, current, ...args);
    assertAttempt();
    return result;
  };
  bot.placeBlock = async function guardedSchematicPlace(reference, face, ...args) {
    assertAttempt();
    const target = reference?.position && face && {
      x: reference.position.x + face.x,
      y: reference.position.y + face.y,
      z: reference.position.z + face.z,
    };
    if (!target || !volume.has(positionKey(target))) {
      throw new Error("Blocked mineflayer-schem placement outside the exact schematic volume");
    }
    const current = readBlock(bot, target, Vec3Class);
    assertAttempt();
    if (!current || !isSchematicAirName(current.name)) {
      throw new Error(`Blocked schematic placement into non-air cell ${positionKey(target)} (${current?.name ?? "unavailable"})`);
    }
    assertAttempt();
    const result = await priorPlaceBlock.call(this, reference, face, ...args);
    assertAttempt();
    return result;
  };
  if (builder) builder.clearArea = async () => {
    throw new Error("The mineflayer-schem clearArea operation is disabled; only preflighted in-volume natural obstructions may be cleared");
  };
  let movementsChanged = false;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    bot.dig = priorDig;
    bot.placeBlock = priorPlaceBlock;
    if (builder) builder.clearArea = priorClearArea;
    if (movementsChanged) pathfinder.setMovements(priorMovements);
  };
  try {
    assertAttempt();
    movementsChanged = true;
    pathfinder.setMovements(cloneMovements(priorMovements));
    const result = await operation();
    // A builder can resolve normally with an interrupted status. Preserve that
    // recovery signal while still rejecting stale-world/lifecycle completion.
    assertAttemptIdentity(bot, attemptIdentity, () => false, "Schematic builder");
    return result;
  } finally {
    // Even stale-identity errors and thrown operations can leave the builder
    // running. Never expose unguarded methods until that promise settles.
    operationEnded = true;
    const pending = getPendingSettlement?.();
    if (pending && typeof pending.then === "function") {
      Promise.resolve(pending).then(restore, restore);
    } else {
      restore();
    }
  }
}
