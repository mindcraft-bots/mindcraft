import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import minecraftData from "minecraft-data";
import nbt from "prismarine-nbt";
import { SCHEMATICS_DIR, listSchematicEntries, listSchematics, resolveSchematicPath, conservativeBotVersion } from "../../../src/utils/schematic/paths.js";
import { buildSchematic } from "../../../src/utils/schematic/build_schematic.js";
import { readSchematic } from "../../../src/utils/schematic/reader.js";

const source = path.join(SCHEMATICS_DIR, "schems/pack1/02_bee_hot_air_balloon.mc1.21.4.schem");
const opts = (version) => ({ version, allowNonvalidatedSchematic: true });
const blueprint = path.join(SCHEMATICS_DIR, "blueprints/pack1/02_bee_hot_air_balloon.json");
const sha = data => createHash("sha256").update(data).digest("hex");

// Exercise the real provenance gate for synthetic version-selection fixtures.
async function syntheticArtifact(file, version = null) {
  const { parsed } = await nbt.parse(await readFile(source));
  if (version) parsed.value.DataVersion.value = minecraftData.versions.pc.find(v => v.minecraftVersion === version).dataVersion;
  const bytes = gzipSync(nbt.writeUncompressed(parsed));
  await writeFile(file, bytes);
  const report = JSON.stringify({ schemaVersion: 1, artifact: path.basename(file), sha256: sha(bytes),
    validation: "NONVALIDATED", blueprint: "schematics/blueprints/pack1/02_bee_hot_air_balloon.json",
    blueprintSha256: sha(await readFile(blueprint)), targetVersion: null, convertTo: null, packReport: null, packReportSha256: null });
  await writeFile(`${file}.provenance.json`, report);
  await writeFile(`${file}.provenance.sha256`, `${sha(Buffer.from(report))}\n`);
}

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "schematic-versions-"));
  const pack = path.join(root, "schems/pack1");
  await mkdir(pack, { recursive: true });
  try { await run(root, pack); } finally { await rm(root, { recursive: true, force: true }); }
}

async function manifest(pack, groups) {
  await writeFile(path.join(pack, "index.json"), JSON.stringify({ schemaVersion: 2, groups }));
}

test("real listing command reports engine, version, selector, and selected file", () => {
  const projectRoot = path.dirname(SCHEMATICS_DIR);
  const loader = path.join(projectRoot, "test/schematic/commands-loader.js");
  const script = `
    import assert from 'node:assert/strict';
    const { getCommand } = await import('./src/agent/commands/index.js');
    for (const [version, expected] of [
      ['1.21.4', /group 2 \\| file id 1 \\| file name 02_bee_hot_air_balloon\\.mc1\\.21\\.4\\.schem \\| selector pack1:2:1 \\| version 1\\.21\\.4 \\| compatible, selected/],
      ['26.1', /group 2 \\| file id 1 \\| file name 02_bee_hot_air_balloon\\.mc26\\.1\\.schem \\| selector pack1:2:1 \\| version 26\\.1 \\| compatible, selected/],
    ]) {
      const text = await getCommand('!listSchematics').perform({ bot: { version } });
      assert.ok(text.includes('SCHEMATICS (Minecraft ' + version + ','));
      assert.match(text, expected);
    }
  `;
  const result = spawnSync(process.execPath, ["--experimental-loader", loader, "--input-type=module", "-e", script],
    { cwd: projectRoot, encoding: "utf8", env: { ...process.env, MINDCRAFT_REAL_SCHEMATIC_PATHS: "1" } });
  assert.equal(result.status, 0, result.stderr);
});

test("real pack selects and reads the native bee variant for each engine", async () => {
  for (const version of ["1.21.4", "26.1"]) {
    const selected = await resolveSchematicPath("pack1:2:1", SCHEMATICS_DIR, opts(version));
    assert.equal(path.basename(selected), `02_bee_hot_air_balloon.mc${version}.schem`);
    const parsed = await readSchematic(await readFile(selected), version);
    assert.ok(parsed.size.x > 0 && parsed.size.y > 0 && parsed.size.z > 0);
  }
});

test("real bee blueprint mock-builds explicitly selected nonvalidated variants", async () => {
  await fixture(async (root, pack) => {
    const base = path.join(pack, "02_bee_hot_air_balloon.schem");
    await copyFile(source, base);
    await manifest(pack, { 2: { 1: path.basename(base) } });
    const compiler = path.join(SCHEMATICS_DIR, "tooling/compile_blueprint.py");
    const blueprint = path.join(SCHEMATICS_DIR, "blueprints/pack1/02_bee_hot_air_balloon.json");
    for (const version of ["1.21.4", "26.1"]) {
      const result = spawnSync("python3", [compiler, "compile", blueprint, base, "--convert-to", version, "--allow-unverified"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const canonical = await readFile(source);
    for (const [version, chain] of [["1.21.4", "chain"], ["26.1", "iron_chain"]]) {
      const world = new Map();
      const key = p => `${p.x},${p.y},${p.z}`;
      const bot = Object.assign(new EventEmitter(), { version, registry: minecraftData(version),
        game: { gameMode: "survival", dimension: "overworld" }, entity: {}, world: {}, _client: new EventEmitter(),
        blockAt: p => world.get(key(p)) ?? { name: "air", getProperties: () => ({}) } });
      const logs = [];
      let selected;
      const success = await buildSchematic(bot, "pack1:2:1", 100, 64, -20, {
        allowNonvalidatedSchematic: true,
        resolvePath: async (_selector, _directory, options) => (selected = await resolveSchematicPath(
          `pack1:02_bee_hot_air_balloon.mc${version}.nonvalidated.schem`, root, options)),
        changeGameMode: async (_bot, mode) => { bot.game.gameMode = mode; return true; },
        clearObstructions: async () => ({ cleared: 0 }),
        guardDestruction: async (_bot, _build, _Vec3, run) => run(),
        startSupply: () => async () => {},
        executeBuild: async (_bot, build) => {
          assert.equal(build.plan.filter(entry => entry.name === chain).length, 24);
          for (const entry of build.plan) world.set(key(entry.position), { name: entry.name, getProperties: () => entry.properties });
          return { status: "finished", errors: [] };
        },
        writeLog: message => logs.push(message),
      });
      assert.equal(success, true, logs.join("\n"));
      assert.equal(selected, path.join(pack, `02_bee_hot_air_balloon.mc${version}.nonvalidated.schem`));
    }
    assert.deepEqual(await readFile(base), canonical);
  });
});

