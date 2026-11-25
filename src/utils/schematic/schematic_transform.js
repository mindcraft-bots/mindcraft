import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const minecraftData = require("minecraft-data");
const prismarineBlock = require("prismarine-block");
const Vec3 = require("vec3");

const CARDINAL = ["north", "east", "south", "west"];
const TURNS = Object.freeze({ north: 0, east: 1, south: 2, west: 3 });
const MAX_VOLUME = 1_000_000;
const MAX_INDEXED_STATES = 2048;
const MAX_CACHED_BLOCKS = 16;
const MAX_PALETTE_ENTRIES = 65_536;
const MAX_SCHEMATIC_BLOCKS = 1024;
const MAX_SCHEMATIC_INDEXED_STATES = 65_536;
const VERIFIED_CODECS = new WeakSet();
const SCHEMATIC_TRANSFORMERS = new WeakMap();

// Reviewed scalar/relative properties. Unknown property names are not assumed invariant.
const INVARIANT = new Set(("active age attached attachment berries bites bloom bottom can_summon candles charges conditional cracked crafting delay disarmed distance down drag dusted eggs enabled extended eye face flower_amount half hanging has_book has_bottle_0 has_bottle_1 has_bottle_2 has_record hatch hinge honey_level in_wall instrument inverted layers leaves level lit locked mode moisture natural note occupied ominous open part persistent pickles power powered sculk_sensor_phase short shrieking signal_fire slot_0_occupied slot_1_occupied slot_2_occupied slot_3_occupied slot_4_occupied slot_5_occupied snowy stage thickness tilt tip trial_spawner_state triggered type unstable up vault_state vertical_direction waterlogged").split(" "));
const STAIR_SHAPES = new Set(["straight", "inner_left", "inner_right", "outer_left", "outer_right"]);
const RAIL_SHAPES = new Set(["north_south", "east_west", "ascending_north", "ascending_east", "ascending_south", "ascending_west", "south_east", "south_west", "north_west", "north_east"]);

function direction(value, turns) {
  const index = CARDINAL.indexOf(value);
  if (index !== -1) return CARDINAL[(index + turns) % 4];
  if (value === "up" || value === "down") return value;
  throw new Error(`Unclassified direction ${String(value)}`);
}

function rotateRail(shape, turns) {
  if (!RAIL_SHAPES.has(shape)) throw new Error(`Unclassified rail shape ${String(shape)}`);
  if (shape.startsWith("ascending_")) return `ascending_${direction(shape.slice(10), turns)}`;
  const parts = shape.split("_").map((value) => direction(value, turns));
  const set = new Set(parts);
  return [...RAIL_SHAPES].find((candidate) => {
    if (candidate.startsWith("ascending_")) return false;
    const pair = candidate.split("_");
    return pair.every((value) => set.has(value));
  });
}

function rotatedProperties(name, properties, turns) {
  const result = {};
  for (const [key, value] of Object.entries(properties)) {
    if (CARDINAL.includes(key)) {
      result[direction(key, turns)] = value;
    } else if (key === "facing") {
      result[key] = direction(value, turns);
    } else if (key === "axis") {
      if (!["x", "y", "z"].includes(value)) throw new Error(`Unclassified axis ${String(value)}`);
      result[key] = turns % 2 && value !== "y" ? (value === "x" ? "z" : "x") : value;
    } else if (key === "rotation") {
      if (!(typeof value === "number" || typeof value === "string") || !/^(?:[0-9]|1[0-5])$/.test(String(value))) throw new Error("Unclassified rotation");
      const rotated = (Number(value) + 4 * turns) % 16;
      result[key] = typeof value === "number" ? rotated : String(rotated);
    } else if (key === "shape") {
      if (name.endsWith("_stairs") && STAIR_SHAPES.has(value)) result[key] = value;
      else if (name === "rail" || name.endsWith("_rail")) result[key] = rotateRail(value, turns);
      else throw new Error(`Unclassified shape on ${name}: ${String(value)}`);
    } else if (key === "orientation") {
      if (!["jigsaw", "crafter"].includes(name) || typeof value !== "string") throw new Error(`Unclassified orientation on ${name}`);
      const parts = value.split("_");
      if (parts.length !== 2 || !((CARDINAL.includes(parts[0]) && parts[1] === "up") || (["up", "down"].includes(parts[0]) && CARDINAL.includes(parts[1])))) throw new Error(`Unclassified orientation ${value}`);
      result[key] = parts.map((part) => direction(part, turns)).join("_");
    } else if (INVARIANT.has(key)) {
      result[key] = value;
    } else {
      throw new Error(`Unclassified property ${key} on ${name}`);
    }
  }
  return result;
}

