import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import minecraftData from "minecraft-data";
import { SCHEMATICS_DIR, listSchematicEntries, resolveSchematicPath } from "../../src/utils/schematic/paths.js";
import { buildSchematic } from "../../src/utils/schematic/build_schematic.js";
import { readSchematic } from "../../src/utils/schematic/reader.js";

const source = path.join(SCHEMATICS_DIR, "schems/pack1/02_bee_hot_air_balloon.schem");
const opts = (version) => ({ version });

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "schematic-versions-"));
  const pack = path.join(root, "schems/pack1");
  await mkdir(pack, { recursive: true });
  try { await run(root, pack); } finally { await rm(root, { recursive: true, force: true }); }
}

async function manifest(pack, groups) {
  await writeFile(path.join(pack, "index.json"), JSON.stringify({ schemaVersion: 2, groups }));
}

test("selects by release DataVersion, including gaps and registry aliases, and lists picks", async () => {
  await fixture(async (root, pack) => {
    await copyFile(source, path.join(pack, "balloon.schem"));
    for (const version of ["1.21.4", "1.21.9", "1.21.10", "26.1"]) {
      await writeFile(path.join(pack, `balloon.mc${version}.schem`), "compiled variant");
    }
    await manifest(pack, { 2: { 1: "balloon.schem" } });
    const resolve = (selector, version) => resolveSchematicPath(selector, root, opts(version));
    for (const [engine, expected] of [["1.21.4", "1.21.4"], ["1.21.8", "1.21.4"], ["1.21.9", "1.21.9"], ["1.21.10", "1.21.10"], ["26.1.1", "26.1"], ["26.3", "26.1"]]) {
      assert.equal(await resolve("pack1:2:1", engine), path.join(pack, `balloon.mc${expected}.schem`));
    }
    assert.equal(minecraftData("1.21.10").version.minecraftVersion, "1.21.9");
    assert.equal(minecraftData("26.1.1").version.minecraftVersion, "26.1");
    for (const selector of ["pack1:balloon", "pack1:balloon.schem", "schems/pack1/balloon.schem"]) {
      assert.equal(await resolve(selector, "26.1"), path.join(pack, "balloon.mc26.1.schem"));
    }
    await assert.rejects(resolve("pack1:balloon.SCHEM", "26.1"), /No schematic named/);
    await writeFile(path.join(pack, "balloon.SCHEM"), "unrelated uppercase asset");
    await assert.rejects(resolve("pack1:balloon.SCHEM", "26.1"), /No compatible/);
    await assert.rejects(resolve("schems/pack1/balloon.SCHEM", "26.1"), /No compatible/);
    assert.equal(await resolve("pack1:balloon.mc1.21.4.schem", "26.1"), path.join(pack, "balloon.mc1.21.4.schem"));
    await assert.rejects(resolve("pack1:balloon.mc26.1.schem", "1.21.4"), /No compatible/);
    await assert.rejects(resolve("pack1:2:1", "1.20.6"), /No compatible/);
    await assert.rejects(resolve("pack1:2:1", "1.16.5"), /No compatible/);
    await assert.rejects(resolve("pack1:2:1", "not-a-release"), /Unknown Minecraft engine/);
    const entries = (await listSchematicEntries(root, opts("1.21.10"))).filter(x => x.fileId === 1);
    assert.equal(entries.length, 5);
    assert.equal(entries.find(x => x.selected).fileName, "balloon.mc1.21.10.schem");
    assert.equal(entries.find(x => x.fileName.endsWith("mc26.1.schem")).compatible, false);
    assert.ok(entries.every(x => x.selector === "pack1:2:1"));
  });
});

