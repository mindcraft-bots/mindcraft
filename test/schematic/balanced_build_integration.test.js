import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers";
import test from "node:test";
import { buildSchematic } from "../../src/utils/schematic/build_schematic.js";
import { resolvePlacementOptions } from "../../src/utils/schematic/placement_options.js";
import { acquireBuildLifecycle } from "../../src/utils/schematic/run_build.js";
import { provenanceFixtureDependencies } from "./provenance_fixture.js";

const require = createRequire(import.meta.url);
const Vec3 = require("vec3");
const data = require("minecraft-data")("1.20.4");
const Block = require("prismarine-block")("1.20.4");
const key = p => `${p.x},${p.y},${p.z}`;

function fixture(names = ["stone"], options = {}) {
  const world = new Map();
  const calls = { writes: [], modes: [], logs: [], origins: [], reads: [], supply: 0 };
  let phase = "planning";
  const entity = { position: new Vec3(100, 64, 100), width: 0.6, height: 1.8 };
  const bot = Object.assign(new EventEmitter(), {
    version: "1.20.4", registry: data, game: { gameMode: "survival", dimension: "overworld" },
    world: {}, _client: Object.assign(new EventEmitter(), { socket: {} }), entity, entities: { 1: entity },
    position: new Vec3(-2, 64, -2), interrupt_code: false,
    blockAt(position) {
      calls.reads.push(key(position));
      const name = world.has(key(position)) ? world.get(key(position)) : position.y === 63 ? "dirt" : "air";
      if (name == null) return null;
      if (!data.blocksByName[name]) return { name, position, diggable: true, getProperties: () => ({}) };
      const block = Block.fromStateId(data.blocksByName[name].defaultState, 0);
      block.position = position;
      return block;
    },
    dig(block) { calls.writes.push([phase, "dig", key(block.position)]); world.set(key(block.position), "air"); },
    placeBlock(reference, face) {
      const target = reference.position.plus(face);
      calls.writes.push([phase, "place", key(target)]);
      const name = names[target.x - calls.origins.at(-1).x];
      world.set(key(target), name);
      dependencies.onPlace?.(name, target);
    },
    pathfinder: { movements: {}, setMovements(movements) { this.movements = movements; }, goto: async () => {} },
    builder: { clearArea: async () => {} },
  });
  const palette = names.map(name => data.blocksByName[name].defaultState);
  const schematic = { size: new Vec3(names.length, 1, 1), offset: new Vec3(0, 0, 0), palette,
    blocks: names.map((_, i) => i), getBlock: position => Block.fromStateId(palette[position.x], 0) };
  const dependencies = provenanceFixtureDependencies({
    resolvePath: () => "/schematics/test.mc1.20.4.schem", fsAccess: () => {}, fsReadFile: () => Buffer.from("synthetic"),
    validateSource: () => {}, SchematicClass: { read: () => schematic },
    placementOptions: resolvePlacementOptions({ schematic_placement_mode: "balanced", schematic_balanced_radius: 1, schematic_balanced_threshold: 9 }, options),
    changeGameMode: async (_bot, mode) => {
      calls.modes.push(mode);
      if (mode === "creative") { phase = "editing"; await dependencies.onTransition?.(); }
      return true;
    },
    startSupply: () => { calls.supply++; const cleanup = () => {}; cleanup.cancel = () => {}; return cleanup; },
    executeBuild: async (_bot, build) => {
      calls.origins.push({ ...build.cells[0].position });
      if (dependencies.onBuild) return dependencies.onBuild(build);
      for (const cell of build.cells) {
        if (cell.name !== "air" && bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z)).name === "air") {
          await bot.placeBlock({ position: new Vec3(cell.position.x, cell.position.y - 1, cell.position.z) }, new Vec3(0, 1, 0));
        }
      }
      return { status: "finished", errors: [] };
    },
    writeLog: message => calls.logs.push(message),
  });
  return { bot, world, calls, dependencies, schematic, run: (x = 0, y = 64, z = 0) => buildSchematic(bot, "test.schem", x, y, z, dependencies) };
}