function propertyKey(properties) {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) throw new TypeError("Properties must be a readable object");
  const proto = Object.getPrototypeOf(properties);
  if (proto !== Object.prototype && proto !== null) throw new TypeError("Properties must be a plain object");
  if (Reflect.ownKeys(properties).some((key) => typeof key !== "string" || !Object.getOwnPropertyDescriptor(properties, key).enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(properties, key), "value"))) throw new TypeError("Properties must contain only readable data fields");
  return JSON.stringify(Object.keys(properties).sort().map((key) => {
    const value = properties[key];
    if (!(typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value)))) throw new TypeError(`Invalid property ${key}`);
    return [key, typeof value, value];
  }));
}

/** Create a fail-closed codec for an exact Java release and its minecraft-data registry.
 * A supplied registry must share the exact canonical block tables, not just a version label.
 * transformState accepts a decoded block {name, stateId, getProperties()} and a cardinal
 * orientation, returning {name, stateId, properties}; the input must round-trip exactly.
 */
export function createStateTransformer({ version, registry } = {}) {
  if (typeof version !== "string" || !/^\d+(?:\.\d+)+$/.test(version)) throw new TypeError("An exact Java release is required");
  const canonical = minecraftData(version);
  if (!canonical || canonical.version?.type !== "pc" || canonical.version.minecraftVersion !== version || !Number.isSafeInteger(canonical.version.dataVersion) || !canonical.supportFeature("blockStateId")) throw new Error(`No exact modern Java registry for ${version}`);
  registry ??= canonical;
  if (registry.version?.type !== "pc" || registry.version.minecraftVersion !== version || registry.version.dataVersion !== canonical.version.dataVersion || registry.blocksByName !== canonical.blocksByName || registry.blocksByStateId !== canonical.blocksByStateId) throw new Error("Registry identity mismatch");
  const blocksByName = canonical.blocksByName;
  const blocksByStateId = canonical.blocksByStateId;
  const dataVersion = canonical.version.dataVersion;
  // The prismarine-block loader annotates registry block definitions with collision
  // shapes. Disable that unrelated mutation; state decoding needs no collision data.
  const decodingRegistry = Object.create(canonical);
  decodingRegistry.blockCollisionShapes = null;
  const Block = prismarineBlock(decodingRegistry);
  const cache = new Map();

  function indexFor(name, session) {
    if (registry.blocksByName !== blocksByName || registry.blocksByStateId !== blocksByStateId || canonical.blocksByName !== blocksByName || canonical.blocksByStateId !== blocksByStateId || registry.version?.type !== "pc" || registry.version.minecraftVersion !== version || registry.version.dataVersion !== dataVersion || canonical.version?.type !== "pc" || canonical.version.minecraftVersion !== version || canonical.version.dataVersion !== dataVersion) throw new Error("Registry identity mismatch");
    if (typeof name !== "string" || !/^[a-z0-9_]+$/.test(name)) throw new Error("Invalid block name");
    const definition = registry.blocksByName[name];
    if (!definition || definition.name !== name || !Array.isArray(definition.states) || !Number.isSafeInteger(definition.minStateId) || !Number.isSafeInteger(definition.maxStateId) || definition.minStateId < 0 || definition.maxStateId < definition.minStateId || definition.maxStateId - definition.minStateId + 1 > MAX_INDEXED_STATES) throw new Error(`Unknown or unreadable registry block ${name}`);
    const signature = JSON.stringify([definition.id, definition.minStateId, definition.maxStateId, definition.states]);
    const previous = session?.indexes.get(name);
    if (previous) {
      if (previous.definition !== definition || previous.signature !== signature) throw new Error(`Registry changed for ${name}`);
      return previous.index;
    }
    if (session) {
      const count = definition.maxStateId - definition.minStateId + 1;
      if (session.indexes.size >= MAX_SCHEMATIC_BLOCKS || session.states + count > MAX_SCHEMATIC_INDEXED_STATES) throw new RangeError("Excessive schematic registry indexing");
      session.states += count;
    }
    const cached = cache.get(name);
    if (cached?.definition === definition && cached.signature === signature) {
      cache.delete(name); cache.set(name, cached);
      session?.indexes.set(name, cached);
      return cached.index;
    }
    const index = new Map();
    for (let id = definition.minStateId; id <= definition.maxStateId; id++) {
      if (registry.blocksByStateId[id] !== definition) throw new Error(`Inconsistent registry state ${id}`);
      const decoded = Block.fromStateId(id, 0);
      if (decoded.name !== name || decoded.stateId !== id || typeof decoded.getProperties !== "function") throw new Error(`Unreadable registry state ${id}`);
      const properties = decoded.getProperties();
      const key = propertyKey(properties);
      const fields = definition.states.map((state) => state.name).sort();
      if (new Set(fields).size !== fields.length || JSON.stringify(fields) !== JSON.stringify(Object.keys(properties).sort()) || index.has(key)) throw new Error(`Inconsistent registry properties for ${name}`);
      const encoded = Block.fromProperties(name, properties, 0);
      if (encoded.name !== name || encoded.stateId !== id || propertyKey(encoded.getProperties()) !== key) throw new Error(`Registry round-trip failed for ${name} state ${id}`);
      index.set(key, id);
    }
    cache.delete(name);
    const entry = { definition, signature, index };
    cache.set(name, entry);
    session?.indexes.set(name, entry);
    if (cache.size > MAX_CACHED_BLOCKS) cache.delete(cache.keys().next().value);
    return index;
  }

  function transformState(block, orientation, session) {
    if (!Object.hasOwn(TURNS, orientation)) throw new Error("Invalid cardinal orientation");
    if (!block || typeof block.getProperties !== "function" || !Number.isSafeInteger(block.stateId) || block.stateId < 0) throw new TypeError("A readable decoded block and state ID are required");
    const properties = block.getProperties();
    const key = propertyKey(properties);
    const index = indexFor(block.name, session);
    if (index.get(key) !== block.stateId || registry.blocksByStateId[block.stateId] !== registry.blocksByName[block.name]) throw new Error(`Input state ID/properties mismatch for ${block.name}`);
    const rotated = rotatedProperties(block.name, properties, TURNS[orientation]);
    const resultKey = propertyKey(rotated);
    const stateId = index.get(resultKey);
    if (stateId === undefined || registry.blocksByStateId[stateId] !== registry.blocksByName[block.name]) throw new Error(`Transformed state absent from registry for ${block.name}`);
    const decoded = Block.fromStateId(stateId, 0);
    if (decoded.name !== block.name || decoded.stateId !== stateId || propertyKey(decoded.getProperties()) !== resultKey) throw new Error(`Transformed state registry mismatch for ${block.name}`);
    return { name: block.name, stateId, properties: rotated };
  }
  const codec = Object.freeze({ version, dataVersion, transformState: (block, orientation) => transformState(block, orientation) });
  VERIFIED_CODECS.add(codec);
  SCHEMATIC_TRANSFORMERS.set(codec, () => {
    const session = { indexes: new Map(), states: 0 };
    return (block, orientation) => transformState(block, orientation, session);
  });
  return codec;
}

