import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Vec3 } from "vec3";
import { convertBlueprint, validateHistory } from "../../schematics/tooling/convert_history.mjs";
import { resolveSchematicPath } from "../../src/utils/schematic/paths.js";
import { readSchematic } from "../../src/utils/schematic/reader.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const compiler = path.join(root, "schematics/tooling/compile_blueprint.py");
const packScript = path.join(root, "schematics/tooling/compile_pack.sh");
const history = JSON.parse(await readFile(path.join(root, "schematics/tooling/block_history.v1.json"), "utf8"));
const clone = (value) => structuredClone(value);
const run = (cmd, args) => spawnSync(cmd, args, { cwd: os.tmpdir(), encoding: "utf8" });
const opt = { allowUnverified: true };
const chain = "minecraft:chain[axis=x,waterlogged=true]";
const iron = "minecraft:iron_chain[axis=x,waterlogged=true]";
const fixture = (state = chain, version = "1.21.4", data = 4189) => ({
  minecraft_version: version, data_version: data, width_x: 2, height_y: 1, length_z: 1,
  legend: { A: state, B: "minecraft:air" }, layers: [["AB"]],
  expected_counts: { [state]: 1, "minecraft:air": 1 }, non_air_count: 1,
  spot_checks: [{ x: 0, y: 0, z: 0, char: "A" }],
});

test("history validates release boundaries, alternatives, transforms, and target-specific cycles", () => {
  assert.equal(validateHistory(history), history, opt);
  let invalid = clone(history);
  invalid.blocks["minecraft:iron_chain"].introduced.dataVersion = 4786;
  assert.throws(() => validateHistory(invalid), /DataVersion mismatch/);
  invalid = clone(history);
  invalid.alternatives[0].to = "minecraft:missing";
  assert.throws(() => validateHistory(invalid), /invalid history alternative/);
  invalid = clone(history);
  invalid.alternatives[0].properties.rename.axis = "bad-key";
  assert.throws(() => validateHistory(invalid), /invalid property rename/);
  const introduced = { release: "1.16", dataVersion: 2566 };
  const min = { release: "26.1", dataVersion: 4786 };
  const edge = (from, to) => ({ from, to, target: { min }, properties: { rename: {}, values: {} } });
  assert.throws(() => validateHistory({ schemaVersion: 1,
    blocks: { "minecraft:stone": { introduced }, "minecraft:dirt": { introduced } },
    alternatives: [edge("minecraft:stone", "minecraft:dirt"), edge("minecraft:dirt", "minecraft:stone")],
  }), /history cycle/);
});

test("conversion preserves complete properties in both directions and fails closed", () => {
  const forward = convertBlueprint(fixture(), "26.1", history, opt);
  assert.equal(forward.legend.A, iron);
  assert.equal(forward.targetDataVersion, 4786);
  assert.deepEqual(forward.changes[0].via, ["minecraft:iron_chain"]);
  const backward = convertBlueprint(fixture(iron, "26.1", 4786), "1.21.4", history, opt);
  assert.equal(backward.legend.A, chain);
  assert.equal(backward.targetDataVersion, 4189);
  assert.throws(() => convertBlueprint(fixture(chain, "1.21.4", 3700), "26.1", history, opt), /data_version.*does not match/);
  assert.throws(() => convertBlueprint(fixture("minecraft:pale_oak_planks"), "1.20.4", history, opt), /no authored fallback/);
  assert.throws(() => convertBlueprint(fixture("minecraft:chain[waterlogged=false]", "1.21.4", 4189), "1.21.4", history, opt), /complete canonical property set/);
  const invalid = clone(history);
  invalid.alternatives[0].properties.rename.axis = "not_axis";
  assert.throws(() => convertBlueprint(fixture(), "26.1", invalid, opt), /complete canonical property set/);
  invalid.alternatives[0].properties.rename = {};
  invalid.alternatives[0].properties.values.axis = { y: "y" };
  assert.throws(() => convertBlueprint(fixture(), "26.1", invalid, opt), /missing explicit value mapping/);
});

