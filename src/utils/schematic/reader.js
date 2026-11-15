import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nbt = require("prismarine-nbt");
const minecraftData = require("minecraft-data");
const { Schematic } = require("prismarine-schematic");
const legacyBlocks = minecraftData.legacy.pc.blocks;

function parseNbt(buffer) {
  return new Promise((resolve, reject) => {
    nbt.parse(buffer, (error, parsed) => {
      if (error) reject(error);
      else resolve(parsed);
    });
  });
}

function registryFor(version, registry) {
  if (registry?.blocksByName) return registry;
  if (typeof version !== "string" || version.length === 0) {
    throw new TypeError("A Minecraft server version is required to validate schematic blocks");
  }
  const data = minecraftData(version);
  if (!data?.blocksByName) throw new Error(`No block registry is available for Minecraft ${version}`);
  return data;
}

function checkBlock(registry, name, properties, sourceDescription, displayName = name) {
  const block = registry.blocksByName[name];
  if (!block) {
    const version = registry.version?.minecraftVersion ?? registry.version ?? "server";
    throw new Error(`${sourceDescription} contains unsupported block "${displayName}" for Minecraft ${version}`);
  }

  const states = new Map((block.states ?? []).map((state) => [state.name, state]));
  for (const [key, value] of Object.entries(properties)) {
    const state = states.get(key);
    if (!state) {
      throw new Error(`${sourceDescription} block "${displayName}" has unsupported property "${key}"`);
    }
    const stringValue = String(value);
    const allowed = state.values;
    const valid = Array.isArray(allowed)
      ? allowed.some((candidate) => String(candidate) === stringValue)
      : state.type === "bool"
        ? stringValue === "true" || stringValue === "false"
        : state.type === "int"
          ? /^-?\d+$/.test(stringValue)
          : false;
    if (!valid) {
      const values = Array.isArray(allowed) ? ` (allowed: ${allowed.join(", ")})` : "";
      throw new Error(`${sourceDescription} block "${displayName}" has invalid property/state ${key}=${stringValue}${values}`);
    }
  }
}

function parseSpongeBlockName(rawName, registry, sourceDescription) {
  if (typeof rawName !== "string") {
    throw new Error(`${sourceDescription} contains a non-string Sponge palette entry`);
  }

  const match = /^([a-z0-9_.-]+):([a-z0-9_./-]+)(?:\[(.*)\])?$/.exec(rawName);
  if (!match) {
    throw new Error(`${sourceDescription} contains malformed Sponge palette block "${rawName}"`);
  }
  const [, namespace, name, rawProperties = ""] = match;
  // prismarine-schematic 1.3.0's state parser drops namespaces other than minecraft.
  if (namespace !== "minecraft") {
    throw new Error(`${sourceDescription} block "${rawName}" uses unsupported namespace "${namespace}"; only minecraft blocks are supported`);
  }

  const properties = {};
  if (rawProperties.length > 0) {
    for (const entry of rawProperties.split(",")) {
      const separator = entry.indexOf("=");
      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error(`${sourceDescription} has malformed state "${entry}" on block "${name}"`);
      }
      const key = entry.slice(0, separator);
      const value = entry.slice(separator + 1);
      if (Object.hasOwn(properties, key)) {
        throw new Error(`${sourceDescription} repeats property "${key}" on block "${name}"`);
      }
      properties[key] = value;
    }
  }

  checkBlock(registry, name, properties, sourceDescription, rawName);
}

function validateSpongePalette(root, registry) {
  const palette = root.Palette;
  if (!palette || typeof palette !== "object" || Array.isArray(palette)) return false;

  for (const rawName of Object.keys(palette)) {
    parseSpongeBlockName(rawName, registry, "Sponge v2 schematic");
  }
  return true;
}

function legacyName(id, data) {
  return legacyBlocks[`${id}:${data}`] ?? legacyBlocks[`${id}:0`] ?? null;
}

function parseLegacyName(rawName, registry, id, data) {
  if (!rawName) {
    throw new Error(`Legacy schematic contains unknown block ID/data ${id}:${data}; refusing prismarine-schematic's implicit stone fallback`);
  }

  const match = /^minecraft:([a-z0-9_./-]+)(?:\[(.*)\])?$/.exec(rawName);
  if (!match) {
    throw new Error(`Legacy schematic block ID/data ${id}:${data} maps to unsupported block "${rawName}"`);
  }
  const [, name, rawProperties = ""] = match;
  const properties = {};
  if (rawProperties) {
    for (const entry of rawProperties.split(",")) {
      const separator = entry.indexOf("=");
      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error(`Legacy schematic block ID/data ${id}:${data} has malformed state "${entry}"`);
      }
      properties[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  }
  checkBlock(registry, name, properties, `Legacy schematic block ID/data ${id}:${data}`, rawName);
}

function validateLegacyBlocks(root, registry) {
  if (!Array.isArray(root.Blocks) || !Array.isArray(root.Data)) return false;

  for (let index = 0; index < root.Blocks.length; index++) {
    let id = root.Blocks[index] & 0xff;
    if (Array.isArray(root.AddBlocks)) {
      id += index & 1
        ? (root.AddBlocks[index >> 1] & 0x0f) << 8
        : (root.AddBlocks[index >> 1] & 0xf0) << 4;
    }
    const data = root.Data[index];
    const mappedName = legacyName(id, data);
    parseLegacyName(mappedName, registry, id, data);
  }
  return true;
}

/** Reject lossy block-name/state conversions before prismarine-schematic parses the source. */
export async function validateSchematicSource(buffer, version, registry) {
  let parsed;
  try {
    parsed = await parseNbt(buffer);
  } catch {
    // Let Schematic.read produce the authoritative parse error for malformed or unsupported NBT.
    return;
  }

  let root;
  try {
    root = nbt.simplify(parsed);
  } catch {
    return;
  }
  if (!root || typeof root !== "object") return;

  const hasSpongePalette = root.Palette && typeof root.Palette === "object";
  const hasLegacyBlocks = Array.isArray(root.Blocks);
  if (!hasSpongePalette && !hasLegacyBlocks) return;

  const data = registryFor(version, registry);
  if (hasSpongePalette) validateSpongePalette(root, data);
  else validateLegacyBlocks(root, data);
}

/** Validate source NBT before delegating actual schematic parsing to prismarine-schematic. */
export async function readSchematic(buffer, version, SchematicClass = Schematic, registry) {
  await validateSchematicSource(buffer, version, registry);
  return SchematicClass.read(buffer, version);
}
