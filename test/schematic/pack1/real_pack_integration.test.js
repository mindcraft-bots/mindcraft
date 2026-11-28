import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SCHEMATICS_DIR, listSchematicEntries, resolveSchematicPath } from "../../../src/utils/schematic/paths.js";
import { buildSchematic } from "../../../src/utils/schematic/build_schematic.js";
import { readSchematic } from "../../../src/utils/schematic/reader.js";
import { createModernBuild } from "../../../src/utils/schematic/modern_build.js";

const require = createRequire(import.meta.url);
const Vec3 = require("vec3");
const unsupportedCanonical = ["01_wardrobe_nether_portal.schem", "04_pagoda.schem", "06_wild_west_jail.schem", "07_secret_island_base.schem", "10_pachinko_parkour.schem", "14_school_monster_bus.schem", "15_potion_factory.schem", "18_giant_grandfather_clock.schem"];

test("every real pack1 asset is listed with separate group and id fields and resolves by tuple, stem, and filename", async () => {
  const directory = path.join(SCHEMATICS_DIR, "schems/pack1");
  const { schemaVersion, groups } = JSON.parse(await readFile(path.join(directory, "index.json"), "utf8"));
  assert.equal(schemaVersion, 2);
  const files = (await readdir(directory)).filter(name => name.endsWith(".schem")).sort();
  assert.equal(files.length, 60);
  const mappings = Object.entries(groups).flatMap(([group, ids]) => Object.entries(ids).map(([id, filename]) => ({
    group: Number(group), id: Number(id), filename,
  })));
  assert.equal(mappings.length, 30);
  assert.deepEqual(mappings.flatMap(({ filename }) => ["1.21.4", "26.1"].map(version => filename.replace(/\.schem$/, `.mc${version}.schem`))).sort(), files);
  const entries = (await listSchematicEntries(SCHEMATICS_DIR, { version: "26.1" })).filter(entry => entry.pack === "pack1");
  assert.equal(entries.length, 60);
  const versionedEntries = Object.fromEntries(await Promise.all(["1.21.4", "26.1"].map(async version =>
    [version, (await listSchematicEntries(SCHEMATICS_DIR, { version })).filter(entry => entry.pack === "pack1")])));
  const unsupported = [];
  for (const { group, id, filename } of mappings) {
    const expected = path.join(directory, filename.replace(/\.schem$/, ".mc1.21.4.schem"));
    for (const selector of [`${group}:${id}`, filename, path.basename(filename, ".schem")]) {
      await assert.rejects(resolveSchematicPath(`pack1:${selector}`), /Unknown Minecraft engine/);
      await assert.rejects(resolveSchematicPath(`pack1:${selector}`, SCHEMATICS_DIR, { version: "1.20.4" }), /No compatible known-version/);
      for (const version of ["1.21.4", "26.1"]) {
        assert.equal(await resolveSchematicPath(`pack1:${selector}`, SCHEMATICS_DIR, { version }), path.join(directory, filename.replace(/\.schem$/, `.mc${version}.schem`)));
      }
    }
    const blueprint = JSON.parse(await readFile(path.join(SCHEMATICS_DIR, "blueprints/pack1", filename.replace(/\.schem$/, ".json")), "utf8"));
    for (const version of ["1.21.4", "26.1"]) {
      const variant = filename.replace(/\.schem$/, `.mc${version}.schem`);
      const selected = await resolveSchematicPath(`pack1:${variant}`, SCHEMATICS_DIR, { version });
      assert.equal(selected, path.join(directory, variant));
      assert.equal(await resolveSchematicPath(`schems/pack1/${filename}`, SCHEMATICS_DIR, { version }), selected);
      assert.equal(await resolveSchematicPath(`schems/pack1/${variant}`, SCHEMATICS_DIR, { version }), selected);
      const listedVariant = entries.find(entry => entry.fileName === variant);
      assert.equal(listedVariant.group, group);
      assert.equal(listedVariant.fileId, id);
      const versioned = versionedEntries[version].find(entry => entry.fileName === variant);
      assert.equal(versioned.version, version);
      assert.equal(versioned.selector, `pack1:${group}:${id}`);
      assert.equal(versioned.compatible, true);
      assert.equal(versioned.selected, true);
      assert.equal(versioned.validationStatus, filename === "02_bee_hot_air_balloon.schem" ? "STRICT_VALIDATED" : "HISTORICAL_UNKNOWN");
      const parsedVariant = await readSchematic(await readFile(selected), version);
      assert.deepEqual([parsedVariant.size.x, parsedVariant.size.y, parsedVariant.size.z], [blueprint.width_x, blueprint.height_y, blueprint.length_z]);
    }
    const parsed = await readSchematic(await readFile(expected), blueprint.minecraft_version);
    assert.deepEqual([parsed.size.x, parsed.size.y, parsed.size.z], [blueprint.width_x, blueprint.height_y, blueprint.length_z]);
    let build;
    try {
      build = createModernBuild(parsed, { version: blueprint.minecraft_version }, new Vec3(0, 64, 0));
    } catch (error) {
      assert.match(error.message, /no placeable item mapping for potted_(oak_sapling|fern)|full physics footprint cannot be safely proven/);
      unsupported.push({ group, id, filename, error: error.message });
      continue;
    }
    const nonAir = Object.entries(blueprint.expected_counts).reduce((sum, [state, count]) => sum + (state === "minecraft:air" ? 0 : count), 0);
    assert.equal(build.plan.length, nonAir);
  }
  assert.ok(unsupported.some(entry => entry.filename === "01_wardrobe_nether_portal.schem" && /physics footprint/.test(entry.error)));
  assert.deepEqual(unsupported.map(entry => entry.filename).sort(), unsupportedCanonical);
  console.log("PACK1_BUILD_PREFLIGHT " + JSON.stringify({ passed: mappings.length - unsupported.length, unsupported }));
});