test("balanced refuses the radius-zero redstone/TNT induced-physics reproduction before Creative or supply", async () => {
  const f = fixture(["redstone_block"], { radius: 0 });
  f.world.set("0,63,0", "stone");
  f.world.set("1,64,0", "redstone_wire");
  f.world.set("2,64,0", "tnt");
  f.world.set("3,63,0", "gold_block");
  // Deterministic hazard oracle, not a Minecraft physics simulator: if the
  // forbidden placement reaches the real pipeline's guarded write, the
  // external marker/support is lost despite no direct out-of-volume write.
  f.dependencies.onPlace = name => {
    if (name === "redstone_block") f.world.set("3,63,0", "air");
  };
  assert.equal(await f.run(), false);
  assert.equal(f.world.get("3,63,0"), "gold_block");
  assert.deepEqual(f.calls.modes, []);
  assert.deepEqual(f.calls.writes, []);
  assert.equal(f.calls.supply, 0);
  assert.match(f.calls.logs.join(" "), /unsupported balanced target.*redstone_block/i);
});

test("balanced supports a positive inert target set, not every placeable single-block item", async () => {
  for (const name of ["redstone_block", "sponge", "wet_sponge", "piston", "sticky_piston", "observer", "tnt", "sand", "gravel", "oak_sapling", "carved_pumpkin", "white_concrete_powder"]) {
    const f = fixture([name], { radius: 0 });
    assert.equal(await f.run(), false, name);
    assert.deepEqual(f.calls.modes, [], name);
    assert.deepEqual(f.calls.writes, [], name);
    assert.equal(f.calls.supply, 0, name);
    assert.match(f.calls.logs.join(" "), /unsupported balanced target/i, name);
  }
});

test("balanced rejects update-sensitive, unknown, unloaded and attached neighboring states", async () => {
  for (const [position, name] of [
    ["1,64,0", "redstone_wire"], ["2,64,0", "piston"], ["1,65,0", "observer"],
    ["1,64,0", "tnt"], ["1,64,0", "water"], ["1,64,0", "lava"],
    ["0,65,0", "sand"], ["1,64,0", "sponge"], ["1,64,0", "oak_sapling"],
    ["1,64,0", "mystery"], ["1,64,0", null],
  ]) {
    const f = fixture(["stone"], { radius: 0 });
    f.world.set(position, name);
    assert.equal(await f.run(), false, `${position} ${name}`);
    assert.deepEqual(f.calls.modes, []);
    assert.deepEqual(f.calls.writes, []);
    assert.equal(f.calls.supply, 0);
    assert.match(f.calls.logs.join(" "), /balanced neighbor|Unavailable block/i);
  }
});

test("balanced rejects incomplete, extra, fluid-bearing and invalid passive target properties", async () => {
  for (const [name, properties] of [["stone", { waterlogged: true }], ["stone", { powered: true }],
    ["oak_log", {}], ["oak_log", { axis: "diagonal" }], ["grass_block", { snowy: "false" }]]) {
    const f = fixture([name], { radius: 0 });
    f.schematic.getBlock = () => ({ name, getProperties: () => properties });
    assert.equal(await f.run(), false, `${name}: ${JSON.stringify(properties)}`);
    assert.deepEqual(f.calls.modes, []);
    assert.deepEqual(f.calls.writes, []);
    assert.equal(f.calls.supply, 0);
    assert.match(f.calls.logs.join(" "), /unsupported balanced target/i);
  }
});

test("balanced rejects attached data and ambiguous passive neighbor properties before and after selection", async () => {
  for (const mutation of [block => { block.nbt = { protected: true }; },
    block => { block.getProperties = () => ({ waterlogged: true }); },
    block => { block.getProperties = () => { throw new Error("unavailable"); }; }]) {
    for (const afterSelection of [false, true]) {
      const f = fixture(["stone"], { radius: 0 });
      f.world.set("1,64,0", "stone");
      let enabled = !afterSelection;
      const read = f.bot.blockAt.bind(f.bot);
      f.bot.blockAt = position => {
        const block = read(position);
        if (enabled && key(position) === "1,64,0") mutation(block);
        return block;
      };
      f.dependencies.onTransition = () => { enabled = true; };
      assert.equal(await f.run(), false);
      assert.deepEqual(f.calls.writes, []);
      assert.deepEqual(f.calls.modes, afterSelection ? ["creative", "survival"] : []);
    }
  }
});

