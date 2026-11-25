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
  const result = await planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 1, threshold: 2, strategy: "all", policy: "exhaustive" });
  assert.deepEqual(result, { dx: -1, dz: 0, obstructions: 0 });
  assert.deepEqual(f.reads, ["0,64,0", "-1,64,0"]);
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

test("an ineligible site is discarded and does not prevent an eligible neighbor", async () => {
  const f = fixture([cell(0), cell(1)], new Map([
    ["0,64,0", block("chest")], ["1,64,0", block("poppy")],
  ]));
  const result = await planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 1, strategy: "all", policy: "exhaustive" });
  assert.deepEqual(result, { dx: 0, dz: -1, obstructions: 0 });
  assert.equal(f.reads[0], "0,64,0");
  assert.equal(f.writes(), 0);
});

test("prefers the nearest site when counts tie and never scans beyond the circle", async () => {
  const f = fixture([cell(0)]);
  const result = await planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 2, threshold: 1, strategy: "all", policy: "exhaustive" });
  assert.deepEqual(result, { dx: 0, dz: 0, obstructions: 0 });
  assert.equal(f.reads.length, 1);
  assert.ok(!f.reads.includes("2,64,1"));
});

test("rejects invalid options and permits searches whose actual reads fit", async () => {
  const f = fixture([cell(0)]);
  for (const radius of [-1, 17, 0.5, "4"]) {
    await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius }), /radius/);
  }
  for (const threshold of [0, 4098, 1.1, "9"]) {
    await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, threshold }), /threshold/);
  }
  const large = fixture(Array.from({ length: 315 }, (_, x) => cell(x)));
  await planBalancedSchematicSite(large.bot, large.build, { Vec3Class: Vec3, radius: 16 });
  assert.equal(large.reads.length, 315);
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
  const result = await planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 1, strategy: "all", policy: "exhaustive" });
  assert.deepEqual(result, { dx: -1, dz: 0, obstructions: 0 });
  assert.equal(result.plan.cells[0].name, "stone");
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

test("candidate generators are deterministic, circular, deduplicated and breadth-first", async () => {
  const { balancedCandidateOffsets } = await import("../../src/utils/schematic/balanced_site_planner.js");
  const compact = opts => balancedCandidateOffsets(opts).map(o => [o.dx, o.dz, o.level]);
  assert.deepEqual(compact({ radius: 2, strategy: "stepped", step: 2 }), [[0, 0, 0], [-2, 0, 0], [0, -2, 0], [0, 2, 0], [2, 0, 0]]);
  assert.deepEqual(compact({ radius: 4, strategy: "bisect", bisectDepth: 1 }), [[0, 0, 0], [-2, -2, 1], [-2, 2, 1], [2, -2, 1], [2, 2, 1]]);
  assert.deepEqual(compact({ radius: 4, strategy: "bisect", step: 1, bisectDepth: 2 }), [
    [0, 0, 0], [-2, -2, 1], [-2, 2, 1], [2, -2, 1], [2, 2, 1],
    [-1, -1, 2], [-1, 1, 2], [1, -1, 2], [1, 1, 2],
    [-3, -1, 2], [-3, 1, 2], [-1, -3, 2], [-1, 3, 2], [1, -3, 2], [1, 3, 2], [3, -1, 2], [3, 1, 2],
    [-3, -2, 2], [-2, 3, 2], [3, -2, 2],
  ]);
  assert.deepEqual(compact({ radius: 4, strategy: "bisect", step: 8, bisectDepth: 3 }), [[0, 0, 0]]);
  assert.deepEqual(compact({ radius: 4, strategy: "bisect", step: 4, bisectDepth: 3 }), [[0, 0, 0], [-2, -2, 1], [-2, 2, 1], [2, -2, 1], [2, 2, 1]]);
  assert.deepEqual(compact({ radius: 1, strategy: "bisect", step: 1, bisectDepth: 3 }), [[0, 0, 0], [-1, 0, 1], [0, 1, 1], [1, 0, 1]]);
  for (let radius = 0; radius <= 16; radius++) for (const strategy of ["all", "stepped", "bisect"]) for (let depth = 0; depth <= 3; depth++) {
    const options = { radius, strategy, step: 3, bisectDepth: depth };
    const a = balancedCandidateOffsets(options);
    assert.deepEqual(a, balancedCandidateOffsets(options));
    assert.deepEqual([a[0].dx, a[0].dz], [0, 0]);
    assert.equal(new Set(a.map(o => `${o.dx},${o.dz}`)).size, a.length);
    assert.ok(a.every(o => o.distanceSquared <= radius * radius));
    assert.ok(a.every((o, i) => !i || o.level >= a[i - 1].level));
    if (strategy === "all") assert.equal(a.length, Array.from({ length: 2 * radius + 1 }, (_, i) => i - radius).flatMap(x => Array.from({ length: 2 * radius + 1 }, (_, i) => i - radius).filter(z => x * x + z * z <= radius * radius)).length);
  }
});

