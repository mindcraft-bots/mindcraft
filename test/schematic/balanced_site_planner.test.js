import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers";
import test from "node:test";
import { planBalancedSchematicSite } from "../../src/utils/schematic/balanced_site_planner.js";

class Vec3 {
  constructor(x, y, z) { Object.assign(this, { x, y, z }); }
}
const key = ({ x, y, z }) => `${x},${y},${z}`;
const cell = (x, name = "air") => ({ position: { x, y: 64, z: 0 }, name, properties: {} });
const block = name => ({ name, diggable: true, getProperties: () => ({}) });

function fixture(cells, values = new Map()) {
  const reads = [];
  let writes = 0;
  const bot = Object.assign(new EventEmitter(), {
    version: "1.20.4", registry: {}, game: { dimension: "overworld" }, world: {},
    _client: Object.assign(new EventEmitter(), { socket: {} }), entity: {},
    blockAt(position) {
      reads.push(key(position));
      return values.has(key(position)) ? values.get(key(position)) : block("air");
    },
    dig() { writes++; throw new Error("planning must not dig"); },
    placeBlock() { writes++; throw new Error("planning must not place"); },
  });
  return {
    bot, reads, writes: () => writes,
    build: { cells, dimensions: { width: cells.length, height: 1, length: 1 } },
  };
}

test("ranks the full circular search by obstruction count, then distance and coordinates", async () => {
  const f = fixture([cell(0)], new Map([["0,64,0", block("poppy")]]));
  const result = await planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 1, threshold: 2 });
  assert.deepEqual(result, { dx: -1, dz: 0, obstructions: 0 });
  assert.deepEqual(new Set(f.reads), new Set(["0,64,0", "-1,64,0", "0,64,-1", "0,64,1", "1,64,0"]));
  assert.equal(f.writes(), 0);
});

test("counts target-solid and intended-air obstructions but not exact matching blocks", async () => {
  const values = new Map([
    ["0,64,0", block("poppy")], ["1,64,0", block("allium")], ["2,64,0", block("stone")],
  ]);
  const f = fixture([cell(0, "stone"), cell(1), cell(2, "stone")], values);
  const result = await planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 0, threshold: 3 });
  assert.deepEqual(result, { dx: 0, dz: 0, obstructions: 2 });
  await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 0, threshold: 2 }), { code: "SCHEMATIC_NO_SITE" });
  assert.equal(f.writes(), 0);
});

test("skips unknown, unloaded, leaf and protected candidates without mutating", async () => {
  for (const value of [null, block("mystery_block"), block("oak_leaves"), block("chest")]) {
    const f = fixture([cell(0)], new Map([["0,64,0", value]]));
    await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 0 }), { code: "SCHEMATIC_NO_SITE" });
    assert.equal(f.writes(), 0);
  }
});

test("an ineligible site is still scanned fully and does not prevent an eligible neighbor", async () => {
  const f = fixture([cell(0), cell(1)], new Map([
    ["0,64,0", block("chest")], ["1,64,0", block("poppy")],
  ]));
  const result = await planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 1 });
  assert.deepEqual(result, { dx: 0, dz: -1, obstructions: 0 });
  assert.deepEqual(f.reads.slice(0, 2), ["0,64,0", "1,64,0"]);
  assert.equal(f.writes(), 0);
});

test("prefers the nearest site when counts tie and never scans beyond the circle", async () => {
  const f = fixture([cell(0)]);
  const result = await planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 2, threshold: 1 });
  assert.deepEqual(result, { dx: 0, dz: 0, obstructions: 0 });
  assert.equal(f.reads.length, 13);
  assert.ok(!f.reads.includes("2,64,1"));
});

test("rejects invalid options and oversized search before reading any blocks", async () => {
  const f = fixture([cell(0)]);
  for (const radius of [-1, 17, 0.5, "4"]) {
    await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius }), /radius/);
  }
  for (const threshold of [0, 4098, 1.1, "9"]) {
    await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, threshold }), /threshold/);
  }
  const large = fixture(Array.from({ length: 315 }, (_, x) => cell(x)));
  await assert.rejects(planBalancedSchematicSite(large.bot, large.build, { Vec3Class: Vec3, radius: 16 }), { code: "SCHEMATIC_SITE_BUDGET" });
  assert.deepEqual(large.reads, []);
  const boundary = fixture([cell(0)]);
  assert.deepEqual(await planBalancedSchematicSite(boundary.bot, boundary.build, { Vec3Class: Vec3, radius: 16, threshold: 4097 }), { dx: 0, dz: 0, obstructions: 0 });
});

test("aborts for interruption or a lifecycle change instead of returning a partial best", async () => {
  const f = fixture([cell(0)]);
  f.bot.blockAt = () => { f.bot._client.emit("respawn"); return block("air"); };
  await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 1 }), { code: "SCHEMATIC_CLEAR_CANCELLED" });
  const interrupted = fixture([cell(0)]);
  interrupted.bot.interrupt_code = true;
  await assert.rejects(planBalancedSchematicSite(interrupted.bot, interrupted.build, { Vec3Class: Vec3 }), { code: "SCHEMATIC_CLEAR_CANCELLED" });
  assert.equal(interrupted.writes(), 0);
});

test("a lifecycle transition between candidate scans cancels the search", async () => {
  const f = fixture([cell(0)]);
  const read = f.bot.blockAt.bind(f.bot);
  f.bot.blockAt = position => {
    if (!f.reads.length) queueMicrotask(() => f.bot.emit("death"));
    return read(position);
  };
  await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 1 }), { code: "SCHEMATIC_CLEAR_CANCELLED" });
  assert.equal(f.reads.length, 1);
});

test("candidate scans use one snapshot of the schematic plan across yields", async () => {
  const f = fixture([cell(0, "stone")]);
  f.bot.blockAt = position => {
    if (!f.reads.length) queueMicrotask(() => { f.build.cells[0].name = "air"; });
    f.reads.push(key(position));
    return block(position.x === 0 && position.z === 0 ? "chest" : "stone");
  };
  assert.deepEqual(await planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 1 }), { dx: -1, dz: 0, obstructions: 0 });
});

test("a large single candidate yields during its scan and observes cancellation", async () => {
  const f = fixture(Array.from({ length: 500 }, (_, x) => cell(x)));
  const read = f.bot.blockAt.bind(f.bot);
  f.bot.blockAt = position => {
    if (!f.reads.length) setImmediate(() => { f.bot.interrupt_code = true; });
    return read(position);
  };
  await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 0 }), { code: "SCHEMATIC_CLEAR_CANCELLED" });
  assert.equal(f.reads.length, 128);
  assert.equal(f.writes(), 0);
});

test("malformed transformed volumes are rejected before any world read", async () => {
  const f = fixture([cell(0), cell(0)]);
  await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 0 }), /duplicate cell/);
  assert.deepEqual(f.reads, []);
  assert.equal(f.writes(), 0);
});
