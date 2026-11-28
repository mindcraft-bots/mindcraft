import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers";
import { analyzeContinuation, analyzeContinuationAsync } from "../../src/utils/schematic/continuation_analysis.js";
import { copyStateProperties } from "../../src/utils/schematic/trusted_block_state.js";
import { createStateTransformer, transformSchematic } from "../../src/utils/schematic/schematic_transform.js";

const require = createRequire(import.meta.url);
const minecraftData = require("minecraft-data");
const registry = minecraftData("1.21.4");
const Block = require("prismarine-block")("1.21.4");
const { Schematic } = require("prismarine-schematic");
const Vec3 = require("vec3");
const runtime = (name, properties = {}) => Block.fromProperties(name, properties, 0);
const stone = runtime("stone"), air = runtime("air"), cave = runtime("cave_air"), logX = runtime("oak_log", { axis: "x" }), logZ = runtime("oak_log", { axis: "z" });
const props = block => ({ ...block._properties });
const data = block => ({ name: block.name, stateId: block.stateId, properties: props(block) });
const cell = (x, block) => ({ position: { x, y: 64, z: -3 }, ...data(block) });
const plan = cells => ({ dimensions: { width: cells.length, height: 1, length: 1 }, cells });
const bot = read => ({ version: "1.21.4", registry, blockAt: read });

test("asynchronous analysis yields and observes cancellation before completing a large volume", async () => {
  let cancelled = false, reads = 0;
  const cells = Array.from({ length: 512 }, (_, x) => cell(x, stone));
  await assert.rejects(analyzeContinuationAsync(bot(() => {
    if (++reads === 1) setImmediate(() => { cancelled = true; });
    return air;
  }), plan(cells), Vec3, () => { if (cancelled) throw new Error("cancelled"); }), /cancelled/);
  assert.ok(reads >= 128 && reads < cells.length);
  cancelled = false; reads = 0;
  setImmediate(() => { cancelled = true; });
  await assert.rejects(analyzeContinuationAsync(bot(() => { reads++; return air; }), plan(cells), Vec3,
    () => { if (cancelled) throw new Error("cancelled"); }), /cancelled/);
  assert.equal(reads, 0);
});

test("classifies the complete volume including conflicts, entities and unavailable cells", () => {
  const chest = runtime("chest");
  const cells = [stone, stone, air, logX, air, stone, chest].map((value, i) => cell(i + 10, value));
  const blocks = [stone, air, cave, logZ, stone, null, { ...data(chest), blockEntity: {} }];
  const visited = [];
  const result = analyzeContinuation(bot(p => { visited.push([p.x, p.y, p.z]); return blocks[p.x - 10]; }), plan(cells), Vec3);
  assert.deepEqual(result.counts, { exact: 1, missing: 1, air: 1, conflicts: 3, unloaded: 1, blockEntities: 1 });
  assert.deepEqual(result.cells.map(c => c.category), ["exact", "missing", "air", "conflicts", "conflicts", "unloaded", "conflicts"]);
  assert.equal(visited.length, cells.length);
  assert.deepEqual(visited[0], [10, 64, -3]);
});

test("inconsistent observed states and exceptional reads are unavailable", () => {
  const cells = [cell(0, logX), cell(1, stone), cell(2, stone), cell(3, stone)];
  const blocks = [{ ...data(logX), properties: { axis: "x", extra: true } }, { ...data(stone), stateId: air.stateId },
    { ...data(stone), getProperties() { throw Error("must not execute"); } }];
  const result = analyzeContinuation(bot(p => { if (p.x === 3) throw Error("unloaded"); return blocks[p.x]; }), plan(cells), Vec3);
  assert.equal(result.counts.unloaded, 4);
});

