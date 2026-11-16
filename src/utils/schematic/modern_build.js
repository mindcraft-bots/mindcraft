import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Vec3 = require("vec3");
const Build = require("mineflayer-schem/lib/build.js");
const MAX_DIMENSION = 256;
const MAX_BLOCKS = 1_000_000;

const ITEM_NAME_OVERRIDES = Object.freeze({
  cocoa: "cocoa_beans",
  redstone_wire: "redstone",
  wall_torch: "torch",
});

const DOUBLE_PLANT_NAMES = new Set([
  "large_fern",
  "lilac",
  "peony",
  "rose_bush",
  "sunflower",
  "tall_grass",
]);

function isFiniteInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function copyProperties(properties) {
  return Object.freeze({ ...properties });
}

function itemNameForBlock(name, itemsByName) {
  const candidates = [ITEM_NAME_OVERRIDES[name]];

  if (name.endsWith("_wall_hanging_sign")) {
    candidates.push(name.replace("_wall_hanging_sign", "_hanging_sign"));
  }
  if (name.endsWith("_wall_sign")) {
    candidates.push(name.replace("_wall_sign", "_sign"));
  }
  if (name.endsWith("_wall_banner")) {
    candidates.push(name.replace("_wall_banner", "_banner"));
  }
  if (name.endsWith("_wall_torch")) {
    candidates.push(name.replace("_wall_torch", "_torch"));
  }
  candidates.push(name);

  return candidates.find((candidate) => candidate && itemsByName[candidate]) ?? null;
}

function orientationMetadata(name, properties) {
  if (name.endsWith("_stairs")) {
    const facing = { south: 0, north: 1, east: 2, west: 3 }[properties.facing];
    return facing === undefined ? 0 : facing | (properties.half === "top" ? 4 : 0);
  }

  if (name.endsWith("_door")) {
    const facing = { east: 0, south: 1, west: 2, north: 3 }[properties.facing];
    return facing === undefined ? 0 : facing | (properties.open ? 4 : 0);
  }

  if (name.endsWith("_trapdoor")) {
    const facing = { north: 0, south: 1, west: 2, east: 3 }[properties.facing];
    return facing === undefined
      ? 0
      : facing | (properties.open ? 4 : 0) | (properties.half === "top" ? 8 : 0);
  }

  if (name.endsWith("_log") || name.endsWith("_wood") || name.endsWith("_pillar")) {
    return { x: 4, z: 8 }[properties.axis] ?? 0;
  }

  return 0;
}

function dependentReason(name, properties) {
  if (name.endsWith("_door") && properties.half === "upper") return "upper door half is placed by its lower half";
  if (name.endsWith("_bed") && properties.part === "head") return "bed head is placed by its foot";
  if (DOUBLE_PLANT_NAMES.has(name) && properties.half === "upper") return "upper plant half is placed by its lower half";
  return null;
}

function validateSchematic(schematic, startPos) {
  const size = schematic?.size;
  const dimensions = [size?.x, size?.y, size?.z];
  if (!dimensions.every((dimension) => Number.isSafeInteger(dimension) && dimension > 0 && dimension <= MAX_DIMENSION)) {
    throw new RangeError(`Schematic dimensions must be positive integers no larger than ${MAX_DIMENSION}`);
  }

  const volume = dimensions[0] * dimensions[1] * dimensions[2];
  if (volume > MAX_BLOCKS) {
    throw new RangeError(`Schematic volume exceeds the ${MAX_BLOCKS} block limit`);
  }
  if (!Array.isArray(schematic.palette) || !Array.isArray(schematic.blocks) || schematic.blocks.length !== volume) {
    throw new TypeError("Schematic palette/blocks do not match its dimensions");
  }
  if (!startPos || ![startPos.x, startPos.y, startPos.z].every(Number.isSafeInteger)) {
    throw new TypeError("startPos must contain integer x, y, and z coordinates");
  }

  return { width: dimensions[0], height: dimensions[1], length: dimensions[2], volume };
}

class ModernBuild extends Build {
  // Build calls this virtual method from its constructor. Its legacy decoder must not run.
  initializeBlocks() {}
}