test("all 1.21.4 pack1 variants read and preflight against 26.1 using only the verified chain alias", async () => {
  const directory = path.join(SCHEMATICS_DIR, "schems/pack1");
  const { groups } = JSON.parse(await readFile(path.join(directory, "index.json"), "utf8"));
  const files = Object.values(groups).flatMap(ids => Object.values(ids)).sort();
  assert.equal(files.length, 30);
  const registry = require("minecraft-data")("26.1");
  assert.equal(registry.version.minecraftVersion, "26.1");
  assert.equal(registry.version.dataVersion, 4786);
  assert.equal(registry.blocksByName.chain, undefined);
  assert.ok(registry.blocksByName.iron_chain);
  const unsupported = [];
  for (const filename of files) {
    const source = await readFile(path.join(directory, filename.replace(/\.schem$/, ".mc1.21.4.schem")));
    const original = Buffer.from(source);
    const blueprint = JSON.parse(await readFile(path.join(SCHEMATICS_DIR, "blueprints/pack1", filename.replace(/\.schem$/, ".json")), "utf8"));
    assert.equal(blueprint.minecraft_version, "1.21.4");
    assert.equal(blueprint.data_version, 4189);
    const parsed = await readSchematic(source, "26.1", undefined, registry);
    assert.deepEqual([parsed.size.x, parsed.size.y, parsed.size.z], [blueprint.width_x, blueprint.height_y, blueprint.length_z]);
    assert.deepEqual(source, original, `${filename} source bytes must remain canonical`);
    try {
      const build = createModernBuild(parsed, { version: "26.1", registry }, new Vec3(0, 64, 0));
      const nonAir = Object.entries(blueprint.expected_counts).reduce((sum, [state, count]) => sum + (state === "minecraft:air" ? 0 : count), 0);
      assert.equal(build.plan.length, nonAir, filename);
    } catch (error) {
      assert.match(error.message, /no placeable item mapping for potted_(oak_sapling|fern)|full physics footprint cannot be safely proven/);
      unsupported.push({ filename, error: error.message });
    }
  }
  assert.ok(unsupported.some(entry => entry.filename === "01_wardrobe_nether_portal.schem" && /physics footprint/.test(entry.error)));
  assert.deepEqual(unsupported.map(entry => entry.filename).sort(), unsupportedCanonical);
  console.log("PACK1_26_1_PREFLIGHT " + JSON.stringify({ passed: files.length - unsupported.length, unsupported }));
});

