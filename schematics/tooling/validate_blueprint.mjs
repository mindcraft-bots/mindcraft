#!/usr/bin/env node
/** Full Sponge-v2 comparison through the real reader and blueprint-selected registry. */
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { readSchematic } from "../../src/utils/schematic/reader.js";
import { schematicProvenance } from "../../src/utils/schematic/provenance.js";

const require = createRequire(import.meta.url);
const minecraftData = require("minecraft-data");
const Vec3 = require("vec3");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseState(raw) {
  const match = /^([a-z0-9_.-]+):([a-z0-9_./-]+)(?:\[(.*)\])?$/.exec(raw);
  assert(match, `Malformed canonical state ${JSON.stringify(raw)}`);
  const [, namespace, name, rawProperties = ""] = match;
  assert(namespace === "minecraft", `Non-vanilla namespace ${namespace} in ${raw}`);
  const properties = {};
  if (rawProperties) {
    for (const entry of rawProperties.split(",")) {
      const separator = entry.indexOf("=");
      assert(separator > 0 && separator < entry.length - 1, `Malformed property ${entry} in ${raw}`);
      const key = entry.slice(0, separator);
      assert(!Object.hasOwn(properties, key), `Duplicate property ${key} in ${raw}`);
      properties[key] = entry.slice(separator + 1);
    }
  }
  return { namespace, name, properties };
}

function registryCheck(raw, registry, version) {
  const { name, properties } = parseState(raw);
  const block = registry.blocksByName[name];
  assert(block, `${raw} is not a vanilla Minecraft ${version} block`);
  const states = new Map((block.states ?? []).map((state) => [state.name, state]));
  const propertyKeys = Object.keys(properties).sort();
  const registryKeys = [...states.keys()].sort();
  assert(JSON.stringify(propertyKeys) === JSON.stringify(registryKeys), `${raw} does not specify the complete canonical property set (registry: ${registryKeys.join(",") || "none"})`);
  for (const [key, value] of Object.entries(properties)) {
    const state = states.get(key);
    const valid = Array.isArray(state.values)
      ? state.values.some((candidate) => String(candidate) === value)
      : state.type === "bool"
        ? value === "true" || value === "false"
        : state.type === "int"
          ? /^-?\d+$/.test(value)
          : false;
    assert(valid, `${raw} has illegal ${key}=${value} for Minecraft ${version}`);
  }
  return { name, properties };
}