/** Adapt a prismarine-schematic Schematic into mineflayer-schem's Build action contract. */
export function createModernBuild(schematic, bot, startPos) {
  if (!bot || typeof bot.version !== "string") throw new TypeError("A Mineflayer bot with a version is required");

  const { width, height, length, volume } = validateSchematic(schematic, startPos);
  const at = new Vec3(startPos.x, startPos.y, startPos.z);
  const dimensions = Object.freeze({ width, height, length });
  // Build 1.5.2 expects legacy width/height/length fields and invokes initializeBlocks().
  const build = new ModernBuild({ width, height, length, blocks: [] }, bot, at, bot);
  build.schematic = schematic;
  build.dimensions = dimensions;
  build.blocks = Object.create(null);
  build.items = Object.create(null);
  build.blockData = Object.create(null);
  build.plan = [];
  build.unsupported = [];
  build.skippedDependencies = [];

  const registry = bot.registry ?? require("minecraft-data")(bot.version);
  if (!registry?.blocksByStateId || !registry?.itemsByName) {
    throw new TypeError(`No block/item registry is available for Minecraft ${bot.version}`);
  }

  const plan = [];
  const unsupported = [];
  const actions = [];
  const skippedDependencies = [];

  for (let index = 0; index < volume; index++) {
    const paletteIndex = schematic.blocks[index];
    if (!isFiniteInteger(paletteIndex) || paletteIndex >= schematic.palette.length) {
      throw new TypeError(`Invalid palette index ${paletteIndex} at block index ${index}`);
    }

    const stateId = schematic.palette[paletteIndex];
    if (!isFiniteInteger(stateId)) throw new TypeError(`Invalid block state ID ${stateId} at block index ${index}`);

    const x = index % width;
    const z = Math.floor(index / width) % length;
    const y = Math.floor(index / (width * length));
    const relative = new Vec3(x, y, z).plus(schematic.offset ?? new Vec3(0, 0, 0));
    const decoded = typeof schematic.getBlock === "function" ? schematic.getBlock(relative) : null;
    const registryState = registry.blocksByStateId[stateId];
    const name = decoded?.name ?? registryState?.name;

    if (!name || !registryState || registryState.name !== name) {
      unsupported.push({
        index,
        position: { x: startPos.x + x, y: startPos.y + y, z: startPos.z + z },
        stateId,
        name: name ?? null,
        reason: "state ID is not present in the bot's versioned block registry",
      });
      continue;
    }
    if (name === "air" || name === "cave_air" || name === "void_air") continue;

    const properties = copyProperties(decoded?.getProperties?.() ?? {});
    const position = Object.freeze({ x: startPos.x + x, y: startPos.y + y, z: startPos.z + z });
    const entry = Object.freeze({ position, name, properties, stateId });
    plan.push(entry);

    const dependency = dependentReason(name, properties);
    const mappedItemName = itemNameForBlock(name, registry.itemsByName);
    const item = mappedItemName ? registry.itemsByName[mappedItemName] : null;
    build.blocks[index] = { id: stateId, name };
    build.items[index] = item ?? null;
    build.blockData[index] = orientationMetadata(name, properties);

    if (dependency) {
      skippedDependencies.push({ ...entry, reason: dependency });
      continue;
    }
    if (!item) {
      unsupported.push({
        index,
        position,
        name,
        properties,
        stateId,
        reason: `no placeable item mapping for ${name}`,
      });
      continue;
    }

    actions.push({
      type: "place",
      pos: new Vec3(position.x, position.y, position.z),
      state: index,
      blockId: stateId,
      blockName: name,
      metadata: build.blockData[index],
      stateId,
      properties,
    });
  }

  build.plan = Object.freeze(plan);
  build.unsupported = Object.freeze(unsupported);
  build.skippedDependencies = Object.freeze(skippedDependencies);
  build.actions = actions;

  if (unsupported.length > 0) {
    const summary = unsupported.map(({ name, stateId, position, reason }) =>
      `${name ?? `state ${stateId}`} at ${position.x},${position.y},${position.z}: ${reason}`
    ).join("; ");
    const error = new Error(`Schematic contains unsupported blocks: ${summary}`);
    error.unsupported = build.unsupported;
    error.build = build;
    throw error;
  }

  return build;
}
