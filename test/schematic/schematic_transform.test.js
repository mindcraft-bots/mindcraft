import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createStateTransformer, transformSchematic } from "../../src/utils/schematic/schematic_transform.js";

const require = createRequire(import.meta.url);
const minecraftData = require("minecraft-data");
const Block = require("prismarine-block")("1.21.4");
const { Schematic } = require("prismarine-schematic");
const Vec3 = require("vec3");
const codec = createStateTransformer({ version: "1.21.4" });
const block = (name, properties) => Block.fromProperties(name, properties, 0);
const wrap = (state) => ({ ...state, getProperties: () => state.properties });
const turn = (state, orientation) => codec.transformState(state, orientation);

function assertExact(state) {
  const decoded = Block.fromStateId(state.stateId, 0);
  assert.equal(decoded.name, state.name);
  assert.deepEqual(decoded.getProperties(), state.properties);
}

function fixture() {
  const registry = minecraftData("1.21.4");
  const names = ["stone", "dirt", "air", "oak_planks", "glass", "gold_block", "oak_log", "cobblestone", "sand", "clay", "bricks", "diamond_block"];
  const palette = names.map((name) => registry.blocksByName[name].defaultState);
  return new Schematic("1.21.4", new Vec3(3, 2, 2), new Vec3(-7, 11, 19), palette, names.map((_, i) => i));
}

test("asymmetric corner table, offsets, minimum origin, air and x-fastest bijection", () => {
  const source = fixture();
  const originalGet = source.getBlock.bind(source);
  const calls = [];
  source.getBlock = (position) => { calls.push([position.x, position.y, position.z]); return originalGet(position); };
  const corners = { north: [[0, 0], [2, 0], [0, 1], [2, 1]], east: [[1, 0], [1, 2], [0, 0], [0, 2]], south: [[2, 1], [0, 1], [2, 0], [0, 0]], west: [[0, 2], [0, 0], [1, 2], [1, 0]] };
  for (const orientation of Object.keys(corners)) {
    calls.length = 0;
    const origin = { x: 37, y: -23, z: 91 };
    const result = transformSchematic(source, { orientation, origin, codec });
    const expectedSize = ["east", "west"].includes(orientation) ? { x: 2, y: 2, z: 3 } : { x: 3, y: 2, z: 2 };
    assert.deepEqual(result.size, expectedSize);
    assert.deepEqual(result.origin, origin);
    assert.deepEqual(calls[0], [-7, 11, 19]);
    assert.deepEqual(calls.at(-1), [-5, 12, 20]);
    assert.equal(new Set(calls.map(String)).size, 12);
    assert.equal(result.cells.length, 12);
    for (const [i, sourceIndex] of [0, 2, 3, 5].entries()) {
      const [x, z] = corners[orientation][i];
      const target = result.cells[z * expectedSize.x + x];
      assert.equal(target.stateId, source.palette[sourceIndex]);
      assert.deepEqual(target.position, { x: origin.x + x, y: origin.y, z: origin.z + z });
    }
    assert.equal(result.cells.filter((cell) => cell.name === "air").length, 1);
    assert.equal(new Set(result.cells.map((cell) => JSON.stringify(cell.position))).size, 12);
    for (const [i, cell] of result.cells.entries()) {
      assert.equal(cell.index, i);
      assert.deepEqual(cell.position, { x: origin.x + i % expectedSize.x, y: origin.y + Math.floor(i / (expectedSize.x * expectedSize.z)), z: origin.z + Math.floor(i / expectedSize.x) % expectedSize.z });
      assertExact(cell);
    }
  }
});

test("volume four-turn identity and rotation inverses retain every state", () => {
  const original = fixture();
  const states = original.blocks.map((index) => original.palette[index]);
  const origin = { x: 5, y: 10, z: -8 };
  const convert = (result) => new Schematic("1.21.4", new Vec3(result.size.x, result.size.y, result.size.z), new Vec3(-3, 2, 9), result.cells.map((cell) => cell.stateId), result.cells.map((_, i) => i));
  const run = (source, orientation) => transformSchematic(source, { codec, origin, orientation });
  let current = original;
  for (let i = 0; i < 4; i++) current = convert(run(current, "east"));
  assert.deepEqual(current.size, original.size);
  assert.deepEqual(current.palette, states);
  for (const [forward, inverse] of [["north", "north"], ["east", "west"], ["south", "south"], ["west", "east"]]) {
    const result = run(convert(run(original, forward)), inverse);
    assert.deepEqual(result.size, { x: 3, y: 2, z: 2 });
    assert.deepEqual(result.cells.map((cell) => cell.stateId), states);
  }
});