test("balanced revalidates neighboring physics after transitions and immediately before guarded writes", async () => {
  for (const name of ["redstone_wire", "piston", "water", "sponge"]) {
    for (const boundary of ["transition", "write"]) {
      const f = fixture(["stone"], { radius: 0 });
      const change = () => f.world.set("1,64,0", name);
      if (boundary === "transition") f.dependencies.onTransition = change;
      else f.dependencies.onBuild = async build => {
        change();
        await f.bot.placeBlock({ position: new Vec3(0, 63, 0) }, new Vec3(0, 1, 0));
        return { status: "finished", errors: [] };
      };
      assert.equal(await f.run(), false, `${boundary}: ${name}`);
      assert.deepEqual(f.calls.writes, []);
      assert.deepEqual(f.calls.modes, ["creative", "survival"]);
      assert.match(f.calls.logs.join(" "), /balanced.*neighbor|neighbor.*changed/i);
    }
  }
});

test("balanced inert materials remain useful across multiple guarded placements and revalidation", async () => {
  const f = fixture(["stone", "oak_planks", "glass", "white_wool", "bricks", "oak_log"], { radius: 0 });
  assert.equal(await f.run(), true);
  assert.equal(f.calls.writes.length, 6);
  assert.equal(f.calls.supply, 1);
  assert.deepEqual(f.calls.modes, ["creative", "survival"]);
});

test("balanced positively classifies actual in-volume states, not just requested targets and exterior neighbors", async () => {
  for (const name of ["oak_sapling", "brown_mushroom", "crimson_fungus", "wheat", "azalea"]) {
    const f = fixture(["air", "stone"], { radius: 0 });
    f.world.set("0,64,0", name);
    assert.equal(await f.run(), false, name);
    assert.deepEqual(f.calls.modes, [], name);
    assert.deepEqual(f.calls.writes, [], name);
    assert.equal(f.calls.supply, 0, name);
    assert.match(f.calls.logs.join(" "), /Unsupported balanced volume state/, name);
  }
  for (const mutation of [block => { block.nbt = { protected: true }; },
    block => { block.getProperties = () => ({ powered: true }); },
    block => { block.getProperties = () => []; }]) {
    const f = fixture(["stone"], { radius: 0 });
    f.world.set("0,64,0", "stone");
    const read = f.bot.blockAt.bind(f.bot);
    f.bot.blockAt = position => {
      const block = read(position);
      if (key(position) === "0,64,0") mutation(block);
      return block;
    };
    assert.equal(await f.run(), false);
    assert.deepEqual(f.calls.modes, []);
    assert.deepEqual(f.calls.writes, []);
    assert.equal(f.calls.supply, 0);
  }
});

test("balanced rechecks unsafe neighbors after asynchronous navigation before a clearing dig", async () => {
  for (const name of ["redstone_wire", "piston", "water", "sand", "oak_leaves"]) {
    const f = fixture(["air"], { radius: 0 });
    f.world.set("0,64,0", "poppy");
    f.bot.pathfinder.goto = async () => {
      await new Promise(resolve => setImmediate(resolve));
      f.world.set("1,64,0", name);
    };
    assert.equal(await f.run(), false, name);
    assert.deepEqual(f.calls.writes, [], name);
    assert.equal(f.world.get("0,64,0"), "poppy", name);
    assert.equal(f.calls.supply, 0, name);
    assert.match(f.calls.logs.join(" "), /Unsupported balanced neighbor/, name);
  }
});

test("balanced rechecks after builder waits and refuses an unsafe state before the next edit", async () => {
  for (const edit of ["dig", "place"]) {
    const f = fixture([edit === "dig" ? "air" : "stone"], { radius: 0 });
    f.dependencies.onBuild = async () => {
      await new Promise(resolve => setImmediate(resolve));
      f.world.set("1,65,0", "observer");
      if (edit === "dig") await f.bot.dig(f.bot.blockAt(new Vec3(0, 64, 0)));
      else await f.bot.placeBlock({ position: new Vec3(0, 63, 0) }, new Vec3(0, 1, 0));
      return { status: "finished", errors: [] };
    };
    assert.equal(await f.run(), false, edit);
    assert.deepEqual(f.calls.writes, [], edit);
    assert.match(f.calls.logs.join(" "), /Unsupported balanced neighbor/, edit);
  }
});