test("CLI variant names, binary target DataVersion, geometry, validation and no overwrite", async () => {
  const sourceDir = await mkdtemp(path.join(root, "schematics/blueprints/history-test-"));
  const outDir = await mkdtemp(path.join(os.tmpdir(), "history-output-"));
  const source = path.join(sourceDir, "fixture.json"), base = path.join(outDir, "fixture.schem");
  const variant = path.join(outDir, "fixture.mc26.1.nonvalidated.schem");
  try {
    await writeFile(source, JSON.stringify(fixture()));
    await writeFile(base, "canonical");
    const compiled = run("python3", [compiler, "compile", source, base, "--convert-to", "26.1", "--allow-unverified"]);
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.equal(JSON.parse(compiled.stdout).compiled, variant);
    assert.equal(await readFile(base, "utf8"), "canonical");
    const bytes = await readFile(variant);
    const schematic = await readSchematic(bytes, "26.1");
    const block = schematic.getBlock(new Vec3(0, 0, 0));
    assert.equal(block.name, "iron_chain");
    assert.equal(block.getProperties().axis, "x");
    assert.equal(String(block.getProperties().waterlogged), "true");
    assert.equal(schematic.getBlock(new Vec3(1, 0, 0)).name, "air");
    const nbt = run("python3", ["-c", "import nbtlib,sys; n=nbtlib.load(sys.argv[1]); print(int(n['DataVersion']), int(n['Width']), int(n['Height']), int(n['Length']), sorted(n['Palette']))", variant]);
    assert.equal(nbt.status, 0, nbt.stderr);
    assert.match(nbt.stdout, /4786 2 1 1/);
    assert.match(nbt.stdout, /iron_chain\[axis=x,waterlogged=true\]/);
    const valid = run("python3", [compiler, "validate", source, variant, "--convert-to", "26.1", "--allow-unverified"]);
    // Inputs to validation are intentionally restricted to the repository.
    assert.notEqual(valid.status, 0);
    const repositoryVariant = path.join(sourceDir, "check.schem");
    await writeFile(repositoryVariant, bytes);
    assert.equal(run("python3", [compiler, "validate", source, repositoryVariant, "--convert-to", "26.1", "--allow-unverified"]).status, 0);
    const again = run("python3", [compiler, "compile", source, base, "--convert-to", "26.1", "--allow-unverified"]);
    assert.notEqual(again.status, 0);
    assert.deepEqual(await readFile(variant), bytes);
    assert.notEqual(run("python3", [compiler, "compile", source, base, "--convert-to", "../26.1"]).status, 0);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  }
});