test("stairs, trapdoors, doors, axes, vertical facing and 16-step rotation preserve typed invariants", () => {
  const stairs = block("oak_stairs", { facing: "north", half: "top", shape: "inner_left", waterlogged: true });
  assert.deepEqual(turn(stairs, "east").properties, { facing: "east", half: "top", shape: "inner_left", waterlogged: true });
  const stairs2 = block("oak_stairs", { facing: "west", half: "bottom", shape: "outer_right", waterlogged: false });
  assert.equal(turn(stairs2, "south").properties.shape, "outer_right");
  const trapdoor = block("oak_trapdoor", { facing: "west", half: "top", open: true, powered: false, waterlogged: true });
  assert.deepEqual(turn(trapdoor, "east").properties, { facing: "north", half: "top", open: true, powered: false, waterlogged: true });
  for (const half of ["upper", "lower"]) for (const hinge of ["left", "right"]) for (const open of [true, false]) {
    const door = block("oak_door", { facing: "south", half, hinge, open, powered: true });
    const rotated = turn(door, "east");
    assert.deepEqual(rotated.properties, { facing: "west", half, hinge, open, powered: true });
    assertExact(rotated);
  }
  assert.equal(turn(block("oak_log", { axis: "x" }), "east").properties.axis, "z");
  assert.equal(turn(block("oak_log", { axis: "y" }), "west").properties.axis, "y");
  assert.equal(turn(block("dispenser", { facing: "up", triggered: false }), "east").properties.facing, "up");
  for (let i = 0; i < 16; i++) {
    const sign = block("oak_sign", { rotation: String(i), waterlogged: true });
    const rotated = turn(sign, "east");
    assert.equal(rotated.properties.rotation, String((i + 4) % 16));
    assert.equal(rotated.properties.waterlogged, true);
    assertExact(rotated);
  }
});

test("rail shapes, cardinal keys, and compound jigsaw/crafter orientations rotate simultaneously", () => {
  const railTurns = { north_south: "east_west", east_west: "north_south", ascending_north: "ascending_east", ascending_east: "ascending_south", ascending_south: "ascending_west", ascending_west: "ascending_north", south_east: "south_west", south_west: "north_west", north_west: "north_east", north_east: "south_east" };
  for (const [shape, expected] of Object.entries(railTurns)) {
    const rotated = turn(block("rail", { shape, waterlogged: true }), "east");
    assert.equal(rotated.properties.shape, expected);
    assertExact(rotated);
  }
  const wire = block("redstone_wire", { north: "up", east: "side", south: "none", west: "side", power: "7" });
  assert.deepEqual(turn(wire, "east").properties, { north: "side", east: "up", south: "side", west: "none", power: "7" });
  for (const name of ["jigsaw", "crafter"]) {
    for (const [input, expected] of [["down_north", "down_east"], ["up_west", "up_north"], ["south_up", "west_up"]]) {
      const props = name === "crafter" ? { orientation: input, crafting: false, triggered: false } : { orientation: input };
      const rotated = turn(block(name, props), "east");
      assert.equal(rotated.properties.orientation, expected);
      assertExact(rotated);
    }
  }
});

test("four turns and rotate-inverse preserve exact IDs and properties", () => {
  const fixtures = [block("oak_stairs", { facing: "east", half: "top", shape: "outer_left", waterlogged: true }), block("oak_door", { facing: "west", half: "upper", hinge: "right", open: true, powered: false }), block("oak_sign", { rotation: "15", waterlogged: false }), block("rail", { shape: "north_east", waterlogged: false }), block("redstone_wire", { north: "up", east: "none", south: "side", west: "up", power: "8" }), block("jigsaw", { orientation: "down_west" })];
  for (const initial of fixtures) {
    let current = initial;
    for (let i = 0; i < 4; i++) current = wrap(turn(current, "east"));
    assert.equal(current.stateId, initial.stateId);
    assert.deepEqual(current.getProperties(), initial.getProperties());
    for (const [forward, reverse] of [["north", "north"], ["east", "west"], ["south", "south"], ["west", "east"]]) {
      const result = turn(wrap(turn(initial, forward)), reverse);
      assert.equal(result.stateId, initial.stateId);
      assert.deepEqual(result.properties, initial.getProperties());
    }
  }
});