test("production reader and planner preserve migrated bee-chain items before delicate rejects unsupported targets", async () => {
  const registry = require("minecraft-data")("26.1");
  const world = new Map();
  const key = ({ x, y, z }) => `${x},${y},${z}`;
  const logs = [];
  const bot = Object.assign(new EventEmitter(), {
    version: "26.1",
    registry,
    game: { gameMode: "survival", dimension: "overworld" },
    world: {},
    _client: Object.assign(new EventEmitter(), { ended: false, socket: { destroyed: false } }),
    entity: { position: new Vec3(0, 64, 0) },
    blockAt(position) {
      return world.get(key(position)) ?? { name: "air", stateId: registry.blocksByName.air.defaultState, getProperties: () => ({}) };
    },
  });
  let plannedBuild;
  let mutations = 0;
  const success = await buildSchematic(bot, "pack1:2:1", 100, 64, -20, {
    makeBuild: (schematic, candidate, origin) => (plannedBuild = createModernBuild(schematic, candidate, origin)),
    changeGameMode: () => { mutations++; return true; },
    startSupply: () => { mutations++; },
    executeBuild: () => { mutations++; },
    writeLog: message => logs.push(message),
  });
  assert.equal(success, false, logs.join("\n"));
  assert.doesNotMatch(logs.join("\n"), /WARNING: schematic validation status HISTORICAL_UNKNOWN/);
  assert.equal(plannedBuild.plan.filter(entry => entry.name === "iron_chain").length, 24);
  for (const action of plannedBuild.actions.filter(entry => entry.blockName === "iron_chain")) {
    assert.equal(plannedBuild.items[action.state].name, "iron_chain");
    assert.deepEqual(action.properties, { axis: "y", waterlogged: false });
  }
  assert.match(logs.join("\n"), /unsupported balanced target/i);
  assert.equal(mutations, 0);
  assert.equal(bot.game.gameMode, "survival");
});

test("real listing and public wardrobe selectors reach preflight and fail closed for multi-block doors", () => {
  const script = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { executeCommand, getCommand } from './src/agent/commands/index.js';
    import { buildSchematic } from './src/utils/schematic/build_schematic.js';
    const listing = await getCommand('!listSchematics').perform({ bot: { version: '1.21.4' } });
    assert.match(listing, /- pack1 \\| group 1 \\| file id 1 \\| file name 01_wardrobe_nether_portal\\.mc1\\.21\\.4\\.schem/);
    assert.match(listing, /- pack1 \\| group 2 \\| file id 1 \\| file name 02_bee_hot_air_balloon\\.mc1\\.21\\.4\\.schem/);
    assert.match(listing, /validation HISTORICAL_UNKNOWN \\(WARNING: legal combinations not proven\\)/);
    assert.equal(listing.split('\\n').filter(line => line.startsWith('- pack1 |')).length, 60);
    let completed = 0;
    globalThis.__schematicBuild = async (bot, selector, x, y, z) => {
      const world = new Map();
      const logs = [];
      const modes = [];
      bot.blockAt = position => world.get([position.x, position.y, position.z].join(',')) || {
        name: 'air', diggable: false, position, getProperties: () => ({}),
      };
      bot.dig = async () => {};
      bot.placeBlock = async () => {};
      bot.pathfinder = {
        movements: { canDig: true, allow1by1towers: true, scafoldingBlocks: [1] },
        setMovements(movements) { this.movements = movements; },
      };
      const success = await buildSchematic(bot, selector, x, y, z, {
        changeGameMode: async (_bot, mode) => { modes.push(mode); return true; },
        startSupply: () => () => {},
        executeBuild: async () => { throw new Error('must not execute unsupported wardrobe'); },
        writeLog: message => logs.push(message),
      });
      assert.equal(success, false, logs.join('\\n'));
      assert.match(logs.join('\\n'), /dark_oak_door.*full physics footprint cannot be safely proven/);
      assert.deepEqual(modes, []);
      completed++;
    };
    for (const selector of ['01:01', '1:1', '01_wardrobe_nether_portal', '01_wardrobe_nether_portal.schem']) {
      const bot = Object.assign(new EventEmitter(), {
        version: '1.21.4',
        game: { gameMode: 'survival', dimension: 'overworld' },
        world: {},
        _client: Object.assign(new EventEmitter(), { ended: false, socket: { destroyed: false } }),
        entity: { position: { distanceTo: () => 0 } },
      });
      const agent = { bot, actions: { runAction: async (_name, fn) => { await fn(); return { message: 'completed' }; } } };
      await executeCommand(agent, '!buildSchematic("pack1:' + selector + '", 100, 64, -20)');
    }
    assert.equal(completed, 4);
    console.log('REAL_PACK_INTEGRATION_PASS');
  `;
  const child = spawnSync(process.execPath, [
    "--experimental-loader", fileURLToPath(new URL("../commands-loader.js", import.meta.url)),
    "--input-type=module", "-e", script,
  ], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: { ...process.env, MINDCRAFT_REAL_SCHEMATIC_PATHS: "1" },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /REAL_PACK_INTEGRATION_PASS/);
});