test("rejects malformed plans and missing state data without mutating observations", () => {
  const observed = data(stone), world = bot(() => observed);
  assert.throws(() => analyzeContinuation(world, { dimensions: { width: 2, height: 1, length: 1 }, cells: [cell(0, stone)] }, Vec3), /complete|every cell/i);
  for (const value of [undefined, null]) {
    const bad = cell(0, stone); bad.properties = value;
    assert.throws(() => analyzeContinuation(world, plan([bad]), Vec3), /properties/i);
  }
  const badId = cell(0, stone); badId.stateId = undefined;
  assert.throws(() => analyzeContinuation(world, plan([badId]), Vec3), /state IDs/i);
  const result = analyzeContinuation(world, plan([cell(0, stone)]), Vec3);
  result.cells[0].properties.changed = true;
  assert.deepEqual(observed.properties, {});
  assert.equal(analyzeContinuation(bot(() => ({ name: stone.name, stateId: stone.stateId })), plan([cell(0, stone)]), Vec3).counts.unloaded, 1);
  assert.equal(analyzeContinuation(bot(() => ({ name: "chest", stateId: 4, blockEntity: {} })), plan([cell(0, stone)]), Vec3).counts.conflicts, 1);
  assert.equal(analyzeContinuation(bot(() => ({ ...data(air), blockEntity: false })), plan([cell(0, stone)]), Vec3).counts.conflicts, 1);
});

test("rejects invalid ID, name and property combinations on expected and observed sides", () => {
  const invalidIds = [-1, undefined, null, "0", 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 999999999];
  for (const block of [air, stone, logX]) for (const id of invalidIds) {
    const expected = cell(0, block); expected.stateId = id;
    assert.throws(() => analyzeContinuation(bot(() => block), plan([expected]), Vec3), /state IDs/i);
    const observed = { ...data(block), stateId: id };
    assert.equal(analyzeContinuation(bot(() => observed), plan([cell(0, stone)]), Vec3).cells[0].category, "unloaded");
  }
  for (const invalid of [
    { ...data(air), stateId: stone.stateId }, { ...data(stone), name: "air" },
    { ...data(logX), properties: { axis: "z" } }, { ...data(logX), properties: { axis: "x", extra: true } },
    { ...data(air), properties: { waterlogged: true } }, { ...data(stone), name: "minecraft:stone" },
  ]) {
    assert.throws(() => analyzeContinuation(bot(() => stone), plan([{ position: { x: 0, y: 64, z: -3 }, ...invalid }]), Vec3), /names, state IDs and properties/);
    assert.equal(analyzeContinuation(bot(() => invalid), plan([cell(0, stone)]), Vec3).cells[0].category, "unloaded");
  }
  for (const name of ["", "minecraft:air", "AIR", "air ", null]) {
    assert.equal(analyzeContinuation(bot(() => ({ ...data(air), name })), plan([cell(0, stone)]), Vec3).cells[0].category, "unloaded");
  }
});

test("property records reject nested, unsafe, accessor and non-data values", () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, "axis", { enumerable: true, get() { calls++; return "x"; } });
  const hidden = Object.defineProperty({}, "axis", { value: "x" });
  const nested = { nested: { flag: true } };
  for (const properties of [nested, { nested: [] }, { axis: null }, { axis: undefined }, { axis: 1n },
    { axis: Symbol("x") }, { axis: NaN }, { axis: Infinity }, { axis: 0.5 }, accessor, hidden,
    { [Symbol("x")]: "x" }, Object.create({ axis: "x" }), [], new Date(), new Proxy({}, {})]) {
    const bad = { ...cell(0, stone), properties };
    assert.throws(() => analyzeContinuation(bot(() => stone), plan([bad]), Vec3), /properties/i);
    assert.equal(analyzeContinuation(bot(() => ({ ...data(stone), properties })), plan([cell(0, stone)]), Vec3).cells[0].category, "unloaded");
  }
  assert.equal(calls, 0);
  assert.deepEqual(nested, { nested: { flag: true } });
  const special = Object.fromEntries([["__proto__", "safe"], ["constructor", false]]);
  const copied = copyStateProperties(special);
  assert.equal(Object.getPrototypeOf(copied), Object.prototype);
  assert.equal(Object.hasOwn(copied, "__proto__"), true);
  copied.__proto__ = "changed";
  assert.equal(special.__proto__, "safe");
});