test("exact version registries and current releases use their own IDs", () => {
  for (const version of ["1.20.4", "1.21.4", "26.1"]) {
    const data = minecraftData(version);
    const B = require("prismarine-block")(version);
    const c = createStateTransformer({ version, registry: data });
    const input = B.fromProperties("oak_door", { facing: "north", half: "upper", hinge: "left", open: true, powered: false }, 0);
    const result = c.transformState(input, "east");
    const decoded = B.fromStateId(result.stateId, 0);
    assert.equal(decoded.name, "oak_door");
    assert.deepEqual(decoded.getProperties(), result.properties);
    assert.equal(result.properties.facing, "east");
    assert.equal(c.dataVersion, data.version.dataVersion);
  }
  assert.notEqual(minecraftData("1.20.4").blocksByName.oak_door.defaultState, minecraftData("1.21.4").blocksByName.oak_door.defaultState);
});

test("rejects mismatches, unreadable, unclassified and invalid states", () => {
  const data = minecraftData("1.21.4");
  assert.throws(() => createStateTransformer({ version: "1.8" }), /exact modern/);
  assert.throws(() => createStateTransformer({ version: "1.12.2" }), /exact modern/);
  assert.throws(() => createStateTransformer({ version: "1.21.999" }), /exact modern/);
  assert.throws(() => createStateTransformer({ version: "1.21.4", registry: { ...data, blocksByName: { ...data.blocksByName } } }), /identity/);
  assert.throws(() => createStateTransformer({ version: "1.21.4", registry: minecraftData("1.20.4") }), /identity/);
  const original = block("oak_stairs", { facing: "north", half: "top", shape: "inner_left", waterlogged: true });
  const properties = original.getProperties();
  assert.throws(() => turn({ name: "unknown_block", stateId: 0, getProperties: () => ({}) }, "east"), /Unknown/);
  assert.throws(() => turn({ name: original.name, stateId: original.stateId + 1, getProperties: () => properties }, "east"), /mismatch/);
  assert.throws(() => turn({ name: original.name, stateId: original.stateId, getProperties: () => ({ ...properties, waterlogged: "true" }) }, "east"), /mismatch/);
  assert.throws(() => turn({ name: original.name, stateId: original.stateId, getProperties: () => ({ ...properties, extra: 1 }) }, "east"), /mismatch/);
  assert.throws(() => turn({ name: original.name, stateId: original.stateId, getProperties: () => { throw new Error("unreadable"); } }, "east"), /unreadable/);
  assert.throws(() => turn(original, "northeast"), /orientation/);
  const modern = createStateTransformer({ version: "26.1" });
  const B = require("prismarine-block")("26.1");
  assert.throws(() => modern.transformState(B.fromStateId(minecraftData("26.1").blocksByName.copper_golem_statue.defaultState, 0), "north"), /Unclassified property copper_golem_pose/);
});

test("rejects a missing target registry state even after the index is cached", () => {
  const data = minecraftData("1.21.4");
  const input = block("oak_stairs", { facing: "north", half: "top", shape: "inner_left", waterlogged: true });
  const target = turn(input, "east").stateId;
  const saved = data.blocksByStateId[target];
  try {
    delete data.blocksByStateId[target];
    assert.throws(() => turn(input, "east"), /absent from registry/);
  } finally {
    data.blocksByStateId[target] = saved;
  }
});

test("rejects malformed volume, offsets, palette, decoded state and coordinate overflows", () => {
  const options = { orientation: "east", origin: { x: 0, y: 0, z: 0 }, codec };
  for (const [change, pattern] of [
    [{ size: new Vec3(0, 1, 1) }, /size/],
    [{ size: new Vec3(Number.MAX_SAFE_INTEGER, 2, 2) }, /volume/],
    [{ offset: new Vec3(Number.MAX_SAFE_INTEGER, 0, 0) }, /bounds/],
    [{ blocks: [0] }, /block data/],
    [{ blocks: Array(12).fill(999) }, /palette index/],
    [{ palette: [-1] , blocks: Array(12).fill(0) }, /source state/],
    [{ getBlock: () => Block.fromStateId(0, 0) }, /mismatch/],
    [{ version: "1.20.4" }, /version mismatch/],
  ]) assert.throws(() => transformSchematic(Object.assign(fixture(), change), options), pattern);
  assert.throws(() => transformSchematic(fixture(), { ...options, origin: { x: Number.MAX_SAFE_INTEGER, y: 0, z: 0 } }), /bounds/);
  assert.throws(() => transformSchematic(fixture(), { ...options, orientation: "up" }), /orientation/);
  assert.throws(() => transformSchematic(fixture(), { ...options, codec: { version: "1.21.4", transformState: () => ({}) } }), /unverified codec/);
});