function normalizedProperties(block) {
  const actual = block.getProperties?.() ?? {};
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, String(value)]).sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
  const args = process.argv.slice(2);
  const requireProvenance = args.includes('--require-strict-provenance');
  const positional = args.filter(arg => arg !== '--require-strict-provenance');
  const [blueprintArg, schematicArg, versionArg] = positional;
  assert(blueprintArg && schematicArg && positional.length <= 3 && args.length === positional.length + Number(requireProvenance)
    && !positional.some(arg => arg.startsWith('--')),
    "Usage: node schematics/tooling/validate_blueprint.mjs <blueprint.json> <output.schem> [<MC_VERSION>] [--require-strict-provenance]");
  const resolveInput = async (input) => {
    const candidate = path.resolve(projectRoot, input);
    const resolved = await realpath(candidate);
    const relative = path.relative(projectRoot, resolved);
    assert(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      `Input path escapes project root: ${input}`);
    return resolved;
  };
  const blueprintPath = await resolveInput(blueprintArg);
  const schematicPath = await resolveInput(schematicArg);
  const blueprint = JSON.parse(await readFile(blueprintPath, "utf8"));
  const version = versionArg ?? blueprint.minecraft_version;
  assert(typeof version === "string" && version.length > 0,
    "Blueprint must declare minecraft_version or an explicit MC_VERSION must be supplied");
  if (versionArg && blueprint.minecraft_version) {
    assert(versionArg === blueprint.minecraft_version,
      `Requested Minecraft version ${versionArg} differs from blueprint minecraft_version ${blueprint.minecraft_version}`);
  }
  assert(Number.isInteger(blueprint.data_version) && blueprint.data_version > 0,
    "Blueprint must declare a positive integer data_version");
  const registry = minecraftData(version);
  assert(registry?.blocksByName && registry.version.minecraftVersion === version, `minecraft-data registry ${version} unavailable`);
  assert(registry.version.dataVersion === blueprint.data_version,
    `Blueprint data_version ${blueprint.data_version} does not match minecraft-data ${version} DataVersion ${registry.version.dataVersion}`);

  const expectedStates = new Map();
  for (const [char, raw] of Object.entries(blueprint.legend)) {
    assert(char.length === 1, `Legend key ${JSON.stringify(char)} is not one character`);
    expectedStates.set(char, registryCheck(raw, registry, version));
  }

  const buffer = await readFile(schematicPath);
  assert(buffer.length > 0, `Empty schematic ${schematicPath}`);
  // This is the production parser export (src/utils/schematic/reader.js), not a test parser.
  const schematic = await readSchematic(buffer, version);
  const dimensions = [blueprint.width_x, blueprint.height_y, blueprint.length_z];
  const actualDimensions = [schematic.size.x, schematic.size.y, schematic.size.z];
  assert(JSON.stringify(actualDimensions) === JSON.stringify(dimensions), `Dimensions ${actualDimensions} differ from blueprint ${dimensions}`);
  const volume = dimensions.reduce((product, dimension) => product * dimension, 1);
  const counts = Object.create(null);
  const mismatches = [];
  const spotFailures = [];
  let compared = 0;
  for (let y = 0; y < blueprint.height_y; y++) {
    const layer = blueprint.layers[y];
    assert(layer.length === blueprint.length_z, `Layer ${y} has invalid z length`);
    for (let z = 0; z < blueprint.length_z; z++) {
      const row = layer[z];
      assert(row.length === blueprint.width_x, `Row y=${y}, z=${z} has invalid x length`);
      for (let x = 0; x < blueprint.width_x; x++) {
        const char = row[x];
        const expected = expectedStates.get(char);
        assert(expected, `Unknown blueprint legend character ${JSON.stringify(char)} at (${x},${y},${z})`);
        const actual = schematic.getBlock(new Vec3(x, y, z));
        if (!actual) {
          mismatches.push({ x, y, z, expected: blueprint.legend[char], actual: null });
          compared++;
          continue;
        }
        const actualProperties = normalizedProperties(actual);
        const sortedExpected = Object.fromEntries(Object.entries(expected.properties).sort(([a], [b]) => a.localeCompare(b)));
        const expectedCanonical = `minecraft:${expected.name}${Object.keys(sortedExpected).length ? `[${Object.entries(sortedExpected).map(([key, value]) => `${key}=${value}`).join(",")}]` : ""}`;
        const actualCanonical = `minecraft:${actual.name}${Object.keys(actualProperties).length ? `[${Object.entries(actualProperties).map(([key, value]) => `${key}=${value}`).join(",")}]` : ""}`;
        if (actual.name !== expected.name || JSON.stringify(actualProperties) !== JSON.stringify(sortedExpected)) {
          mismatches.push({ x, y, z, expected: expectedCanonical, actual: actualCanonical });
        }
        counts[actualCanonical] = (counts[actualCanonical] ?? 0) + 1;
        compared++;
      }
    }
  }
  assert(compared === volume, `Compared ${compared} voxels, expected ${volume}`);
  for (const spot of blueprint.spot_checks) {
    const expected = expectedStates.get(spot.char);
    const actual = schematic.getBlock(new Vec3(spot.x, spot.y, spot.z));
    if (!actual || actual.name !== expected.name || JSON.stringify(normalizedProperties(actual)) !==
      JSON.stringify(Object.fromEntries(Object.entries(expected.properties).sort(([a], [b]) => a.localeCompare(b))))
    ) spotFailures.push({ x: spot.x, y: spot.y, z: spot.z, note: spot.note ?? "", expected: blueprint.legend[spot.char], actual: actual ? `minecraft:${actual.name}[${JSON.stringify(normalizedProperties(actual))}]` : null });
  }
  const expectedCounts = blueprint.expected_counts;
  const countDiffs = [...new Set([...Object.keys(counts), ...Object.keys(expectedCounts)])].sort()
    .filter((state) => (counts[state] ?? 0) !== (expectedCounts[state] ?? 0))
    .map((state) => ({ state, expected: expectedCounts[state] ?? 0, actual: counts[state] ?? 0 }));
  const provenance = await schematicProvenance(schematicPath, buffer);
  const provenanceOutcome = provenance.validationStatus === 'STRICT_VALIDATED' ? 'PASS'
    : provenance.validationStatus === 'INVALID' ? 'FAIL' : 'UNVERIFIED';
  const voxelOutcome = mismatches.length === 0 && spotFailures.length === 0 && countDiffs.length === 0 ? 'PASS' : 'FAIL';
  const result = {
    voxelOutcome,
    provenanceOutcome,
    provenanceRequired: requireProvenance,
    blueprint: path.relative(projectRoot, blueprintPath),
    schematic: path.relative(projectRoot, schematicPath),
    parser: "src/utils/schematic/reader.js readSchematic -> prismarine-schematic",
    registry: `minecraft-data ${version}`,
    ...provenance,
    legalCombinationProof: 'NOT_PERFORMED_BY_READER_COMPARISON',
    dimensions: actualDimensions,
    volume,
    comparedVoxels: compared,
    expectedNonAir: blueprint.non_air_count,
    parserDerivedAir: counts["minecraft:air"] ?? 0,
    parserDerivedCountsMatch: countDiffs.length === 0,
    countDiffs,
    legendEntriesDomainChecked: Object.keys(blueprint.legend).length,
    spotChecks: blueprint.spot_checks.length,
    spotCheckFailures: spotFailures,
    parserMismatches: mismatches.length,
    firstMismatches: mismatches.slice(0, 20),
    fullVoxelAndStateComparison: mismatches.length === 0 ? "PASS" : "FAIL",
  };
  console.log(JSON.stringify(result, null, 2));
  if (voxelOutcome !== 'PASS' || (requireProvenance && provenanceOutcome !== 'PASS')) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`VALIDATION FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
