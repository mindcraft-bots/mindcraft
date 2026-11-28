import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { SCHEMATICS_DIR } from "../../../src/utils/schematic/paths.js";
import { readSchematic } from "../../../src/utils/schematic/reader.js";
import { createStateTransformer, transformSchematic } from "../../../src/utils/schematic/schematic_transform.js";

const require = createRequire(import.meta.url);
const { Schematic } = require("prismarine-schematic");
const Vec3 = require("vec3");
const data = require("minecraft-data")("26.1");

test("pack1 bee release fixture transforms in memory and rotates back exactly", async () => {
  const bytes = await readFile(`${SCHEMATICS_DIR}/schems/pack1/02_bee_hot_air_balloon.mc26.1.schem`);
  const copy = Buffer.from(bytes);
  const source = await readSchematic(bytes, "26.1", undefined, data);
  const codec = createStateTransformer({ version: "26.1", registry: data });
  const options = { codec, origin: { x: -20, y: 65, z: 40 } };
  const east = transformSchematic(source, { ...options, orientation: "east" });
  assert.deepEqual(east.size, { x: 9, y: 17, z: 10 });
  assert.equal(east.cells.length, 1530);
  assert.ok(east.cells.some((cell) => cell.name === "air"));
  assert.ok(east.cells.some((cell) => cell.name === "iron_chain"));
  const rotated = new Schematic("26.1", new Vec3(9, 17, 10), new Vec3(5, -2, 3), east.cells.map((cell) => cell.stateId), east.cells.map((_, i) => i));
  const restored = transformSchematic(rotated, { ...options, orientation: "west" });
  assert.deepEqual(restored.size, { x: 10, y: 17, z: 9 });
  assert.deepEqual(restored.cells.map((cell) => cell.stateId), source.blocks.map((index) => source.palette[index]));
  assert.deepEqual(bytes, copy);
});