test("interleaved high-state blocks are indexed once per schematic while every cell is checked", () => {
  const data = minecraftData("1.21.4");
  const names = Object.values(data.blocksByName).filter((definition) => definition.name.endsWith("_stairs") && definition.maxStateId - definition.minStateId + 1 === 80).slice(0, 17).map((definition) => definition.name);
  assert.equal(names.length, 17);
  const palette = names.flatMap((name) => [
    block(name, { facing: "north", half: "top", shape: "inner_left", waterlogged: true }).stateId,
    block(name, { facing: "west", half: "bottom", shape: "outer_right", waterlogged: false }).stateId,
  ]);
  const blocks = Array.from({ length: 680 }, (_, i) => 2 * (i % 17) + (Math.floor(i / 17) % 2));
  const source = new Schematic("1.21.4", new Vec3(17, 2, 20), new Vec3(-4, 3, 7), palette, blocks);
  const originalGet = source.getBlock.bind(source);
  let observations = 0;
  source.getBlock = (position) => {
    const decoded = originalGet(position);
    return { name: decoded.name, stateId: decoded.stateId, getProperties: () => { observations++; return decoded.getProperties(); } };
  };
  const maps = names.map((name) => data.blocksByName[name].states);
  let indexed = 0;
  try {
    for (const states of maps) Object.defineProperty(states, "map", { configurable: true, value(...args) { indexed++; return Array.prototype.map.apply(this, args); } });
    const localCodec = createStateTransformer({ version: "1.21.4", registry: data });
    const origin = { x: 11, y: -2, z: 30 };
    const result = transformSchematic(source, { codec: localCodec, orientation: "east", origin });
    assert.equal(indexed, 17 * 80);
    assert.equal(observations, 680);
    assert.deepEqual(result.size, { x: 20, y: 2, z: 17 });
    for (let i = 0; i < blocks.length; i++) {
      const x = i % 17, z = Math.floor(i / 17) % 20, y = Math.floor(i / 340);
      const dx = 19 - z, dz = x;
      const cell = result.cells[(y * 17 + dz) * 20 + dx];
      const name = names[i % 17];
      const second = Math.floor(i / 17) % 2;
      const expected = block(name, second
        ? { facing: "north", half: "bottom", shape: "outer_right", waterlogged: false }
        : { facing: "east", half: "top", shape: "inner_left", waterlogged: true });
      assert.equal(cell.stateId, expected.stateId);
      assert.deepEqual(cell.properties, expected.getProperties());
      assert.deepEqual(cell.position, { x: origin.x + dx, y: origin.y + y, z: origin.z + dz });
    }
    // A new invocation has its own bounded session; global LRU eviction must not
    // cause reindexing within that invocation either.
    indexed = 0;
    transformSchematic(source, { codec: localCodec, orientation: "west", origin });
    assert.equal(indexed, 17 * 80);
    assert.equal(observations, 1360);
  } finally {
    for (const states of maps) delete states.map;
  }
});

test("repeated IDs cannot conceal conflicting or unreadable cell observations", () => {
  const input = block("oak_stairs", { facing: "north", half: "top", shape: "inner_left", waterlogged: true });
  const options = { codec: createStateTransformer({ version: "1.21.4" }), orientation: "east", origin: { x: 0, y: 0, z: 0 } };
  const makeSource = (bad) => ({
    version: "1.21.4", size: { x: 2, y: 1, z: 1 }, palette: [input.stateId], blocks: [0, 0],
    getBlock: ({ x }) => x === 0 ? input : bad,
  });
  const properties = input.getProperties();
  for (const [bad, pattern] of [
    [{ name: "dirt", stateId: input.stateId, getProperties: () => ({}) }, /mismatch/],
    [{ name: input.name, stateId: input.stateId, getProperties: () => ({ ...properties, waterlogged: "true" }) }, /mismatch/],
    [{ name: input.name, stateId: input.stateId, getProperties: () => ({ ...properties, extra: 1 }) }, /mismatch/],
    [{ name: input.name, stateId: input.stateId, getProperties: () => { throw new Error("unreadable observation"); } }, /unreadable observation/],
    [{ name: input.name, stateId: input.stateId, getProperties: () => Object.defineProperty({ ...properties }, "hidden", { value: 1 }) }, /readable data fields/],
    [{ name: input.name, stateId: input.stateId + 1, getProperties: () => properties }, /Decoded source state mismatch/],
  ]) assert.throws(() => transformSchematic(makeSource(bad), options), pattern);
});

