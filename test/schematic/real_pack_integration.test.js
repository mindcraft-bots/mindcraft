import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SCHEMATICS_DIR, listSchematicEntries, resolveSchematicPath } from "../../src/utils/schematic/paths.js";
import { readSchematic } from "../../src/utils/schematic/reader.js";
import { createModernBuild } from "../../src/utils/schematic/modern_build.js";

const require = createRequire(import.meta.url);
const Vec3 = require("vec3");

test("every real pack1 asset is listed with its manifest ID and resolves by ID, stem, and filename", async () => {
  const directory = path.join(SCHEMATICS_DIR, "schems/pack1");
  const { ids } = JSON.parse(await readFile(path.join(directory, "index.json"), "utf8"));
  const files = (await readdir(directory)).filter(name => name.endsWith(".schem")).sort();
  assert.equal(files.length, 30);
  assert.deepEqual(Object.values(ids).sort(), files);
  const entries = (await listSchematicEntries()).filter(entry => entry.pack === "pack1");
  assert.equal(entries.length, files.length);
  const unsupported = [];
  for (const [id, filename] of Object.entries(ids)) {
    const [group, fileId] = id.split("-");
    assert.deepEqual(entries.find(entry => entry.id === id), { pack: "pack1", id, group, fileId, filename });
    const expected = path.join(directory, filename);
    for (const selector of [`${group}:${fileId}`, filename, path.basename(filename, ".schem")]) {
      assert.equal(await resolveSchematicPath(`pack1:${selector}`), expected);
    }
    await assert.rejects(resolveSchematicPath(`pack1:${id}`), /Dash-form schematic IDs are unsupported/);
    const blueprint = JSON.parse(await readFile(path.join(SCHEMATICS_DIR, "blueprints/pack1", filename.replace(/\.schem$/, ".json")), "utf8"));
    const parsed = await readSchematic(await readFile(expected), blueprint.minecraft_version);
    assert.deepEqual([parsed.size.x, parsed.size.y, parsed.size.z], [blueprint.width_x, blueprint.height_y, blueprint.length_z]);
    let build;
    try {
      build = createModernBuild(parsed, { version: blueprint.minecraft_version }, new Vec3(0, 64, 0));
    } catch (error) {
      assert.match(error.message, /no placeable item mapping for potted_(oak_sapling|fern)/);
      unsupported.push({ id, filename, error: error.message });
      continue;
    }
    const nonAir = Object.entries(blueprint.expected_counts).reduce((sum, [state, count]) => sum + (state === "minecraft:air" ? 0 : count), 0);
    assert.equal(build.plan.length, nonAir);
  }
  assert.deepEqual(unsupported.map(entry => entry.filename).sort(), ["04_pagoda.schem", "18_giant_grandfather_clock.schem"]);
  console.log("PACK1_BUILD_PREFLIGHT " + JSON.stringify({ passed: files.length - unsupported.length, unsupported }));
});

test("real listing query and parsed README selectors reach the real wardrobe reader/build plan (simulated world only)", () => {
  const script = `
    import assert from 'node:assert/strict';
    import { executeCommand, getCommand } from './src/agent/commands/index.js';
    import { buildSchematic } from './src/utils/schematic/build_schematic.js';
    const listing = await getCommand('!listSchematics').perform({});
    assert.match(listing, /- pack1 \\| group 01 \\| file ID 01 \\| 01_wardrobe_nether_portal\\.schem/);
    assert.match(listing, /- pack1 \\| group 02 \\| file ID 01 \\| 02_bee_hot_air_balloon\\.schem/);
    assert.equal(listing.split('\\n').filter(line => line.startsWith('- pack1 |')).length, 30);
    let completed = 0;
    globalThis.__schematicBuild = async (bot, selector, x, y, z) => {
      const world = new Map();
      const logs = [];
      const modes = [];
      bot.blockAt = position => world.get([position.x, position.y, position.z].join(','));
      const success = await buildSchematic(bot, selector, x, y, z, {
        changeGameMode: async (_bot, mode) => { modes.push(mode); return true; },
        startSupply: () => () => {},
        executeBuild: async (_bot, build) => {
          assert.deepEqual(build.dimensions, { width: 6, height: 7, length: 4 });
          assert.equal(build.plan.length, 90);
          for (const entry of build.plan) world.set([entry.position.x, entry.position.y, entry.position.z].join(','), {
            name: entry.name, getProperties: () => entry.properties,
          });
          return { status: 'finished', errors: [] };
        },
        writeLog: message => logs.push(message),
      });
      assert.equal(success, true, logs.join('\\n'));
      assert.deepEqual(modes, ['creative', 'survival']);
      completed++;
    };
    for (const selector of ['01:01', '1:1', '01_wardrobe_nether_portal', '01_wardrobe_nether_portal.schem']) {
      const bot = { version: '1.21.4', game: { gameMode: 'survival' } };
      const agent = { bot, actions: { runAction: async (_name, fn) => { await fn(); return { message: 'completed' }; } } };
      await executeCommand(agent, '!buildSchematic("pack1:' + selector + '", 100, 64, -20)');
    }
    assert.equal(completed, 4);
    console.log('REAL_PACK_INTEGRATION_PASS');
  `;
  const child = spawnSync(process.execPath, [
    "--experimental-loader", fileURLToPath(new URL("./commands-loader.js", import.meta.url)),
    "--input-type=module", "-e", script,
  ], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, MINDCRAFT_REAL_SCHEMATIC_PATHS: "1" },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /REAL_PACK_INTEGRATION_PASS/);
});