test("balanced does not silently approve changed passive neighbors or unsafe targets at write time", async () => {
  for (const change of [f => f.world.set("1,64,0", "glass"), (_f, build) => {
    build.cells = build.cells.map(cell => ({ ...cell, name: "sponge", stateId: data.blocksByName.sponge.defaultState }));
  }, (_f, build) => {
    build.cells = build.cells.map(cell => ({ ...cell, properties: { powered: true } }));
  }]) {
    const f = fixture(["stone"], { radius: 0 });
    f.dependencies.onBuild = async build => {
      change(f, build);
      await f.bot.placeBlock({ position: new Vec3(0, 63, 0) }, new Vec3(0, 1, 0));
      return { status: "finished", errors: [] };
    };
    assert.equal(await f.run(), false);
    assert.deepEqual(f.calls.writes, []);
    assert.match(f.calls.logs.join(" "), /Unsupported balanced target|balanced neighbor changed/);
  }
});

test("balanced resumes recheck neighboring physics at the frozen origin before Creative", async () => {
  const f = fixture(["stone"], { radius: 0 });
  f.dependencies.resumeSession = { cancelled: false };
  f.dependencies.onBuild = () => ({ status: "interrupted", errors: [] });
  assert.equal(await f.run(), false);
  assert.equal(f.dependencies.resumeSession.resumeEligible, true);
  f.world.set("1,64,0", "piston");
  f.calls.modes.length = 0;
  f.calls.writes.length = 0;
  f.calls.supply = 0;
  assert.equal(await f.run(99, 70, 99), false);
  assert.deepEqual(f.calls.modes, []);
  assert.deepEqual(f.calls.writes, []);
  assert.equal(f.calls.supply, 0);
});

test("the new target policy is balanced-only, preserving legacy single-block admission", async () => {
  for (const name of ["redstone_block", "sponge", "piston"]) {
    const f = fixture([name]);
    f.dependencies.placementOptions = resolvePlacementOptions({});
    assert.equal(await f.run(), true, name);
    assert.equal(f.calls.writes.length, 1);
    assert.deepEqual(f.calls.modes, ["creative", "survival"]);
  }
});

test("balanced ranks exact mismatches, honors explicit anchor and edits only after planning", async () => {
  const f = fixture(["stone"], { radius: 1, threshold: 2 });
  f.world.set("-1,64,0", "stone");
  f.world.set("0,64,-1", "stone");
  assert.equal(await f.run(), true);
  assert.deepEqual(f.calls.origins, [{ x: -1, y: 64, z: 0 }]);
  assert.match(f.calls.logs.join(" "), /origin -1,64,0; bounds -1,64,0 to -1,64,0; 0 mismatches/);
  assert.deepEqual(f.calls.writes, []);
  // Surrounding cells are now deliberately read, not ranked as extra origins.
  assert.ok(f.calls.reads.includes("-1,64,-1"));
});

test("threshold is strict and counts both empty solid targets and intended-air obstructions", async () => {
  const f = fixture(["stone", "air"], { radius: 0, threshold: 2 });
  f.world.set("1,64,0", "poppy");
  assert.equal(await f.run(), false);
  assert.match(f.calls.logs.join(" "), /strict obstruction threshold/);
  assert.deepEqual(f.calls.modes, []);
  assert.deepEqual(f.calls.writes, []);
  f.dependencies.placementOptions = resolvePlacementOptions({ schematic_placement_mode: "balanced" }, { radius: 0, threshold: 3 });
  assert.equal(await f.run(), true);
  assert.deepEqual(f.calls.writes.map(item => item[1]), ["dig", "place"]);
  assert.ok(f.calls.writes.every(item => item[0] === "editing"));
});