test("schematic sessions reject registry mutations and excessive palettes", () => {
  const data = minecraftData("1.21.4");
  const input = block("oak_stairs", { facing: "north", half: "top", shape: "inner_left", waterlogged: true });
  const localCodec = createStateTransformer({ version: "1.21.4", registry: data });
  const options = { codec: localCodec, orientation: "east", origin: { x: 0, y: 0, z: 0 } };
  const target = localCodec.transformState(input, "east").stateId;
  const definition = data.blocksByName[input.name];
  const originalTarget = data.blocksByStateId[target];
  const originalNames = data.blocksByName;
  const source = { version: "1.21.4", size: { x: 2, y: 1, z: 1 }, palette: [input.stateId], blocks: [0, 0], getBlock: () => input };
  assert.throws(() => transformSchematic({ ...source, palette: { length: 65_537 } }, options), /excessive palette/);
  assert.throws(() => transformSchematic({ ...source, palette: { length: Infinity } }, options), /palette/);
  for (const change of [
    (candidate) => { candidate.palette.length = 65_537; },
    (candidate) => { candidate.palette[0] = input.stateId + 1; },
    (candidate) => { candidate.palette = [input.stateId]; },
  ]) {
    const candidate = { ...source, palette: [input.stateId] };
    candidate.getBlock = () => { change(candidate); return input; };
    assert.throws(() => transformSchematic(candidate, options), /palette changed/);
  }
  const changingProperties = { ...source, palette: [input.stateId] };
  changingProperties.getBlock = () => ({ name: input.name, stateId: input.stateId, getProperties: () => { changingProperties.palette.length = 65_537; return input.getProperties(); } });
  assert.throws(() => transformSchematic(changingProperties, options), /palette changed/);
  try {
    source.getBlock = ({ x }) => { if (x === 1) definition.states[0].name = "changed"; return input; };
    assert.throws(() => transformSchematic(source, options), /Registry changed/);
  } finally { definition.states[0].name = "facing"; }
  try {
    source.getBlock = ({ x }) => { if (x === 1) delete data.blocksByStateId[target]; return input; };
    assert.throws(() => transformSchematic(source, options), /absent from registry/);
  } finally { data.blocksByStateId[target] = originalTarget; }
  try {
    source.getBlock = ({ x }) => { if (x === 1) delete data.blocksByStateId[input.stateId]; return input; };
    assert.throws(() => transformSchematic(source, options), /ID\/properties mismatch/);
  } finally { data.blocksByStateId[input.stateId] = definition; }
  try {
    source.getBlock = ({ x }) => { if (x === 1) data.blocksByName = { ...originalNames }; return input; };
    assert.throws(() => transformSchematic(source, options), /Registry identity mismatch/);
  } finally { data.blocksByName = originalNames; }
});

test("schematic index budget fails closed at the distinct block limit", () => {
  const data = minecraftData("1.21.4");
  const definitions = Object.values(data.blocksByName).slice(0, 1025);
  assert.equal(definitions.length, 1025);
  const palette = definitions.map((definition) => definition.defaultState);
  const makeSource = (length) => new Schematic("1.21.4", new Vec3(length, 1, 1), new Vec3(0, 0, 0), palette, Array.from({ length }, (_, i) => i));
  const options = { codec: createStateTransformer({ version: "1.21.4" }), orientation: "north", origin: { x: 0, y: 0, z: 0 } };
  assert.equal(transformSchematic(makeSource(1024), options).cells.length, 1024);
  assert.throws(() => transformSchematic(makeSource(1025), options), /Excessive schematic registry indexing/);
});
