import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { SCHEMATICS_DIR } from "../../../src/utils/schematic/paths.js";
import { readSchematic, validateSchematicSource } from "../../../src/utils/schematic/reader.js";
import { createModernBuild } from "../../../src/utils/schematic/modern_build.js";

const require = createRequire(import.meta.url);
const nbt = require("prismarine-nbt");
const Vec3 = require("vec3");
const { Schematic } = require("prismarine-schematic");

function serializedSponge(palette, blockData) {
  const root = {
    type: "compound",
    name: "Schematic",
    value: {
      Version: { type: "int", value: 2 },
      DataVersion: { type: "int", value: 3465 },
      Width: { type: "short", value: blockData.length },
      Height: { type: "short", value: 1 },
      Length: { type: "short", value: 1 },
      PaletteMax: { type: "int", value: Object.keys(palette).length },
      Palette: {
        type: "compound",
        value: Object.fromEntries(Object.entries(palette).map(([name, id]) => [name, { type: "int", value: id }])),
      },
      BlockData: { type: "byteArray", value: blockData },
    },
  };
  return gzipSync(nbt.writeUncompressed(root));
}

function serializedLegacy(blockId, data = 0, addBlocks) {
  const value = {
    Width: { type: "short", value: 1 },
    Height: { type: "short", value: 1 },
    Length: { type: "short", value: 1 },
    Materials: { type: "string", value: "Alpha" },
    Blocks: { type: "byteArray", value: [(blockId & 0xff) > 127 ? (blockId & 0xff) - 256 : (blockId & 0xff)] },
    Data: { type: "byteArray", value: [data] },
  };
  if (addBlocks) value.AddBlocks = { type: "byteArray", value: addBlocks.map((entry) => (entry > 127 ? entry - 256 : entry)) };
  return gzipSync(nbt.writeUncompressed({ type: "compound", name: "Schematic", value }));
}

test("migrates the real bee balloon chain in memory for 26.1 while preserving canonical 1.21.4 states and geometry", async () => {
  const file = `${SCHEMATICS_DIR}/schems/pack1/02_bee_hot_air_balloon.mc1.21.4.schem`;
  const source = await readFile(file);
  const originalBytes = Buffer.from(source);
  const registry1214 = require("minecraft-data")("1.21.4");
  const registry261 = require("minecraft-data")("26.1");
  const canonical = await readSchematic(source, "1.21.4", undefined, registry1214);
  const migrated = await readSchematic(source, "26.1", undefined, registry261);
  const expectedCoordinates = [];
  for (let y = 1; y <= 6; y++) {
    for (const z of [3, 6]) for (const x of [3, 6]) expectedCoordinates.push({ x, y, z });
  }

  assert.deepEqual([canonical.size.x, canonical.size.y, canonical.size.z], [10, 17, 9]);
  assert.deepEqual([migrated.size.x, migrated.size.y, migrated.size.z], [10, 17, 9]);
  const canonicalChains = expectedCoordinates.map(({ x, y, z }) => canonical.getBlock(new Vec3(x, y, z)));
  assert.ok(canonicalChains.every((block) => block.name === "chain"));
  assert.ok(canonicalChains.every((block) => block.getProperties().axis === "y" && block.getProperties().waterlogged === false));

  const migratedChains = expectedCoordinates.map(({ x, y, z }) => migrated.getBlock(new Vec3(x, y, z)));
  assert.ok(migratedChains.every((block) => block.name === "iron_chain"));
  assert.ok(migratedChains.every((block) => block.getProperties().axis === "y" && block.getProperties().waterlogged === false));
  assert.deepEqual(migratedChains.map((block) => block.stateId), expectedCoordinates.map(() =>
    require("prismarine-block")("26.1").fromProperties(registry261.blocksByName.iron_chain.id, { axis: "y", waterlogged: "false" }).stateId));

  const plan = createModernBuild(migrated, { version: "26.1", registry: registry261 }, new Vec3(100, 64, -20));
  const chainEntries = plan.plan.filter((entry) => entry.name === "iron_chain");
  assert.deepEqual(chainEntries.map(({ position, properties }) => ({
    x: position.x - 100,
    y: position.y - 64,
    z: position.z + 20,
    properties,
  })), expectedCoordinates.map((position) => ({
    ...position,
    properties: { axis: "y", waterlogged: false },
  })));
  const chainActions = plan.actions.filter((action) => action.blockName === "iron_chain");
  assert.equal(chainActions.length, expectedCoordinates.length);
  for (const action of chainActions) {
    assert.equal(plan.items[action.state].name, "iron_chain");
    assert.deepEqual(action.properties, { axis: "y", waterlogged: false });
  }
  assert.deepEqual(source, originalBytes, "reader migration must not rewrite or mutate canonical source bytes");
});

