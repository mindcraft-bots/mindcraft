import { validateSpongeStructure } from "./sponge_structure.js";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const nbt = require("prismarine-nbt");
const minecraftData = require("minecraft-data");
const { Schematic } = require("prismarine-schematic");
const legacyBlocks = minecraftData.legacy.pc.blocks;
const CHAIN_MIGRATION = Object.freeze({
  sourceMinecraftVersion: "1.21.4",
  sourceDataVersion: 4189,
  targetMinecraftVersion: "26.1",
  targetDataVersion: 4786,
  sourceName: "chain",
  targetName: "iron_chain",
});

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

function parseSpongeState(rawName, sourceDescription) {
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

  return { name, properties };
}

function parseSpongeBlockName(rawName, registry, sourceDescription) {
  const { name, properties } = parseSpongeState(rawName, sourceDescription);
  checkBlock(registry, name, properties, sourceDescription, rawName);
  return { name, properties };
}

function validateSpongePalette(root, registry) {
  const palette = root.Palette;
  if (!palette || typeof palette !== "object" || Array.isArray(palette)) return false;

  for (const rawName of Object.keys(palette)) {
    parseSpongeBlockName(rawName, registry, "Sponge v2 schematic");
  }
  return true;
}

function registryMinecraftVersion(registry) {
  return registry?.version?.minecraftVersion
    ?? (typeof registry?.version === "string" ? registry.version : null);
}

function targetChainState(rawName, registry) {
  const { name, properties } = parseSpongeState(rawName, "Sponge v2 schematic");
  if (name !== CHAIN_MIGRATION.sourceName) return null;

  const propertyNames = Object.keys(properties).sort();
  if (propertyNames.join(",") !== "axis,waterlogged"
      || !["x", "y", "z"].includes(properties.axis)
      || !["true", "false"].includes(properties.waterlogged)) {
    throw new Error(`Cannot migrate ${rawName}: expected explicit axis and waterlogged properties; no state may be discarded`);
  }

  const migratedName = `minecraft:${CHAIN_MIGRATION.targetName}[${Object.entries(properties)
    .map(([key, value]) => `${key}=${value}`).join(",")}]`;
  checkBlock(registry, CHAIN_MIGRATION.targetName, properties, "Sponge v2 migrated palette", migratedName);
  return migratedName;
}

function migrateSpongePalette(parsed, root, targetVersion, targetRegistry) {
  const palette = root.Palette;
  if (!palette || typeof palette !== "object" || Array.isArray(palette)) return null;
  const sourceEntries = Object.keys(palette);
  const chainEntries = sourceEntries.filter((rawName) => parseSpongeState(rawName, "Sponge v2 schematic").name === CHAIN_MIGRATION.sourceName);
  if (chainEntries.length === 0 || targetRegistry.blocksByName[CHAIN_MIGRATION.sourceName]) return null;

  const targetRegistryVersion = registryMinecraftVersion(targetRegistry);
  const targetDataVersion = targetRegistry.version?.dataVersion;
  if (targetVersion !== CHAIN_MIGRATION.targetMinecraftVersion
      || targetRegistryVersion !== CHAIN_MIGRATION.targetMinecraftVersion
      || targetDataVersion !== CHAIN_MIGRATION.targetDataVersion) {
    throw new Error(`Cannot migrate minecraft:chain: this mapping requires the verified Minecraft ${CHAIN_MIGRATION.targetMinecraftVersion} / DataVersion ${CHAIN_MIGRATION.targetDataVersion} target registry`);
  }
  if (root.Version !== 2 || root.DataVersion !== CHAIN_MIGRATION.sourceDataVersion) {
    throw new Error(`Cannot migrate minecraft:chain for Minecraft ${CHAIN_MIGRATION.targetMinecraftVersion}: Sponge v2 source must declare DataVersion ${CHAIN_MIGRATION.sourceDataVersion}; found Version ${root.Version ?? "missing"}, DataVersion ${root.DataVersion ?? "missing"}`);
  }

  const sourceRegistry = minecraftData(CHAIN_MIGRATION.sourceMinecraftVersion);
  if (!sourceRegistry?.blocksByName
      || sourceRegistry.version?.minecraftVersion !== CHAIN_MIGRATION.sourceMinecraftVersion
      || sourceRegistry.version?.dataVersion !== CHAIN_MIGRATION.sourceDataVersion) {
    throw new Error(`Cannot verify the Minecraft ${CHAIN_MIGRATION.sourceMinecraftVersion} / DataVersion ${CHAIN_MIGRATION.sourceDataVersion} source registry for minecraft:chain migration`);
  }
  // Validate the complete source palette first; the declared DataVersion alone is not a conversion.
  validateSpongePalette(root, sourceRegistry);

  const typedPalette = parsed.value?.Palette?.value;
  if (!typedPalette || typeof typedPalette !== "object") {
    throw new Error("Cannot migrate minecraft:chain: Sponge v2 palette metadata is inconsistent");
  }
  for (const rawName of chainEntries) {
    const migratedName = targetChainState(rawName, targetRegistry);
    if (Object.hasOwn(palette, migratedName) || Object.hasOwn(typedPalette, migratedName)) {
      throw new Error(`Cannot migrate ${rawName}: target palette name ${migratedName} already exists and would make palette indices ambiguous`);
    }
    typedPalette[migratedName] = typedPalette[rawName];
    delete typedPalette[rawName];
    palette[migratedName] = palette[rawName];
    delete palette[rawName];
  }
  validateSpongePalette(root, targetRegistry);
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

async function prepareSchematicSource(buffer, version, registry) {
  const sourceBuffer = Buffer.isBuffer(buffer) ? Buffer.from(buffer) : buffer;
  let parsed;
  try {
    parsed = await parseNbt(sourceBuffer);
  } catch {
    // Let Schematic.read produce the authoritative parse error for malformed or unsupported NBT.
    return sourceBuffer;
  }

  let root;
  try {
    root = nbt.simplify(parsed);
  } catch {
    return sourceBuffer;
  }
  if (!root || typeof root !== "object") return sourceBuffer;

  const hasSpongePalette = root.Palette && typeof root.Palette === "object";
  const hasLegacyBlocks = Array.isArray(root.Blocks);
  if (!hasSpongePalette && !hasLegacyBlocks) {
    if (root.Version === 2 || root.BlockData) validateSpongeStructure(parsed);
    return sourceBuffer;
  }

  const data = registryFor(version, registry);
  if (hasSpongePalette) {
    const migrated = migrateSpongePalette(parsed, root, version, data);
    validateSpongeStructure(parsed);
    if (!migrated) validateSpongePalette(root, data);
    if (migrated) {
      const serialized = nbt.writeUncompressed(parsed);
      return sourceBuffer[0] === 0x1f && sourceBuffer[1] === 0x8b ? gzipSync(serialized) : serialized;
    }
  } else validateLegacyBlocks(root, data);
  return sourceBuffer;
}

/** Reject lossy block-name/state conversions before prismarine-schematic parses the source. */
export async function validateSchematicSource(buffer, version, registry) {
  await prepareSchematicSource(buffer, version, registry);
}

/** Validate source NBT before delegating actual schematic parsing to prismarine-schematic. */
export async function readSchematic(buffer, version, SchematicClass = Schematic, registry) {
  const prepared = await prepareSchematicSource(buffer, version, registry);
  return SchematicClass.read(prepared, version);
}