test("bisect matches a brute-force rectangle and midpoint oracle at every supported radius", async () => {
  const { balancedCandidateOffsets } = await import("../../src/utils/schematic/balanced_site_planner.js");
  const compare = (a, b) => a.dx * a.dx + a.dz * a.dz - b.dx * b.dx - b.dz * b.dz || a.dx - b.dx || a.dz - b.dz;
  for (let radius = 0; radius <= 16; radius++) for (const step of [1, 2, 4, 8, 16]) for (let depth = 0; depth <= 3; depth++) {
    let levelRects = [[-radius, radius, -radius, radius]];
    const seen = new Set(), expected = [];
    for (let level = 0; level <= depth; level++) {
      const representatives = [], children = [];
      for (const [x0, x1, z0, z1] of levelRects) {
        const points = [];
        for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
          if (dx >= x0 && dx <= x1 && dz >= z0 && dz <= z1 && dx * dx + dz * dz <= radius * radius) points.push({ dx: dx || 0, dz: dz || 0 });
        }
        points.sort((a, b) => ((2 * a.dx - x0 - x1) ** 2 + (2 * a.dz - z0 - z1) ** 2)
          - ((2 * b.dx - x0 - x1) ** 2 + (2 * b.dz - z0 - z1) ** 2) || a.dx - b.dx || a.dz - b.dz);
        if (!points.length) continue;
        const point = points[0], key = `${point.dx},${point.dz}`;
        if (!seen.has(key)) { seen.add(key); representatives.push({ ...point, level }); }
        if (level === depth || (x1 - x0 <= step && z1 - z0 <= step)) continue;
        const xm = Math.floor((x0 + x1) / 2), zm = Math.floor((z0 + z1) / 2);
        const xs = x0 === x1 ? [[x0, x1]] : [[x0, xm], [xm + 1, x1]];
        const zs = z0 === z1 ? [[z0, z1]] : [[z0, zm], [zm + 1, z1]];
        for (const [a, b] of xs) for (const [c, d] of zs) children.push([a, b, c, d]);
      }
      expected.push(...representatives.sort(compare));
      levelRects = children;
    }
    const actual = balancedCandidateOffsets({ radius, strategy: "bisect", step, bisectDepth: depth });
    assert.deepEqual(actual.map(({ dx, dz, level }) => ({ dx, dz, level })), expected, `radius=${radius} step=${step} depth=${depth}`);
  }
});

test("bisect ties retain the first qualified generation even when a later site is nearer", async () => {
  const f = fixture([cell(0)]), inspected = [];
  f.bot.blockAt = position => {
    f.reads.push(key(position));
    return block(position.x === 0 && position.z === 0 ? "chest" : "poppy");
  };
  const result = await planBalancedSchematicSite(f.bot, f.build, {
    Vec3Class: Vec3, radius: 4, strategy: "bisect", step: 1, bisectDepth: 3, policy: "exhaustive", threshold: 2,
    inspectCandidate: offset => { inspected.push([offset.dx, offset.dz]); return {}; },
  });
  assert.deepEqual(result, { dx: -2, dz: -2, obstructions: 1 });
  assert.ok(f.reads.includes("-1,64,-1"));
  assert.deepEqual(inspected, [[-2, -2]]);
});

test("zero scores stop only after safety qualification and still observe cancellation", async () => {
  const f = fixture([cell(0)]), inspected = [];
  const result = await planBalancedSchematicSite(f.bot, f.build, {
    Vec3Class: Vec3, radius: 1, strategy: "all", policy: "exhaustive",
    inspectCandidate: offset => {
      inspected.push([offset.dx, offset.dz]);
      if (inspected.length === 1) throw Object.assign(new Error("unsafe anchor"), { code: "SCHEMATIC_SITE_UNSAFE" });
      return { qualified: true };
    },
  });
  assert.deepEqual(inspected, [[0, 0], [-1, 0]]);
  assert.deepEqual(result, { dx: -1, dz: 0, obstructions: 0 });
  assert.equal(result.search.visited, 2);
  assert.equal(result.search.sampled, true);
  const cancelled = fixture([cell(0)]);
  await assert.rejects(planBalancedSchematicSite(cancelled.bot, cancelled.build, {
    Vec3Class: Vec3, radius: 1, strategy: "all", policy: "exhaustive",
    inspectCandidate: () => { setImmediate(() => { cancelled.bot.interrupt_code = true; }); return {}; },
  }), { code: "SCHEMATIC_CLEAR_CANCELLED" });
});

