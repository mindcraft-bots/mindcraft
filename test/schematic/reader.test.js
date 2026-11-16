import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { readSchematic, validateSchematicSource } from "../../src/utils/schematic/reader.js";
import { createModernBuild } from "../../src/utils/schematic/modern_build.js";

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

test("preserves every candle count, foliage distance and snow layer through production reading and placement planning", async () => {
  for (const version of ["1.20.4", "1.21.4"]) {
    const registry = require("minecraft-data")(version);
    const Block = require("prismarine-block")(version);
    const entries = [];
    for (const name of ["candle", "pink_candle", "oak_leaves", "spruce_leaves", "flowering_azalea_leaves", "snow"]) {
      const definition = registry.blocksByName[name];
      const integer = definition.states.find((state) => state.type === "int");
      for (const value of integer.values) {
        const properties = name.endsWith("leaves")
          ? { distance: value, persistent: "true", waterlogged: "false" }
          : name === "snow"
            ? { layers: value }
            : { candles: value, lit: "false", waterlogged: "false" };
        const raw = `minecraft:${name}[${Object.entries(properties).map(([key, entry]) => `${key}=${entry}`).join(",")}]`;
        entries.push({ name, raw, expected: Block.fromProperties(definition.id, properties) });
      }
    }
    const indices = entries.map((_, index) => index);
    const source = serializedSponge(Object.fromEntries(entries.map(({ raw }, index) => [raw, index])), indices);
    const schematic = await readSchematic(source, version);
    // buildSchematic also supports calling Schematic.read directly after source validation.
    const direct = await Schematic.read(source, version);
    assert.deepEqual(direct.palette, schematic.palette);
    assert.deepEqual(schematic.blocks, indices, "palette indices must not change");
    const build = createModernBuild(schematic, { version, registry }, new Vec3(10, 20, 30));
    for (const [index, { name, raw, expected }] of entries.entries()) {
      const actual = schematic.getBlock(new Vec3(index, 0, 0));
      assert.equal(actual.name, name, `${version} ${raw}`);
      assert.equal(actual.stateId, expected.stateId, `${version} ${raw}`);
      assert.deepEqual(actual.getProperties(), expected.getProperties(), `${version} ${raw}`);
      assert.equal(build.getItemForState(index).name, name, `placement item for ${raw}`);
      assert.equal(build.actions[index].stateId, expected.stateId);
      assert.deepEqual(build.actions[index].properties, expected.getProperties());
      assert.deepEqual(build.plan[index].properties, expected.getProperties());
    }
  }
});

test("integer state encoding uses declared order while preserving old numeric, enum and boolean behavior", () => {
  const { getStateId } = require("prismarine-schematic/lib/states");
  const registry = (state) => ({ blocksByName: { example: { minStateId: 100, states: [state] } } });
  const state = { name: "value", type: "int", num_values: 3, values: ["5", "1", "9"] };
  for (const [index, value] of state.values.entries()) {
    assert.equal(getStateId(registry(state), "example", [["value", value]]), 100 + index);
  }
  assert.equal(getStateId(registry({ name: "value", type: "int", num_values: 4 }), "example", [["value", "3"]]), 103);
  assert.equal(getStateId(registry({ name: "value", type: "enum", num_values: 2, values: ["x", "z"] }), "example", [["value", "z"]]), 101);
  for (const [value, index] of [["true", 0], ["false", 1]]) {
    assert.equal(getStateId(registry({ name: "value", type: "bool", num_values: 2 }), "example", [["value", value]]), 100 + index);
  }
});

test("zero-based integer states and omitted properties retain their existing interpretation", async () => {
  const source = serializedSponge({
    "minecraft:wheat[age=0]": 0,
    "minecraft:wheat[age=7]": 1,
    "minecraft:oak_log[axis=z]": 2,
    "minecraft:oak_leaves": 3,
  }, [0, 1, 2, 3]);
  const schematic = await readSchematic(source, "1.21.4");
  assert.equal(String(schematic.getBlock(new Vec3(0, 0, 0)).getProperties().age), "0");
  assert.equal(String(schematic.getBlock(new Vec3(1, 0, 0)).getProperties().age), "7");
  assert.equal(schematic.getBlock(new Vec3(2, 0, 0)).getProperties().axis, "z");
  const registry = require("minecraft-data")("1.21.4");
  assert.equal(schematic.palette[3], registry.blocksByName.oak_leaves.minStateId);
});

test("legacy snow mapping also preserves its one-based layer value", async () => {
  const schematic = await readSchematic(serializedLegacy(78, 0), "1.21.4");
  const snow = schematic.getBlock(new Vec3(0, 0, 0));
  assert.equal(snow.name, "snow");
  assert.equal(String(snow.getProperties().layers), "1");
});
