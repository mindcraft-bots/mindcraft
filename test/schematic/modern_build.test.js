import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { createModernBuild } from "../../src/utils/schematic/modern_build.js";

const require = createRequire(import.meta.url);
const { Schematic } = require("prismarine-schematic");
const Build = require("mineflayer-schem/lib/build.js");
const Vec3 = require("vec3");
const mcData = require("minecraft-data");

const VERSION = "1.20.4";
const Block = require("prismarine-block")(VERSION);
const registry = mcData(VERSION);

function stateId(name, properties = {}) {
  return Block.fromProperties(name, properties).stateId;
}

async function parsedSchematic(entries, size = new Vec3(entries.length, 1, 1)) {
  const palette = [];
  const blocks = entries.map((entry) => {
    const id = stateId(entry.name, entry.properties);
    let paletteIndex = palette.indexOf(id);
    if (paletteIndex < 0) {
      paletteIndex = palette.length;
      palette.push(id);
    }
    return paletteIndex;
  });
  const source = new Schematic(VERSION, size, new Vec3(0, 0, 0), palette, blocks);
  return Schematic.read(await source.write(), VERSION);
}

function bot() {
  return { version: VERSION, registry, builder: { build() {} } };
}

test("creates real mineflayer-schem Build actions from modern block states without legacy stone fallback", async () => {
  const schematic = await parsedSchematic([
    { name: "mangrove_planks" },
    { name: "oak_stairs", properties: { facing: "north", half: "top", shape: "straight", waterlogged: false } },
    { name: "air" },
  ]);
  const build = createModernBuild(schematic, bot(), new Vec3(10, 20, -4));

  assert.ok(build instanceof Build);
  assert.equal(build.actions.length, 2);
  assert.equal(build.actions[0].blockName, "mangrove_planks");
  assert.equal(build.getItemForState(build.actions[0].state).name, "mangrove_planks");
  assert.notEqual(build.getItemForState(build.actions[0].state).name, "stone");
  assert.deepEqual(build.dimensions, { width: 3, height: 1, length: 1 });
  assert.deepEqual(build.min, new Vec3(10, 20, -4));
  assert.deepEqual(build.max, new Vec3(13, 21, -3));
  assert.deepEqual(build.actions[1].pos, new Vec3(11, 20, -4));
  assert.equal(build.actions[1].metadata, 5);
  assert.deepEqual(build.actions[1].properties, schematic.getBlock(new Vec3(1, 0, 0)).getProperties());
  assert.deepEqual(build.plan.map(({ name, stateId }) => [name, stateId]), [
    ["mangrove_planks", stateId("mangrove_planks")],
    ["oak_stairs", stateId("oak_stairs", { facing: "north", half: "top", shape: "straight", waterlogged: false })],
  ]);
  assert.equal(Object.isFrozen(build.plan), true);
  assert.equal(Object.isFrozen(build.plan[0].position), true);
});

test("maps wall torches, wall signs, and redstone wire to actual inventory items", async () => {
  const schematic = await parsedSchematic([
    { name: "wall_torch", properties: { facing: "east" } },
    { name: "oak_wall_sign", properties: { facing: "north", waterlogged: false } },
    { name: "redstone_wire", properties: { east: "side", north: "side", power: 0, south: "side", west: "side" } },
  ]);
  const build = createModernBuild(schematic, bot(), new Vec3(0, 0, 0));

  assert.deepEqual(build.actions.map((action) => action.blockName), ["wall_torch", "oak_wall_sign", "redstone_wire"]);
  assert.deepEqual(build.actions.map((action) => build.getItemForState(action.state).name), ["torch", "oak_sign", "redstone"]);
});

test("retains dependent door and bed blocks in the verification plan but only places their base halves", async () => {
  const schematic = await parsedSchematic([
    { name: "oak_door", properties: { facing: "west", half: "lower", hinge: "left", open: false, powered: false } },
    { name: "oak_door", properties: { facing: "west", half: "upper", hinge: "left", open: false, powered: false } },
    { name: "red_bed", properties: { facing: "south", part: "foot", occupied: false } },
    { name: "red_bed", properties: { facing: "south", part: "head", occupied: false } },
    { name: "oak_trapdoor", properties: { facing: "east", half: "top", open: true, powered: false, waterlogged: false } },
  ]);
  const build = createModernBuild(schematic, bot(), new Vec3(4, 5, 6));

  assert.equal(build.plan.length, 5);
  assert.equal(build.actions.length, 3);
  assert.equal(build.actions[0].metadata, 2);
  assert.equal(build.actions[2].metadata, 15);
  assert.equal(build.skippedDependencies.length, 2);
  assert.equal(build.skippedDependencies[0].reason.includes("upper door"), true);
  assert.equal(build.skippedDependencies[1].reason.includes("bed head"), true);
});

test("reports unsupported states explicitly and attaches the inspectable adapter", async () => {
  const schematic = await parsedSchematic([{ name: "water", properties: { level: 0 } }]);

  assert.throws(() => createModernBuild(schematic, bot(), new Vec3(0, 0, 0)), (error) => {
    assert.match(error.message, /unsupported blocks.*water/i);
    assert.equal(error.unsupported.length, 1);
    assert.equal(error.build.unsupported[0].name, "water");
    assert.equal(error.build.plan[0].name, "water");
    return true;
  });
});

test("rejects invalid and oversized dimensions before decoding block data", () => {
  const oversized = new Schematic(VERSION, new Vec3(257, 1, 1), new Vec3(0, 0, 0), [0], []);
  assert.throws(() => createModernBuild(oversized, bot(), new Vec3(0, 0, 0)), /dimensions/i);

  const invalid = new Schematic(VERSION, new Vec3(1, 1, 1), new Vec3(0, 0, 0), [0], []);
  assert.throws(() => createModernBuild(invalid, bot(), new Vec3(0, 0, 0)), /palette\/blocks/i);
});