test("hostile getters and nested aliases are never invoked on clones or originals", async () => {
  for (const shape of ["prismarine", "fallback"]) {
    const shared = { nested: { touched: false } }, actual = shape === "prismarine" ? runtime("air") : data(air);
    actual.alias = shared;
    let calls = 0;
    actual.getProperties = function () { calls++; this.alias.nested.touched = true; return {}; };
    for (const analyze of [analyzeContinuation, analyzeContinuationAsync]) {
      const result = await analyze(bot(() => actual), plan([cell(0, stone)]), Vec3);
      assert.equal(result.cells[0].category, "unloaded");
    }
    assert.equal(calls, 0);
    assert.deepEqual(shared, { nested: { touched: false } });
  }
  let calls = 0;
  const actual = data(air);
  Object.defineProperty(actual, "name", { get() { calls++; return "air"; } });
  assert.equal(analyzeContinuation(bot(() => actual), plan([cell(0, stone)]), Vec3).cells[0].category, "unloaded");
  assert.equal(calls, 0);
  const entityAccessor = data(air);
  Object.defineProperty(entityAccessor, "blockEntity", { get() { calls++; return null; } });
  assert.equal(analyzeContinuation(bot(() => entityAccessor), plan([cell(0, stone)]), Vec3).cells[0].category, "unloaded");
  assert.equal(calls, 0);
});

test("inherited entity data, accessors and proxy prototypes are unavailable without invoking traps", async () => {
  let calls = 0;
  const candidates = [];
  for (const key of ["entity", "blockEntity", "_blockEntity", "nbt"]) {
    for (const descriptor of [
      { value: { id: "attached" } },
      { value: null },
      { get() { calls++; throw new Error("unsafe getter"); } },
    ]) {
      const prototype = { getProperties: Block.prototype.getProperties };
      Object.defineProperty(prototype, key, descriptor);
      // Own null entity data must not be treated as proof that a prototype is safe.
      const candidate = Object.assign(Object.create(prototype), {
        name: air.name, stateId: air.stateId, _properties: {}, computedStates: {},
      });
      Object.defineProperty(candidate, "entity", { value: undefined, configurable: true });
      candidates.push(candidate);
    }
  }
  const deep = Object.create({ nbt: {} });
  deep.getProperties = Block.prototype.getProperties;
  candidates.push(Object.assign(Object.create(deep), { name: air.name, stateId: air.stateId, _properties: {}, computedStates: {} }));
  const hostilePrototype = new Proxy({}, { getPrototypeOf() { calls++; throw Error("trap"); }, getOwnPropertyDescriptor() { calls++; throw Error("trap"); } });
  candidates.push(Object.assign(Object.create(hostilePrototype), { name: air.name, stateId: air.stateId, properties: {} }));
  candidates.push(new Proxy(data(air), { getOwnPropertyDescriptor() { calls++; throw Error("trap"); } }));
  const revoked = Proxy.revocable({}, {}); revoked.revoke(); candidates.push(revoked.proxy);
  for (const actual of candidates) {
    for (const analyze of [analyzeContinuation, analyzeContinuationAsync]) {
      const result = await analyze(bot(() => actual), plan([cell(0, stone)]), Vec3);
      assert.equal(result.cells[0].category, "unloaded");
      assert.equal(result.counts.missing, 0);
    }
  }
  assert.equal(calls, 0);
});

test("real chunk observations distinguish absent and present entity data without mutation", () => {
  const Chunk = require("prismarine-chunk")("1.21.4"), chunk = new Chunk(), pos = new Vec3(0, 64, 0);
  const absent = chunk.getBlock(pos);
  assert.equal(analyzeContinuation(bot(() => absent), plan([cell(0, stone)]), Vec3).cells[0].category, "missing");
  const chest = runtime("chest");
  chunk.setBlockStateId(pos, chest.stateId);
  const chestWithoutNbt = chunk.getBlock(pos);
  assert.equal(analyzeContinuation(bot(() => chestWithoutNbt), plan([cell(0, chest)]), Vec3).cells[0].category, "exact");
  const tag = { type: "compound", value: { id: { type: "string", value: "minecraft:chest" } } };
  chunk.setBlockEntity(pos, tag);
  const present = chunk.getBlock(pos), before = structuredClone(tag);
  const result = analyzeContinuation(bot(() => present), plan([cell(0, chest)]), Vec3);
  assert.equal(result.cells[0].category, "conflicts");
  assert.equal(result.counts.blockEntities, 1);
  assert.strictEqual(present.entity, tag);
  assert.deepEqual(tag, before);
});

