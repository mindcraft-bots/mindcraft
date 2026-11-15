import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { readSchematic, validateSchematicSource } from "../../src/utils/schematic/reader.js";

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

test("reads a real serialized Sponge v2 buffer through prismarine-schematic", async () => {
  const source = serializedSponge({
    "minecraft:stone": 0,
    "minecraft:oak_log[axis=y]": 1,
  }, [0, 1]);
  const schematic = await readSchematic(source, "1.20.4");

  assert.deepEqual([schematic.size.x, schematic.size.y, schematic.size.z], [2, 1, 1]);
  assert.equal(schematic.getBlock(new Vec3(0, 0, 0)).name, "stone");
  const log = schematic.getBlock(new Vec3(1, 0, 0));
  assert.equal(log.name, "oak_log");
  assert.deepEqual(log.getProperties(), { axis: "y" });
});

test("rejects unknown names and invalid properties or states from real Sponge palettes", async () => {
  const unsupportedCases = [
    ["minecraft:future_block", /unsupported block.*future_block/i],
    ["minecraft:stone[waterlogged=true]", /unsupported property.*waterlogged/i],
    ["minecraft:oak_log[axis=vertical]", /invalid property\/state.*axis=vertical/i],
  ];
  for (const [entry, expectedError] of unsupportedCases) {
    const source = serializedSponge({ "minecraft:stone": 0, [entry]: 1 }, [0, 1]);
    await assert.rejects(readSchematic(source, "1.20.4"), expectedError);
  }

  const mixed = serializedSponge({
    "minecraft:stone": 0,
    "minecraft:future_block": 1,
  }, [0, 1]);
  await assert.rejects(validateSchematicSource(mixed, "1.20.4"), /minecraft:future_block/);
});

test("parses a real legacy .schematic fixture and rejects unmapped legacy IDs", async () => {
  const oldFixture = serializedLegacy(1, 0);
  await validateSchematicSource(oldFixture, "1.20.4");
  const schematic = await Schematic.read(oldFixture, "1.20.4");
  assert.equal(schematic.getBlock(new Vec3(0, 0, 0)).name, "stone");

  // 4095 has no legacy mapping; without preflight the upstream parser substitutes stone.
  const unknownId = serializedLegacy(255, 0, [0xf0]);
  await assert.rejects(readSchematic(unknownId, "1.20.4"), /unknown block ID\/data 4095:0.*implicit stone fallback/i);
});
