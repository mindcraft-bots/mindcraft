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
  assert.deepEqual(build.cells.map(({ name }) => name), ["mangrove_planks", "oak_stairs", "air"]);
  assert.equal(build.cells[2].position.x, 12);
  assert.equal(Object.isFrozen(build.plan), true);
  assert.equal(Object.isFrozen(build.cells), true);
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

test("maps wall banners and cocoa to inventory items without changing requested states", async () => {
  const schematic = await parsedSchematic([
    { name: "white_wall_banner", properties: { facing: "east" } },
    { name: "red_wall_banner", properties: { facing: "west" } },
    { name: "cocoa", properties: { age: 2, facing: "north" } },
  ]);
  const build = createModernBuild(schematic, bot(), new Vec3(0, 0, 0));
  assert.deepEqual(build.actions.map(action => build.getItemForState(action.state).name), ["white_banner", "red_banner", "cocoa_beans"]);
  assert.deepEqual(build.plan.map(entry => entry.name), ["white_wall_banner", "red_wall_banner", "cocoa"]);
  assert.deepEqual(build.plan[2].properties, schematic.getBlock(new Vec3(2, 0, 0)).getProperties());
});

test("rejects multi-block door, bed, and plant placements before they can cross the schematic boundary", async () => {
  for (const entry of [
    { name: "oak_door", properties: { facing: "west", half: "lower", hinge: "left", open: false, powered: false } },
    { name: "red_bed", properties: { facing: "south", part: "foot", occupied: false } },
    { name: "sunflower", properties: { half: "lower" } },
    { name: "tall_grass", properties: { half: "lower" } },
    { name: "tall_seagrass", properties: { half: "lower", waterlogged: true } },
  ]) {
    const schematic = await parsedSchematic([entry]);
    assert.throws(() => createModernBuild(schematic, bot(), new Vec3(4, 5, 6)), (error) => {
      assert.match(error.message, /unsupported blocks.*(?:door|bed|plant).*second block half/i);
      assert.equal(error.unsupported[0].position.x, 4);
      assert.match(error.unsupported[0].reason, /full physics footprint cannot be safely proven in-volume/);
      return true;
    }, entry.name);
  }

  const safe = await parsedSchematic([
    { name: "oak_trapdoor", properties: { facing: "east", half: "top", open: true, powered: false, waterlogged: false } },
  ]);
  const safeBuild = createModernBuild(safe, bot(), new Vec3(4, 5, 6));
  assert.equal(safeBuild.actions.length, 1, "single-cell trapdoors remain supported");
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