test("exhaustion distinguishes eligible safety failures from threshold and volume refusals", async () => {
  const unsafe = fixture([cell(0)]);
  await assert.rejects(planBalancedSchematicSite(unsafe.bot, unsafe.build, {
    Vec3Class: Vec3, radius: 0, inspectCandidate: () => { throw Object.assign(new Error("unsafe foundation"), { code: "SCHEMATIC_SITE_UNSAFE" }); },
  }), error => error.code === "SCHEMATIC_SITE_UNSAFE" && error.message.includes("unsafe foundation"));
  const threshold = fixture([cell(0)], new Map([["0,64,0", block("poppy")]]));
  let calls = 0;
  await assert.rejects(planBalancedSchematicSite(threshold.bot, threshold.build, {
    Vec3Class: Vec3, radius: 0, threshold: 1, inspectCandidate: () => { calls++; throw new Error("must not inspect"); },
  }), { code: "SCHEMATIC_NO_SITE" });
  assert.equal(calls, 0);
  const mixed = fixture([cell(0)]);
  mixed.bot.blockAt = position => block(position.x === 0 && position.z === 0 ? "air" : "poppy");
  await assert.rejects(planBalancedSchematicSite(mixed.bot, mixed.build, {
    Vec3Class: Vec3, radius: 1, strategy: "all", threshold: 1, policy: "exhaustive",
    inspectCandidate: () => { throw Object.assign(new Error("unsafe anchor"), { code: "SCHEMATIC_SITE_UNSAFE" }); },
  }), error => error.code === "SCHEMATIC_SITE_UNSAFE" && error.message.includes("unsafe anchor"));
  assert.equal(unsafe.writes() + threshold.writes() + mixed.writes(), 0);
});

test("exhaustive branch-and-bound matches an independent randomized oracle", async () => {
  const { balancedCandidateOffsets } = await import("../../src/utils/schematic/balanced_site_planner.js");
  let seed = 0x83ab19;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let trial = 0; trial < 100; trial++) {
    const radius = 1 + random(4), threshold = 1 + random(5), strategy = ["all", "stepped", "bisect"][random(3)];
    const options = { radius, threshold, strategy, step: 2 + random(2), bisectDepth: random(4), policy: "exhaustive", Vec3Class: Vec3 };
    const values = new Map();
    for (let x = -radius; x <= radius + 3; x++) for (let z = -radius; z <= radius; z++) {
      const draw = random(10);
      values.set(`${x},64,${z}`, block(draw < 2 ? "chest" : draw < 6 ? "poppy" : "air"));
    }
    const f = fixture(Array.from({ length: 4 }, (_, x) => cell(x)), values);
    const unsafeOffset = o => (o.dx * 3 + o.dz * 7 + trial) % 7 === 0;
    const eligible = balancedCandidateOffsets(options).map((o, index) => {
      const names = f.build.cells.map(c => values.get(`${c.position.x + o.dx},64,${o.dz}`)?.name ?? "air");
      return { ...o, index, count: names.filter(name => name !== "air").length, protected: names.includes("chest"), unsafe: unsafeOffset(o) };
    }).filter(o => !o.protected && o.count < threshold);
    const candidates = eligible.filter(o => !o.unsafe).sort((a, b) => a.count - b.count || a.index - b.index);
    const inspectCandidate = (offset, states) => {
      assert.equal(states.length, 4, "partial candidates must never reach safety qualification");
      if (unsafeOffset(offset)) throw Object.assign(new Error("unsafe"), { code: "SCHEMATIC_SITE_UNSAFE" });
      return { qualified: true };
    };
    if (!candidates.length) await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { ...options, inspectCandidate }), { code: eligible.length ? "SCHEMATIC_SITE_UNSAFE" : "SCHEMATIC_NO_SITE" });
    else {
      const result = await planBalancedSchematicSite(f.bot, f.build, { ...options, inspectCandidate });
      assert.deepEqual([result.dx, result.dz, result.obstructions], [candidates[0].dx, candidates[0].dz, candidates[0].count], `trial ${trial}`);
      assert.equal(result.safety.qualified, true);
    }
  }
});

test("first-valid stops only after safety qualification and reports sampling", async () => {
  const f = fixture([cell(0)]);
  const inspected = [];
  const result = await planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 2, strategy: "all", policy: "first_valid",
    inspectCandidate: (o, states) => {
      assert.equal(states.length, 1); inspected.push([o.dx, o.dz]);
      if (!o.dx && !o.dz) throw Object.assign(new Error("unsafe"), { code: "SCHEMATIC_SITE_UNSAFE" });
      return { accepted: true };
    } });
  assert.deepEqual(inspected, [[0, 0], [-1, 0]]);
  assert.deepEqual([result.dx, result.dz], [-1, 0]);
  assert.equal(result.search.sampled, true);
  assert.equal(result.safety.accepted, true);
});

