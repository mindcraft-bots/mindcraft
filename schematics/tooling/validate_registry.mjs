#!/usr/bin/env node
/** Validate blueprint metadata and complete block states using minecraft-data. */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const minecraftData = require("minecraft-data");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseState(raw, version, registry) {
  const match = /^([a-z0-9_.-]+):([a-z0-9_./-]+)(?:\[(.*)\])?$/.exec(raw);
  assert(match, `malformed block state ${JSON.stringify(raw)}`);
  const [, namespace, name, rawProperties = ""] = match;
  assert(namespace === "minecraft", `non-vanilla namespace ${namespace} in ${raw}`);
  const properties = Object.create(null);
  if (rawProperties) {
    for (const entry of rawProperties.split(",")) {
      const separator = entry.indexOf("=");
      assert(separator > 0 && separator < entry.length - 1, `malformed property ${entry} in ${raw}`);
      const key = entry.slice(0, separator);
      assert(!Object.hasOwn(properties, key), `duplicate property ${key} in ${raw}`);
      properties[key] = entry.slice(separator + 1);
    }
  }
  const block = Object.hasOwn(registry.blocksByName, name) ? registry.blocksByName[name] : undefined;
  assert(block, `${raw} is not a vanilla Minecraft ${version} block`);
  const states = new Map((block.states ?? []).map((state) => [state.name, state]));
  const propertyKeys = Object.keys(properties).sort();
  const registryKeys = [...states.keys()].sort();
  assert(JSON.stringify(propertyKeys) === JSON.stringify(registryKeys),
    `${raw} must specify the complete canonical property set (registry: ${registryKeys.join(",") || "none"})`);
  for (const [key, value] of Object.entries(properties)) {
    const state = states.get(key);
    let valid = false;
    if (state.type === "int" && !/^(?:0|-?[1-9]\d*)$/.test(value)) {
      valid = false;
    } else if (Array.isArray(state.values)) {
      valid = state.values.some((candidate) => String(candidate) === value);
    } else if (state.type === "bool") {
      valid = value === "true" || value === "false";
    } else if (state.type === "int") {
      const number = Number(value);
      // Older minecraft-data releases omit explicit integer values; num_values is
      // their registry-provided cardinality for the zero-based integer domain.
      valid = Number.isSafeInteger(number) && Number.isSafeInteger(state.num_values)
        && state.num_values > 0 && number >= 0 && number < state.num_values;
    }
    assert(valid, `${raw} has illegal ${key}=${value} for Minecraft ${version}`);
  }
}

async function main() {
  const [blueprintPath, version] = process.argv.slice(2);
  assert(blueprintPath && version && process.argv.length === 4,
    "Usage: node schematics/tooling/validate_registry.mjs <blueprint.json> <MC_VERSION>");
  const blueprint = JSON.parse(await readFile(blueprintPath, "utf8"));
  assert(blueprint.minecraft_version === version,
    `target Minecraft version ${version} does not match blueprint minecraft_version ${JSON.stringify(blueprint.minecraft_version)}`);
  assert(Number.isInteger(blueprint.data_version) && blueprint.data_version > 0,
    "blueprint must declare a positive integer data_version");
  const release = minecraftData.versions.pc.find((candidate) => candidate.minecraftVersion === version);
  assert(release, `minecraft-data release metadata ${version} unavailable`);
  assert(release.dataVersion === blueprint.data_version,
    `blueprint data_version ${blueprint.data_version} does not match minecraft-data ${version} DataVersion ${release.dataVersion}`);
  const registry = minecraftData(version);
  assert(registry?.blocksByName && registry.version.dataVersion === release.dataVersion,
    `minecraft-data registry ${version} unavailable`);
  assert(blueprint.legend && typeof blueprint.legend === "object" && !Array.isArray(blueprint.legend),
    "blueprint legend must be an object");
  for (const [character, state] of Object.entries(blueprint.legend)) {
    assert([...character].length === 1, `legend key ${JSON.stringify(character)} is not one character`);
    assert(typeof state === "string", `legend state for ${JSON.stringify(character)} must be a string`);
    parseState(state, version, registry);
  }
  console.log(JSON.stringify({ registry: `minecraft-data ${version}`, dataVersion: release.dataVersion,
    paletteEntriesValidated: Object.keys(blueprint.legend).length, result: "PASS" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`REGISTRY VALIDATION FAILED: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