test("unsupported private-field getter classes fail closed without losing their brand or calling them", () => {
  let calls = 0;
  class PrivateBlock {
    #properties = {};
    constructor() { this.name = "air"; this.stateId = air.stateId; }
    getProperties() { calls++; return this.#properties; }
  }
  const actual = new PrivateBlock();
  assert.equal(analyzeContinuation(bot(() => actual), plan([cell(0, stone)]), Vec3).cells[0].category, "unloaded");
  assert.equal(calls, 0);
  assert.deepEqual(actual.getProperties(), {});
  assert.equal(calls, 1);
});

test("real Prismarine blocks use registry-coherent computed state without writes", () => {
  const actual = runtime("oak_log", { axis: "x" });
  const before = structuredClone({ properties: actual._properties, computed: actual.computedStates });
  const result = analyzeContinuation(bot(() => actual), plan([cell(0, actual)]), Vec3);
  assert.equal(result.cells[0].category, "exact");
  result.cells[0].properties.axis = "z";
  assert.deepEqual({ properties: actual._properties, computed: actual.computedStates }, before);
  actual.computedStates.axis = "z";
  assert.equal(analyzeContinuation(bot(() => actual), plan([cell(0, logX)]), Vec3).cells[0].category, "unloaded");
  assert.deepEqual(actual._properties, before.properties);
});

test("registry identity and exact release are required", () => {
  for (const world of [{ blockAt: () => air }, { version: "1.21.4", registry: { ...registry, blocksByStateId: { ...registry.blocksByStateId } }, blockAt: () => air },
    { version: "1.20.4", registry, blockAt: () => air }]) {
    assert.throws(() => analyzeContinuation(world, plan([cell(0, stone)]), Vec3), /registry/i);
  }
});

test("real transformed states and all vanilla air variants classify across four rotations and releases", () => {
  for (const version of ["1.20.4", "1.21.4"]) {
    const versionRegistry = minecraftData(version), VersionBlock = require("prismarine-block")(version);
    const sourceBlocks = [VersionBlock.fromProperties("oak_stairs", { facing: "north", half: "top", shape: "inner_left", waterlogged: true }, 0),
      ...["air", "cave_air", "void_air"].map(name => VersionBlock.fromProperties(name, {}, 0))];
    const source = new Schematic(version, new Vec3(2, 1, 2), new Vec3(-2, 3, 7), sourceBlocks.map(value => value.stateId), [0, 1, 2, 3]);
    const codec = createStateTransformer({ version, registry: versionRegistry });
    for (const orientation of ["north", "east", "south", "west"]) {
      const transformed = transformSchematic(source, { codec, orientation, origin: { x: 10, y: 64, z: -3 } });
      const cells = transformed.cells, before = structuredClone(cells);
      const actual = cells.map(value => VersionBlock.fromStateId(value.stateId, 0));
      const worldBefore = actual.map(value => ({ properties: { ...value._properties }, computed: { ...value.computedStates } }));
      const world = { version, registry: versionRegistry, blockAt(p) { return actual.find((_, i) => cells[i].position.x === p.x && cells[i].position.z === p.z); } };
      const result = analyzeContinuation(world, { dimensions: { width: transformed.size.x, height: transformed.size.y, length: transformed.size.z }, cells }, Vec3);
      assert.deepEqual(result.counts, { exact: 1, missing: 0, air: 3, conflicts: 0, unloaded: 0, blockEntities: 0 });
      assert.deepEqual(cells, before);
      assert.deepEqual(actual.map(value => ({ properties: { ...value._properties }, computed: { ...value.computedStates } })), worldBefore);
      const caveAir = VersionBlock.fromProperties("cave_air", {}, 0);
      assert.equal(analyzeContinuation({ ...world, blockAt: () => caveAir }, plan([cells.find(value => value.name === "air")]), Vec3).cells[0].category, "air");
      assert.equal(analyzeContinuation({ ...world, blockAt: () => caveAir }, plan([cells.find(value => value.name === "oak_stairs")]), Vec3).cells[0].category, "missing");
    }
  }
});
