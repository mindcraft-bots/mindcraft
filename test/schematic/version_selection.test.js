import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import minecraftData from "minecraft-data";
import nbt from "prismarine-nbt";
import { SCHEMATICS_DIR, listSchematicEntries, listSchematics, resolveSchematicPath, conservativeBotVersion } from "../../src/utils/schematic/paths.js";
import { buildSchematic } from "../../src/utils/schematic/build_schematic.js";
import { createModernBuild } from "../../src/utils/schematic/modern_build.js";
import { readSchematic } from "../../src/utils/schematic/reader.js";

import { syntheticSponge } from "./synthetic_sponge.js";
import { fixtureBlueprint, writeFixtureProvenance } from "./provenance_fixture.js";
const opts = (version) => ({ version, allowNonvalidatedSchematic: true });
const sha = data => createHash("sha256").update(data).digest("hex");

// Exercise the real provenance gate for synthetic version-selection fixtures.
async function syntheticArtifact(file, version = null) {
  const bytes = syntheticSponge(version || "1.21.4");
  await writeFile(file, bytes);
  writeFixtureProvenance(file, bytes);
}

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "schematic-versions-"));
  const pack = path.join(root, "schems/pack3");
  await mkdir(pack, { recursive: true });
  try { await run(root, pack); } finally { await rm(root, { recursive: true, force: true }); }
}

async function manifest(pack, groups) {
  await writeFile(path.join(pack, "index.json"), JSON.stringify({ schemaVersion: 2, groups }));
}