test("actual support and halo reads share the search budget", async () => {
  const { inspectBalancedCandidate } = await import("../../src/utils/schematic/balanced_site_safety.js");
  const f = fixture(Array.from({ length: 11000 }, (_, x) => ({ ...cell(x), stateId: 0 })));
  f.bot.registry = { blocksByName: { air: { states: [] }, stone: { states: [] } }, blocksByStateId: { 0: { name: "air" } } };
  let reads = 0;
  const air = block("air"), stone = { ...block("stone"), shapes: [[0, 0, 0, 1, 1, 1]] };
  f.bot.blockAt = p => { reads++; return p.y === 63 ? stone : air; };
  await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 0,
    inspectCandidate: (o, states, check, beforeRead, snapshot) => inspectBalancedCandidate(f.bot, snapshot, o, states, Vec3, check, beforeRead),
  }), { code: "SCHEMATIC_SITE_BUDGET" });
  assert.equal(reads, 250000);
  assert.equal(f.writes(), 0);
});

test("support inspection yields for cancellation before a site can be selected", async () => {
  const { inspectBalancedCandidate } = await import("../../src/utils/schematic/balanced_site_safety.js");
  const f = fixture(Array.from({ length: 150 }, (_, x) => ({ ...cell(x), stateId: 0 })));
  f.bot.registry = { blocksByName: { air: { states: [] }, stone: { states: [] } }, blocksByStateId: { 0: { name: "air" } } };
  let supportReads = 0;
  f.bot.blockAt = p => {
    if (p.y === 63 && ++supportReads === 1) setImmediate(() => { f.bot.interrupt_code = true; });
    return p.y === 63 ? { ...block("stone"), shapes: [[0, 0, 0, 1, 1, 1]] } : block("air");
  };
  await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 0,
    inspectCandidate: (o, states, check, beforeRead, snapshot) => inspectBalancedCandidate(f.bot, snapshot, o, states, Vec3, check, beforeRead),
  }), { code: "SCHEMATIC_CLEAR_CANCELLED" });
  assert.equal(supportReads, 128);
});

test("both policies stop at a fully inspected zero-score site", async () => {
  for (const policy of ["first_valid", "exhaustive"]) {
    const f = fixture(Array.from({ length: 128 }, (_, x) => cell(x)));
    const result = await planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 4, strategy: "all", policy });
    assert.equal(f.reads.length, 128);
    assert.equal(result.search.sampled, true);
  }
});

test("budget failure after a qualified incumbent never returns that partial best", async () => {
  const f = fixture([cell(0, "stone")], new Map([["-1,64,0", block("stone")]]));
  f.bot.blockAt = (() => { let reads = 0; const air = block("air"), stone = block("stone"); return p => { reads++; f.reads.length = 1; f.reads[0] = reads; return p.x === -1 ? stone : air; }; })();
  await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 1, strategy: "all", policy: "exhaustive", threshold: 2,
    inspectCandidate: (offset, states, check, beforeRead) => {
      if (offset.dx === -1) for (let i = 0; i < 250000; i++) { beforeRead(); f.bot.blockAt(new Vec3(-1, 64, 0)); }
      return { qualified: true };
    },
  }), { code: "SCHEMATIC_SITE_BUDGET" });
  assert.equal(f.reads[0], 250000);
});

test("deadline expiry after an incumbent aborts, rather than returning a partial best", async t => {
  const { performance } = await import("node:perf_hooks");
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const f = fixture([cell(0, "stone")], new Map([["-1,64,0", block("stone")]]));
  let qualified = 0;
  await assert.rejects(planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 1, strategy: "all", policy: "exhaustive", threshold: 2,
    inspectCandidate: () => { if (++qualified === 2) now = 2000; return {}; },
  }), { code: "SCHEMATIC_SITE_BUDGET" });
  assert.equal(qualified, 2);
  assert.equal(f.reads.length, 2);
});

test("exactly 250000 accounted world reads can complete", async () => {
  const f = fixture([cell(0)]);
  let reads = 0;
  f.bot.blockAt = () => { reads++; return block("air"); };
  const result = await planBalancedSchematicSite(f.bot, f.build, { Vec3Class: Vec3, radius: 0,
    inspectCandidate: (_offset, _states, _check, beforeRead) => {
      for (let i = 0; i < 249999; i++) { beforeRead(); f.bot.blockAt(new Vec3(0, 64, 0)); }
      return {};
    },
  });
  assert.equal(reads, 250000);
  assert.equal(result.search.reads, 250000);
});