test("protected, unknown and unloaded cells, unsafe ground and entity occupancy prevent a build", async () => {
  for (const [position, name] of [["0,64,0", "oak_leaves"], ["0,64,0", "chest"], ["0,64,0", "mystery"], ["0,64,0", null], ["0,63,0", "sand"], ["0,63,0", null], ["0,63,0", "oak_slab"]]) {
    const f = fixture(["stone"], { radius: 0 });
    f.world.set(position, name);
    assert.equal(await f.run(), false, `${position} ${name}`);
    assert.deepEqual(f.calls.writes, []);
    assert.deepEqual(f.calls.modes, []);
  }
  for (const blocker of [ { position: new Vec3(0.5, 64, 0.5), width: 0.6, height: 1.8 }, { position: new Vec3(20, 64, 20) } ]) {
    const f = fixture(["stone"], { radius: 0 });
    f.bot.entities[2] = blocker;
    assert.equal(await f.run(), false);
    assert.deepEqual(f.calls.writes, []);
  }
});

test("changes after Creative transition abort without approving new blocks, support, or entities", async () => {
  for (const change of [f => f.world.set("0,64,0", "poppy"), f => f.world.set("0,63,0", "stone"), f => { f.bot.entities[2] = { position: new Vec3(0.5, 64, 0.5), width: 0.6, height: 1.8 }; }]) {
    const f = fixture(["stone"], { radius: 0 });
    f.dependencies.onTransition = () => change(f);
    assert.equal(await f.run(), false);
    assert.deepEqual(f.calls.writes, []);
    assert.deepEqual(f.calls.modes, ["creative", "survival"]);
  }
});

test("budget and cancellation abort without writes or Creative transition", async () => {
  const big = fixture(Array(160).fill("air"), { radius: 16 });
  assert.equal(await big.run(), false);
  assert.match(big.calls.logs.join(" "), /budget/);
  assert.deepEqual(big.calls.writes, []);
  const cancelled = fixture(["stone"], { radius: 1 });
  cancelled.bot.interrupt_code = true;
  assert.equal(await cancelled.run(), false);
  assert.deepEqual(cancelled.calls.modes, []);
  assert.deepEqual(cancelled.calls.writes, []);
});

test("planning holds the build lease and observes cancellation during a yielded scan", async () => {
  const f = fixture(["stone"], { radius: 4 });
  const read = f.bot.blockAt.bind(f.bot);
  let checked = false;
  f.bot.blockAt = position => {
    if (!checked) {
      checked = true;
      assert.equal(acquireBuildLifecycle(f.bot), null);
      setImmediate(() => { f.bot.interrupt_code = true; });
    }
    return read(position);
  };
  assert.equal(await f.run(), false);
  assert.equal(checked, true);
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.modes, []);
  const lease = acquireBuildLifecycle(f.bot);
  assert.ok(lease);
  lease.release();
});

test("a different safe obstruction appearing during navigation is not newly approved", async () => {
  const f = fixture(["air", "air"], { radius: 0, threshold: 3 });
  f.world.set("0,64,0", "poppy");
  f.bot.pathfinder.goto = () => { f.world.set("1,64,0", "poppy"); };
  assert.equal(await f.run(), false);
  assert.deepEqual(f.calls.writes, []);
  assert.match(f.calls.logs.join(" "), /Selected site changed/);
});

test("eligible resume retains selected origin and options without searching again", async () => {
  const f = fixture(["stone"], { radius: 1 });
  const session = { cancelled: false };
  f.dependencies.resumeSession = session;
  f.world.set("-1,64,0", "stone");
  f.dependencies.onBuild = () => ({ status: "interrupted", errors: [] });
  assert.equal(await f.run(), false);
  assert.equal(session.resumeEligible, true);
  assert.deepEqual(session.context.origin, { x: -1, y: 64, z: 0 });
  f.world.set("0,64,0", "stone");
  f.dependencies.onBuild = () => ({ status: "finished", errors: [] });
  f.calls.reads.length = 0;
  assert.equal(await f.run(99, 70, 99), true);
  assert.deepEqual(f.calls.origins, [{ x: -1, y: 64, z: 0 }, { x: -1, y: 64, z: 0 }]);
  assert.ok(!f.calls.reads.includes("99,70,99"));
});