function vector(value, label, positive = false) {
  if (!value || ["x", "y", "z"].some((key) => !Number.isSafeInteger(value[key]) || (positive && value[key] <= 0))) throw new TypeError(`Invalid ${label}`);
  return { x: value.x, y: value.y, z: value.z };
}

/** Transform every schematic cell (including air) into x-fastest minimum-corner-relative order.
 * The source is a prismarine-schematic-compatible object; origin is the destination minimum.
 * Returns {size, origin, cells}, with cells containing {index, position, name, stateId, properties}.
 */
export function transformSchematic(schematic, { orientation, origin, codec } = {}) {
  if (!Object.hasOwn(TURNS, orientation)) throw new Error("Invalid cardinal orientation");
  if (!codec || !VERIFIED_CODECS.has(codec) || schematic?.version !== codec.version) throw new Error("Schematic/codec version mismatch or unverified codec");
  const size = vector(schematic.size, "size", true);
  const offset = vector(schematic.offset ?? { x: 0, y: 0, z: 0 }, "source offset");
  origin = vector(origin, "origin");
  const volume = size.x * size.y * size.z;
  if (!Number.isSafeInteger(volume) || volume > MAX_VOLUME) throw new RangeError("Unsafe or excessive schematic volume");
  const turns = TURNS[orientation];
  const dest = turns % 2 ? { x: size.z, y: size.y, z: size.x } : { ...size };
  for (const key of ["x", "y", "z"]) {
    if (!Number.isSafeInteger(offset[key] + (size[key] - 1)) || !Number.isSafeInteger(origin[key] + (dest[key] - 1))) throw new RangeError("Unsafe coordinate bounds");
  }
  const palette = schematic.palette;
  const paletteLength = palette?.length;
  if (!schematic.blocks || schematic.blocks.length !== volume || !palette || !Number.isSafeInteger(paletteLength) || paletteLength < 1 || paletteLength > MAX_PALETTE_ENTRIES || typeof schematic.getBlock !== "function") throw new TypeError("Invalid schematic block data or excessive palette");
  // Retain one bounded index per distinct block for this invocation only. Every cell
  // still supplies and validates its own typed properties and both registry mappings.
  const transformState = SCHEMATIC_TRANSFORMERS.get(codec)();
  const cells = new Array(volume);
  for (let y = 0; y < size.y; y++) for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) {
    const sourceIndex = (y * size.z + z) * size.x + x;
    if (schematic.palette !== palette || palette.length !== paletteLength) throw new Error("Schematic palette changed during transform");
    const paletteIndex = schematic.blocks[sourceIndex];
    if (!Number.isSafeInteger(paletteIndex) || paletteIndex < 0 || paletteIndex >= paletteLength) throw new Error(`Invalid palette index at ${sourceIndex}`);
    const sourceId = palette[paletteIndex];
    if (!Number.isSafeInteger(sourceId) || sourceId < 0) throw new Error(`Invalid source state at ${sourceIndex}`);
    const decoded = schematic.getBlock(new Vec3(offset.x + x, offset.y + y, offset.z + z));
    if (schematic.palette !== palette || palette.length !== paletteLength || palette[paletteIndex] !== sourceId) throw new Error("Schematic palette changed during transform");
    if (!decoded || decoded.stateId !== sourceId) throw new Error(`Decoded source state mismatch at ${sourceIndex}`);
    const state = transformState(decoded, orientation);
    if (schematic.palette !== palette || palette.length !== paletteLength || palette[paletteIndex] !== sourceId) throw new Error("Schematic palette changed during transform");
    const [dx, dz] = turns === 0 ? [x, z] : turns === 1 ? [size.z - 1 - z, x] : turns === 2 ? [size.x - 1 - x, size.z - 1 - z] : [z, size.x - 1 - x];
    if (dx < 0 || dx >= dest.x || dz < 0 || dz >= dest.z) throw new Error("Transformed cell out of bounds");
    const index = (y * dest.z + dz) * dest.x + dx;
    if (!Number.isSafeInteger(index) || index < 0 || index >= volume || cells[index]) throw new Error("Non-bijective schematic transform");
    cells[index] = { index, position: { x: origin.x + dx, y: origin.y + y, z: origin.z + dz }, ...state };
  }
  if (cells.filter(Boolean).length !== volume) throw new Error("Incomplete schematic transform");
  return { size: dest, origin, cells };
}