test("synthetic pack3 selects and plans 1.21.4 and 26.1 chain derivatives before delicate rejects them", async () => {
  await fixture(async (root, pack) => {
    await manifest(pack, { 8: { 13: "observatory.schem" } });
    const base = path.join(pack, "observatory.schem");
    const compiler = path.join(SCHEMATICS_DIR, "tooling/compile_blueprint.py");
    for (const [version, chain] of [["1.21.4", "chain"], ["26.1", "iron_chain"]]) {
      const result = spawnSync(process.env.HISTORY_TEST_PYTHON || "python3", [compiler, "compile",
        path.join(path.dirname(SCHEMATICS_DIR), fixtureBlueprint), base, "--convert-to", version, "--allow-unverified"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const bot = Object.assign(new EventEmitter(), { version, registry: minecraftData(version),
        game: { gameMode: "survival", dimension: "overworld" }, entity: {}, world: {}, _client: new EventEmitter(),
        blockAt: () => ({ name: "air", stateId: 0, getProperties: () => ({}) }) });
      const logs = [];
      let plannedBuild, mutations = 0;
      const success = await buildSchematic(bot, "pack3:8:13", 0, 64, 0, {
        allowNonvalidatedSchematic: true,
        resolvePath: (_selector, _directory, options) => resolveSchematicPath(`pack3:observatory.mc${version}.nonvalidated.schem`, root, options),
        makeBuild: (schematic, candidate, origin) => (plannedBuild = createModernBuild(schematic, candidate, origin)),
        changeGameMode: () => { mutations++; },
        startSupply: () => { mutations++; },
        executeBuild: () => { mutations++; },
        writeLog: message => logs.push(message),
      });
      assert.equal(success, false, logs.join("\n"));
      assert.equal(plannedBuild.plan.filter(entry => entry.name === chain).length, 1);
      assert.match(logs.join("\n"), /unsupported balanced target/i);
      assert.equal(mutations, 0);
    }
  });
});

test("family aliases select exact or highest lower version without an original", async () => {
  await fixture(async (root, pack) => {
    for (const version of ["1.21.4", "1.21.9", "1.21.10", "26.1"]) await syntheticArtifact(path.join(pack, `balloon.mc${version}.schem`), version);
    await manifest(pack, { 2: { 1: "balloon.schem", 2: "missing.schem" } });
    const resolve = (selector, version) => resolveSchematicPath(selector, root, opts(version));
    for (const [engine, expected] of [["1.21.4", "1.21.4"], ["1.21.8", "1.21.4"], ["1.21.9", "1.21.9"], ["1.21.10", "1.21.10"], ["26.1.1", "26.1"]]) {
      for (const selector of ["pack3:2:1", "pack3:balloon", "pack3:balloon.schem", "schems/pack3/balloon.schem"]) {
        assert.equal(await resolve(selector, engine), path.join(pack, `balloon.mc${expected}.schem`));
      }
    }
    assert.equal(await resolve("pack3:balloon.mc1.21.4.schem", "26.1"), path.join(pack, "balloon.mc1.21.4.schem"));
    await assert.rejects(resolve("pack3:balloon.mc26.1.schem", "1.21.4"), /No compatible/);
    for (const engine of ["1.20.6", "unknown", "24w14a", undefined]) await assert.rejects(resolve("pack3:2:1", engine));
    await assert.rejects(resolve("pack3:2:2", "26.1"), /No compatible/);
    const entries = await listSchematicEntries(root, opts("1.21.10"));
    assert.equal(entries.length, 4);
    assert.equal(entries.find(x => x.selected).fileName, "balloon.mc1.21.10.schem");
    assert.ok(entries.every(x => x.selector === "pack3:2:1"));
  });
});

test("original-only, bad metadata, unknown engines, absent options and other formats never select", async () => {
  await fixture(async (root, pack) => {
    await syntheticArtifact(path.join(pack, "only.schem"), "1.21.4");
    await syntheticArtifact(path.join(pack, "bad.mc1.21.4.schem"), "1.21.9");
    await syntheticArtifact(path.join(pack, "future.mc26.1.schem"), "26.1");
    await syntheticArtifact(path.join(pack, "other.schematic"), "1.21.4");
    await manifest(pack, { 1: { 1: "only.schem", 2: "bad.schem", 3: "future.schem" } });
    for (const selector of ["pack3:1:1", "pack3:only", "pack3:only.schem", "schems/pack3/only.schem", "pack3:bad", "pack3:bad.mc1.21.4.schem", "pack3:future", "pack3:other.schematic", "schems/pack3/other.schematic"]) {
      await assert.rejects(resolveSchematicPath(selector, root, opts("1.21.4")), undefined, selector);
    }
    for (const selector of ["pack3:1:1", "schems/pack3/only.schem"]) await assert.rejects(resolveSchematicPath(selector, root), /Unknown Minecraft engine/);
    await assert.rejects(listSchematicEntries(root), /Unknown Minecraft engine/);
    await assert.rejects(listSchematics(root), /Unknown Minecraft engine/);
    assert.equal((await listSchematicEntries(root, opts("1.21.4"))).some(x => x.selected), false);
    assert.equal(conservativeBotVersion({ version: "1.21.10" }), "1.21.9");
    assert.equal(conservativeBotVersion({ version: "26.1.2" }), "26.1");
    assert.equal(conservativeBotVersion({ version: "24w14a" }), undefined);
    assert.equal(conservativeBotVersion({ version: "1.21.4", _client: { version: "24w14a" } }), undefined);
  });
});

test("provenance policy, exact ownership, symlinks and traversal fail closed", async () => {
  await fixture(async (root, pack) => {
    await syntheticArtifact(path.join(pack, "one.mc1.21.4.schem"), "1.21.4");
    await syntheticArtifact(path.join(pack, "one.mc26.1.schem"), "26.1");
    await manifest(pack, { 1: { 1: "one.schem", 2: "one.mc26.1.schem" } });
    assert.equal(await resolveSchematicPath("pack3:1:1", root, opts("26.1")), path.join(pack, "one.mc1.21.4.schem"));
    assert.equal(await resolveSchematicPath("pack3:1:2", root, opts("26.1")), path.join(pack, "one.mc26.1.schem"));
    await assert.rejects(resolveSchematicPath("pack3:one", root, { version: "26.1" }), /No compatible/);
    await assert.rejects(resolveSchematicPath("pack3:one", root, { ...opts("26.1"), requireStrictSchematicValidation: true }), /No compatible/);
    await assert.rejects(resolveSchematicPath("schems/pack3/one.mc26.1.schem", root, { version: "26.1" }), /No compatible/);
    for (const selector of ["pack3:../one.schem", "../outside.schem", "schems/pack3/../pack3/one.schem", "pack3:..\\outside.schem"]) await assert.rejects(resolveSchematicPath(selector, root, opts("26.1")));
    await manifest(pack, { 1: { 1: "one.schem" } });
    await rm(path.join(pack, "one.mc26.1.schem"));
    await symlink(path.join(pack, "one.mc1.21.4.schem"), path.join(pack, "one.mc26.1.schem"));
    assert.equal(await resolveSchematicPath("pack3:1:1", root, opts("26.1")), path.join(pack, "one.mc1.21.4.schem"));
    await rm(path.join(pack, "one.mc1.21.4.schem"));
    await assert.rejects(resolveSchematicPath("pack3:1:1", root, opts("26.1")), /No compatible/);
    await symlink(pack, path.join(root, "schems/pack4"));
    await assert.rejects(resolveSchematicPath("pack4:1:1", root, opts("26.1")), /Symlinked schematic pack/);
    await rm(path.join(pack, "index.json"));
    await writeFile(path.join(pack, "other-index.json"), JSON.stringify({ schemaVersion: 2, groups: {} }));
    await symlink(path.join(pack, "other-index.json"), path.join(pack, "index.json"));
    await assert.rejects(resolveSchematicPath("pack3:one", root, opts("26.1")), /Symlinked schematic pack index/);
  });
});

test("recovery cancels legacy sessions, changed assets, changed family picks and revoked consent", async () => {
  await fixture(async (root, pack) => {
    const older = path.join(pack, "recover.mc1.21.4.schem");
    const newer = path.join(pack, "recover.mc1.21.9.schem");
    await syntheticArtifact(older, "1.21.4");
    await manifest(pack, { 1: { 1: "recover.schem" } });
    const bot = Object.assign(new EventEmitter(), { version: "1.21.9", registry: minecraftData("1.21.9"),
      game: { dimension: "overworld" }, world: {}, entity: {}, _client: new EventEmitter() });
    const logs = [];
    const dependencies = { allowNonvalidatedSchematic: true, writeLog: message => logs.push(message),
      resolvePath: (selector, _dir, options) => resolveSchematicPath(selector, root, options) };
    const makeSession = async (resolvedPath = older) => ({ cancelled: false, resumeEligible: true, context: {
      planContract: 'rotated-local-v1', placementOptions: { mode: 'delicate', radius: 4, threshold: 9, orientation: 'north' }, selector: "pack3:1:1", resolvedPath, source: await readFile(older), schematic: {}, origin: { x: 0, y: 0, z: 0 },
    } });
    const legacy = await makeSession(path.join(pack, "recover.schem"));
    assert.equal(await buildSchematic(bot, "pack3:1:1", null, null, null, { ...dependencies, resumeSession: legacy }), false);
    assert.equal(legacy.cancelled, true);
    assert.match(logs.at(-1), /unversioned/);
    const revoked = await makeSession();
    assert.equal(await buildSchematic(bot, "pack3:1:1", null, null, null, { ...dependencies, allowNonvalidatedSchematic: false, resumeSession: revoked }), false);
    assert.equal(revoked.cancelled, true);
    const modified = await makeSession();
    modified.context.source = Buffer.from("outdated bytes");
    assert.equal(await buildSchematic(bot, "pack3:1:1", null, null, null, { ...dependencies, resumeSession: modified }), false);
    assert.match(logs.at(-1), /not an eligible unmodified session/);
    const changed = await makeSession();
    await syntheticArtifact(newer, "1.21.9");
    assert.equal(await buildSchematic(bot, "pack3:1:1", null, null, null, { ...dependencies, resumeSession: changed }), false);
    assert.equal(changed.cancelled, true);
    assert.match(logs.at(-1), /not an eligible unmodified session/);
  });
});