test("unversioned bases require a known embedded release and arbitrary selectors remain usable", async () => {
  await fixture(async (root, pack) => {
    await copyFile(source, path.join(pack, "custom.schem"));
    await writeFile(path.join(pack, "unknown.schem"), "not nbt");
    await writeFile(path.join(pack, "unknown.SCHEM"), "not nbt");
    await writeFile(path.join(pack, "other.schematic"), "other format");
    await manifest(pack, {});
    assert.equal(await resolveSchematicPath("pack1:custom", root, opts("26.1")), path.join(pack, "custom.schem"));
    await assert.rejects(resolveSchematicPath("pack1:custom", root, opts("1.20.6")), /No compatible/);
    await assert.rejects(resolveSchematicPath("pack1:unknown.schem", root, opts("26.1")), /No compatible/);
    await assert.rejects(resolveSchematicPath("pack1:unknown.SCHEM", root, opts("26.1")), /No compatible/);
    assert.equal(await resolveSchematicPath("pack1:other", root, opts("26.1")), path.join(pack, "other.schematic"));
    await writeFile(path.join(pack, "custom.schematic"), "other");
    await assert.rejects(resolveSchematicPath("pack1:custom", root, opts("26.1")), /Ambiguous/);
    assert.equal(await resolveSchematicPath("pack1:custom.schem", root, opts("26.1")), path.join(pack, "custom.schem"));
    await writeFile(path.join(pack, "variant-only.mc26.1.schem"), "variant");
    assert.equal(await resolveSchematicPath("pack1:variant-only", root, opts("26.1")), path.join(pack, "variant-only.mc26.1.schem"));
    await assert.rejects(resolveSchematicPath("pack1:variant-only", root, opts("1.21.4")), /No compatible/);
    await writeFile(path.join(pack, "old.mc1.16.5.schem"), "older variant");
    assert.equal(await resolveSchematicPath("pack1:old", root, opts("1.16.5")), path.join(pack, "old.mc1.16.5.schem"));
    await writeFile(path.join(pack, "variant-only.schematic"), "other format");
    await assert.rejects(resolveSchematicPath("pack1:variant-only", root, opts("26.1")), /Ambiguous/);
  });
});

test("manifest ownership, extension matching, duplicate mappings, and traversal fail safely", async () => {
  await fixture(async (root, pack) => {
    await copyFile(source, path.join(pack, "one.schem"));
    await copyFile(source, path.join(pack, "two.schem"));
    await writeFile(path.join(pack, "one.mc26.1.schem"), "belongs to another ID");
    await writeFile(path.join(pack, "one-extra.mc26.1.schem"), "different stem");
    await writeFile(path.join(pack, "one.mc26.1.schematic"), "different extension");
    await manifest(pack, { 1: { 1: "one.schem", 2: "one.mc26.1.schem", 3: "two.schem" } });
    assert.equal(await resolveSchematicPath("pack1:1:1", root, opts("26.1")), path.join(pack, "one.schem"));
    assert.equal(await resolveSchematicPath("pack1:1:2", root, opts("26.1")), path.join(pack, "one.mc26.1.schem"));
    const entries = await listSchematicEntries(root, opts("26.1"));
    assert.equal(entries.find(x => x.fileId === 1).fileName, "one.schem");
    assert.equal(entries.find(x => x.fileId === 1).selected, true);
    assert.equal(entries.find(x => x.fileId === 2).selected, true);
    for (const selector of ["pack1:../one.schem", "../outside.schem", "pack1:..\\outside.schem"]) {
      await assert.rejects(resolveSchematicPath(selector, root, opts("26.1")));
    }
    await manifest(pack, { 1: { 1: "one.schem", 2: "one.schem" } });
    await assert.rejects(resolveSchematicPath("pack1:1:1", root, opts("26.1")), /multiple tuples/);
    await manifest(pack, { 1: { 1: "one.schem" } });
    await rm(path.join(pack, "one.mc26.1.schem"));
    await symlink(source, path.join(pack, "one.mc26.1.schem"));
    assert.equal(await resolveSchematicPath("pack1:1:1", root, opts("26.1")), path.join(pack, "one.schem"));
  });
});

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
      assert.ok(text.includes('SCHEMATICS (Minecraft ' + version + ')'));
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

test("real bee blueprint builds the compiler's selected native and chain-converted variants", async () => {
  await fixture(async (root, pack) => {
    const base = path.join(pack, "02_bee_hot_air_balloon.schem");
    await copyFile(source, base);
    await manifest(pack, { 2: { 1: path.basename(base) } });
    const compiler = path.join(SCHEMATICS_DIR, "tooling/compile_blueprint.py");
    const blueprint = path.join(SCHEMATICS_DIR, "blueprints/pack1/02_bee_hot_air_balloon.json");
    for (const version of ["1.21.4", "26.1"]) {
      const result = spawnSync("python3", [compiler, "compile", blueprint, base, "--convert-to", version], { encoding: "utf8" });
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
        resolvePath: async (selector, _directory, options) => (selected = await resolveSchematicPath(selector, root, options)),
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
      assert.equal(selected, path.join(pack, `02_bee_hot_air_balloon.mc${version}.schem`));
    }
    assert.deepEqual(await readFile(base), canonical);
  });
});