test("pack staging, reports, runtime filename selection, no overwrite and path safety", async () => {
  const pack = `pack${Date.now()}${process.pid}`;
  const sources = path.join(root, "schematics/blueprints", pack);
  const outputs = path.join(root, "schematics/schems", pack);
  const outside = await mkdtemp(path.join(os.tmpdir(), "history-pack-outside-"));
  await mkdir(sources); await mkdir(outputs);
  const packRun = (...args) => run(packScript, [...args, "--allow-unverified"]);
  try {
    assert.notEqual(packRun().status, 0);
    assert.notEqual(packRun("../pack1", "26.1").status, 0);
    assert.notEqual(packRun(pack, "../../26.1").status, 0);
    assert.notEqual(packRun(pack, "26.1").status, 0, "empty pack must fail");
    await writeFile(path.join(sources, "one.json"), JSON.stringify(fixture()));
    await writeFile(path.join(sources, "two.json"), JSON.stringify(fixture("minecraft:nonexistent")));
    assert.notEqual(packRun(pack, "26.1").status, 0);
    assert.deepEqual(await (await import("node:fs/promises")).readdir(outputs), []);
    await writeFile(path.join(sources, "two.json"), JSON.stringify(fixture("minecraft:stone")));
    await writeFile(path.join(outputs, "one.schem"), "canonical");
    await writeFile(path.join(outputs, "index.json"), JSON.stringify({ schemaVersion: 2, groups: { "1": { "1": "one.schem" } } }));
    const result = packRun(pack, "26.1");
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(path.join(outputs, "conversion.mc26.1.nonvalidated.json"), "utf8"));
    assert.equal(report.entries.length, 2);
    assert.equal(report.entries[0].targetDataVersion, 4786);
    assert.equal(report.entries[0].changes[0].to, iron);
    assert.equal(await readFile(path.join(outputs, "one.schem"), "utf8"), "canonical");
    assert.equal(await resolveSchematicPath(`${pack}:one.mc26.1.nonvalidated.schem`), path.join(outputs, "one.mc26.1.nonvalidated.schem"));
    assert.equal(await resolveSchematicPath(`${pack}:1:1`), path.join(outputs, "one.schem"));
    const original = await readFile(path.join(outputs, "one.mc26.1.nonvalidated.schem"));
    assert.notEqual(packRun(pack, "26.1").status, 0);
    assert.deepEqual(await readFile(path.join(outputs, "one.mc26.1.nonvalidated.schem")), original);
    const reportBytes = await readFile(path.join(outputs, "conversion.mc26.1.nonvalidated.json"));
    const otherBytes = await readFile(path.join(outputs, "two.mc26.1.nonvalidated.schem"));
    await rm(path.join(outputs, "one.mc26.1.nonvalidated.schem"));
    await rm(path.join(outputs, "two.mc26.1.nonvalidated.schem"));
    assert.notEqual(packRun(pack, "26.1").status, 0, "existing report alone must prevent publication");
    assert.deepEqual(await readFile(path.join(outputs, "conversion.mc26.1.nonvalidated.json")), reportBytes);
    await rm(path.join(outputs, "conversion.mc26.1.nonvalidated.json"));
    await rm(path.join(outputs, "one.mc26.1.nonvalidated.schem.provenance.json"));
    await rm(path.join(outputs, "two.mc26.1.nonvalidated.schem.provenance.json"));
    await rm(path.join(outputs, "one.mc26.1.nonvalidated.schem.provenance.sha256"));
    await rm(path.join(outputs, "two.mc26.1.nonvalidated.schem.provenance.sha256"));
    const repeated = packRun(pack, "26.1");
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(await readFile(path.join(outputs, "one.mc26.1.nonvalidated.schem")), original);
    assert.deepEqual(await readFile(path.join(outputs, "two.mc26.1.nonvalidated.schem")), otherBytes);
    assert.deepEqual(await readFile(path.join(outputs, "conversion.mc26.1.nonvalidated.json")), reportBytes);
    await symlink(path.join(outside, "escape.json"), path.join(sources, "escape.json"));
    assert.notEqual(packRun(pack, "1.21.4").status, 0);
    await rm(path.join(sources, "escape.json"));
    await rm(outputs, { recursive: true });
    await symlink(outside, outputs);
    assert.notEqual(packRun(pack, "1.21.4").status, 0);
  } finally {
    await rm(sources, { recursive: true, force: true });
    await rm(outputs, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('multiple reachable authored alternatives fail independently of catalog order', () => {
  const introducedSource = { release: '1.21.4', dataVersion: 4189 };
  const introducedOld = { release: '1.13', dataVersion: 1519 };
  const target = { release: '1.13', dataVersion: 1519 };
  const blocks = { 'minecraft:pale_oak_planks': { introduced: introducedSource },
    'minecraft:oak_planks': { introduced: introducedOld }, 'minecraft:spruce_planks': { introduced: introducedOld } };
  const edge = to => ({ from: 'minecraft:pale_oak_planks', to, target: { min: target }, properties: { rename: {}, values: {} } });
  const alternatives = [edge('minecraft:oak_planks'), edge('minecraft:spruce_planks')];
  for (const edges of [alternatives, [...alternatives].reverse()]) {
    assert.throws(() => convertBlueprint(fixture('minecraft:pale_oak_planks'), '1.13',
      { schemaVersion: 1, blocks, alternatives: edges }, opt), /ambiguous authored fallbacks/);
  }
});
