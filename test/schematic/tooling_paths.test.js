import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { fixtureBlueprint } from "./provenance_fixture.js";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");
const pythonCompiler = path.join(projectRoot, "schematics/tooling/compile_blueprint.py");
const registryValidator = path.join(projectRoot, "schematics/tooling/validate_registry.mjs");
const nodeValidator = path.join(projectRoot, "schematics/tooling/validate_blueprint.mjs");

function run(command, args, cwd = os.tmpdir()) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

test("compiler and production validator resolve pack paths from a different cwd", t => {
  const directory = mkdtempSync(path.join(projectRoot, "test/schematic/.tooling-paths-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const schematic = path.relative(projectRoot, path.join(directory, "garden.schem"));
  const compiled = run("python3", [pythonCompiler, "compile", fixtureBlueprint, schematic]);
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
  const binary = run("python3", [pythonCompiler, "validate", fixtureBlueprint, schematic, "--allow-unverified"]);
  assert.equal(binary.status, 0, binary.stderr || binary.stdout);
  assert.match(binary.stdout, /"volume":/);
  const reader = run("node", [nodeValidator, fixtureBlueprint, schematic, "1.21.4"]);
  assert.equal(reader.status, 0, reader.stderr || reader.stdout);
  assert.match(reader.stdout, /"fullVoxelAndStateComparison": "PASS"/);
});

test("explicit compiler target enforces Minecraft 1.21.4 metadata and registry-valid palette states", async () => {
  const directory = path.join(projectRoot, "schematics/blueprints", `target${Date.now()}${process.pid}`);
  await mkdir(directory);
  const blueprintPath = path.join(directory, "fixture.json");
  const outputPath = path.join(directory, "fixture.nonvalidated.schem");
  const source = path.relative(projectRoot, blueprintPath);
  const output = path.relative(projectRoot, outputPath);
  const fixture = {
    minecraft_version: "1.21.4", data_version: 4189,
    width_x: 1, height_y: 1, length_z: 1,
    legend: { S: "minecraft:stone" }, layers: [["S"]],
    expected_counts: { "minecraft:stone": 1 }, non_air_count: 1,
    spot_checks: [{ x: 0, y: 0, z: 0, char: "S" }],
  };
  const compile = () => run("python3", [pythonCompiler, "compile", source, output, "--target-version", "1.21.4", "--allow-unverified"]);
  try {
    await writeFile(blueprintPath, JSON.stringify(fixture));
    const valid = compile();
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);
    assert.ok(existsSync(outputPath));
    const validOutput = await readFile(outputPath);
    const checked = run("python3", [pythonCompiler, "validate", source, output, "--target-version", "1.21.4", "--allow-unverified"]);
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);

    await writeFile(blueprintPath, JSON.stringify({ ...fixture, minecraft_version: "1.21.5" }));
    const wrongVersion = compile();
    assert.notEqual(wrongVersion.status, 0);
    assert.match(wrongVersion.stderr, /does not match blueprint minecraft_version/);
    assert.deepEqual(await readFile(outputPath), validOutput, "failed target validation must preserve existing output bytes");

    await writeFile(blueprintPath, JSON.stringify({ ...fixture, data_version: 3700 }));
    const wrongDataVersion = compile();
    assert.notEqual(wrongDataVersion.status, 0);
    assert.match(wrongDataVersion.stderr, /does not match 1\.21\.4 DataVersion 4189/);
    assert.deepEqual(await readFile(outputPath), validOutput, "failed DataVersion validation must preserve existing output bytes");

    await writeFile(blueprintPath, JSON.stringify({ ...fixture, legend: { S: "minecraft:stone[not_a_property=true]" }, expected_counts: { "minecraft:stone[not_a_property=true]": 1 } }));
    const invalidPalette = compile();
    assert.notEqual(invalidPalette.status, 0);
    assert.match(invalidPalette.stderr, /complete canonical property set/);
    assert.equal(existsSync(outputPath), true, "failed validation must not replace an existing output");
    assert.deepEqual(await readFile(outputPath), validOutput, "failed palette validation must preserve existing output bytes");

    for (const state of [
      "minecraft:constructor",
      "minecraft:__proto__",
      "minecraft:stone[__proto__=bogus]",
      "minecraft:stone[x=1,x=2]",
    ]) {
      await writeFile(blueprintPath, JSON.stringify({
        ...fixture, legend: { S: state }, expected_counts: { [state]: 1 },
      }));
      const invalid = compile();
      assert.notEqual(invalid.status, 0, `accepted unsafe/invalid state ${state}`);
      assert.deepEqual(await readFile(outputPath), validOutput, `invalid state ${state} replaced existing output bytes`);
    }

    await rm(outputPath);
    await writeFile(blueprintPath, JSON.stringify({ ...fixture, legend: { S: "minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=maybe]" }, expected_counts: { "minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=maybe]": 1 } }));
    const illegalValue = compile();
    assert.notEqual(illegalValue.status, 0);
    assert.match(illegalValue.stderr, /illegal waterlogged=maybe/);
    assert.equal(existsSync(outputPath), false, "invalid palette states must not create an output");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registry validation accepts shared 1.21.10 data at DataVersion 4556 and rejects mismatches", async () => {
  const directory = path.join(projectRoot, "schematics/blueprints", `release${Date.now()}${process.pid}`);
  await mkdir(directory);
  const blueprintPath = path.join(directory, "fixture.json");
  const outputPath = path.join(directory, "fixture.nonvalidated.schem");
  const source = path.relative(projectRoot, blueprintPath);
  const output = path.relative(projectRoot, outputPath);
  const fixture = {
    minecraft_version: "1.21.10", data_version: 4556,
    width_x: 1, height_y: 1, length_z: 1,
    legend: { S: "minecraft:stone" }, layers: [["S"]],
    expected_counts: { "minecraft:stone": 1 }, non_air_count: 1,
    spot_checks: [{ x: 0, y: 0, z: 0, char: "S" }],
  };
  const compile = (target = "1.21.10") => run("python3", [
    pythonCompiler, "compile", source, output, "--target-version", target, "--allow-unverified",
  ]);
  try {
    await writeFile(blueprintPath, JSON.stringify(fixture));
    const valid = compile();
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);
    const registry = run("node", [registryValidator, blueprintPath, "1.21.10"]);
    assert.equal(registry.status, 0, registry.stderr || registry.stdout);
    assert.match(registry.stdout, /"dataVersion":4556/);
    const validOutput = await readFile(outputPath);

    const wrongTarget = compile("1.21.9");
    assert.notEqual(wrongTarget.status, 0);
    assert.match(wrongTarget.stderr, /does not match blueprint minecraft_version/);
    assert.deepEqual(await readFile(outputPath), validOutput, "wrong target must preserve existing output bytes");

    await writeFile(blueprintPath, JSON.stringify({ ...fixture, data_version: 4554 }));
    const wrongDataVersion = compile();
    assert.notEqual(wrongDataVersion.status, 0);
    assert.match(wrongDataVersion.stderr, /does not match 1\.21\.10 DataVersion 4556/);
    assert.deepEqual(await readFile(outputPath), validOutput, "wrong DataVersion must preserve existing output bytes");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy integer state domains use registry cardinality and canonical values", async () => {
  const directory = path.join(projectRoot, "schematics/blueprints", `legacy${Date.now()}${process.pid}`);
  await mkdir(directory);
  const blueprintPath = path.join(directory, "fixture.json");
  const outputPath = path.join(directory, "fixture.schem");
  const source = path.relative(projectRoot, blueprintPath);
  const output = path.relative(projectRoot, outputPath);
  const makeFixture = (state) => ({
    minecraft_version: "1.13", data_version: 1519,
    width_x: 1, height_y: 1, length_z: 1,
    legend: { S: state }, layers: [["S"]],
    expected_counts: { [state]: 1 }, non_air_count: 1,
    spot_checks: [{ x: 0, y: 0, z: 0, char: "S" }],
  });
  const compile = () => run("python3", [pythonCompiler, "compile", source, output, "--target-version", "1.13"]);
  try {
    for (const legal of ["minecraft:oak_sapling[stage=0]", "minecraft:oak_sapling[stage=1]"]) {
      await writeFile(blueprintPath, JSON.stringify(makeFixture(legal)));
      await rm(outputPath, { force: true });
      await rm(`${outputPath}.provenance.json`, { force: true });
      await rm(`${outputPath}.provenance.sha256`, { force: true });
      const valid = compile();
      assert.equal(valid.status, 0, valid.stderr || valid.stdout);
    }
    const validOutput = await readFile(outputPath);

    for (const invalidState of [
      "minecraft:oak_sapling[stage=2]",
      "minecraft:oak_sapling[stage=999]",
      "minecraft:oak_sapling[stage=-1]",
      "minecraft:oak_sapling[stage=01]",
      "minecraft:oak_sapling[stage=+1]",
    ]) {
      await writeFile(blueprintPath, JSON.stringify(makeFixture(invalidState)));
      const invalid = compile();
      assert.notEqual(invalid.status, 0, `accepted out-of-domain/noncanonical state ${invalidState}`);
      assert.match(invalid.stderr, /illegal stage=|malformed or duplicate property/);
      assert.deepEqual(await readFile(outputPath), validOutput, `${invalidState} replaced existing output bytes`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit nonzero integer state values accept snow and leaf domain maxima", async () => {
  const directory = path.join(projectRoot, "schematics/blueprints", `integer${Date.now()}${process.pid}`);
  await mkdir(directory);
  const blueprintPath = path.join(directory, "fixture.json");
  const outputPath = path.join(directory, "fixture.nonvalidated.schem");
  const source = path.relative(projectRoot, blueprintPath);
  const output = path.relative(projectRoot, outputPath);
  const makeFixture = (state) => ({
    minecraft_version: "1.21.4", data_version: 4189,
    width_x: 1, height_y: 1, length_z: 1,
    legend: { S: state }, layers: [["S"]],
    expected_counts: { [state]: 1 }, non_air_count: 1,
    spot_checks: [{ x: 0, y: 0, z: 0, char: "S" }],
  });
  const compile = () => run("python3", [pythonCompiler, "compile", source, output, "--target-version", "1.21.4", "--allow-unverified"]);
  try {
    for (const legal of [
      "minecraft:snow[layers=8]",
      "minecraft:oak_leaves[distance=7,persistent=false,waterlogged=false]",
    ]) {
      await writeFile(blueprintPath, JSON.stringify(makeFixture(legal)));
      await rm(outputPath, { force: true });
      await rm(`${outputPath}.provenance.json`, { force: true });
      await rm(`${outputPath}.provenance.sha256`, { force: true });
      const valid = compile();
      assert.equal(valid.status, 0, valid.stderr || valid.stdout);
    }
    const validOutput = await readFile(outputPath);

    for (const invalidState of [
      "minecraft:snow[layers=0]",
      "minecraft:oak_leaves[distance=0,persistent=false,waterlogged=false]",
    ]) {
      await writeFile(blueprintPath, JSON.stringify(makeFixture(invalidState)));
      const invalid = compile();
      assert.notEqual(invalid.status, 0, `accepted out-of-domain state ${invalidState}`);
      assert.match(invalid.stderr, /illegal (?:layers|distance)=/);
      assert.deepEqual(await readFile(outputPath), validOutput, `${invalidState} replaced existing output bytes`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tooling rejects inputs that resolve outside the repository", async () => {
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "schematic-outside-"));
  const outside = path.join(outsideDir, "not-a-repository-blueprint.json");
  try {
    await writeFile(outside, "{}");
    const binary = run("python3", [pythonCompiler, "validate", outside, fixtureBlueprint]);
    assert.notEqual(binary.status, 0);
    assert.match(binary.stderr, /escapes project root/);

    const reader = run("node", [nodeValidator, outside, fixtureBlueprint]);
    assert.notEqual(reader.status, 0);
    assert.match(reader.stderr, /escapes project root/);
  } finally {
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("audit refuses an unknown pack instead of generating an empty successful report", () => {
  const runner = path.join(projectRoot, "schematics/tooling/audit_batch.py");
  const result = run("python3", [runner, "--pack", "pack987654", "--minecraft-version", "1.21.4", "--output-dir", `tmp/unknown-pack-${process.pid}`]);
  assert.equal(result.status, 2, result.stdout || result.stderr);
  assert.match(result.stderr, /no blueprint directory for pack987654/);
  assert.equal(existsSync(path.join(projectRoot, "schematics/schems/pack987654/batch_report.md")), false);
});

test("batch audit requires an explicit safe target and refuses an existing output directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "batch-no-clobber-"));
  try {
    const tooling = path.join(root, "schematics/tooling");
    const blueprints = path.join(root, "schematics/blueprints/pack3");
    const directory = path.join(root, "tmp", "existing-output");
    const runner = path.join(tooling, "audit_batch.py");
    await mkdir(tooling, { recursive: true });
    await mkdir(blueprints, { recursive: true });
    await mkdir(directory, { recursive: true });
    await copyFile(path.join(projectRoot, "schematics/tooling/audit_batch.py"), runner);
    await writeFile(path.join(blueprints, "fixture.json"), "{}");
    const marker = path.join(directory, "keep.txt");
    await writeFile(marker, "preserve me");
    const output = "tmp/existing-output";
    const result = run("python3", [runner, "--pack", "pack3", "--minecraft-version", "1.21.4", "--output-dir", output]);
    assert.equal(result.status, 2, result.stdout || result.stderr);
    assert.match(result.stderr, /cannot create fresh output directory:.*(?:File exists|Errno 17)/);
    assert.equal(await readFile(marker, "utf8"), "preserve me");
    assert.deepEqual(await readdir(directory), ["keep.txt"]);
    const invalid = run("python3", [runner, "--minecraft-version", "../bad", "--output-dir", output]);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /dotted release number/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audit manifest reader validates separate numeric fields, normalized uniqueness, and safe targets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schematic-audit-manifest-"));
  const pack = path.join(directory, "pack");
  await mkdir(pack);
  await writeFile(path.join(pack, "sparse-entry.schem"), "one");
  await writeFile(path.join(pack, "wide-entry.schematic"), "two");
  const runner = `
import json, pathlib, sys
sys.path.insert(0, sys.argv[1])
import audit_batch
pack = pathlib.Path(sys.argv[2])
manifest = pack / 'index.json'

def write(data):
    manifest.write_text(json.dumps(data), encoding='utf-8')

write({'schemaVersion': 2, 'groups': {'7': {'19': 'sparse-entry.schem'}, '9007199254740991': {'2': 'wide-entry.schematic'}}})
assert audit_batch.load_index(pack) == {'sparse-entry.schem': (7, 19), 'wide-entry.schematic': (9007199254740991, 2)}

for data, phrase in [
    ({'schemaVersion': 1, 'groups': {}}, 'versioned groups'),
    ({'schemaVersion': 2, 'groups': {'2': {'1': 'sparse-entry.schem'}, '02': {'2': 'wide-entry.schematic'}}}, 'duplicate normalized group'),
    ({'schemaVersion': 2, 'groups': {'2': {'1': 'sparse-entry.schem', '01': 'wide-entry.schematic'}}}, 'duplicate normalized id'),
    ({'schemaVersion': 2, 'groups': {'2': {'1': 'sparse-entry.schem'}, '3': {'1': 'sparse-entry.schem'}}}, 'duplicate schematic filename'),
    ({'schemaVersion': 2, 'groups': {'2': {'1': '../outside.schem'}}}, 'invalid schematic filename'),
]:
    write(data)
    try:
        audit_batch.load_index(pack)
    except (ValueError, FileNotFoundError) as error:
        if phrase:
            assert phrase in str(error), str(error)
    else:
        raise AssertionError(f'accepted invalid manifest: {data!r}')

write({'schemaVersion': 2, 'groups': {'2': {'1': 'missing.schem'}}})
assert audit_batch.load_index(pack) == {'missing.schem': (2, 1)}

outside = pack.parent / 'outside.schem'
outside.write_text('outside', encoding='utf-8')
(pack / 'linked.schem').symlink_to(outside)
write({'schemaVersion': 2, 'groups': {'4': {'1': 'linked.schem'}}})
try:
    audit_batch.load_index(pack)
except ValueError as error:
    assert 'unsafe or non-file schematic target' in str(error)
else:
    raise AssertionError('accepted a target symlink that escapes its pack')

schems = pack.parent / 'schems'
schems.mkdir()
outside_pack = pack.parent / 'outside-pack'
outside_pack.mkdir()
(outside_pack / 'index.json').write_text(json.dumps({'schemaVersion': 2, 'groups': {}}), encoding='utf-8')
linked_pack = schems / 'pack2'
linked_pack.symlink_to(outside_pack, target_is_directory=True)
try:
    audit_batch.load_index(linked_pack)
except ValueError as error:
    assert 'pack directory resolves outside' in str(error)
else:
    raise AssertionError('accepted a pack directory symlink that escapes its schems directory')

manifest.unlink()
manifest.mkdir()
try:
    audit_batch.load_index(pack)
except ValueError as error:
    assert 'manifest must be a regular file' in str(error)
else:
    raise AssertionError('silently ignored a directory manifest')
manifest.rmdir()
manifest.symlink_to(pack.parent / 'missing-index.json')
try:
    audit_batch.load_index(pack)
except FileNotFoundError:
    pass
else:
    raise AssertionError('silently ignored a dangling manifest symlink')
`;
  try {
    const result = run("python3", ["-c", runner, path.join(projectRoot, "schematics/tooling"), pack]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compiler and production validator accept another pack and registry version, but reject mismatched or unavailable versions", async () => {
  // Keep repository-confined inputs outside pack1; always remove the fixture.
  const directory = path.join(projectRoot, "schematics/blueprints", `pack${Date.now()}${process.pid}`);
  await mkdir(directory);
  const source = path.relative(projectRoot, path.join(directory, "stone.json"));
  const output = path.relative(projectRoot, path.join(directory, "stone.nonvalidated.schem"));
  const fixture = {
    minecraft_version: "1.20.4", data_version: 3700,
    width_x: 1, height_y: 1, length_z: 1,
    legend: { S: "minecraft:oak_sapling[stage=0]" }, layers: [["S"]],
    expected_counts: { "minecraft:oak_sapling[stage=0]": 1 }, non_air_count: 1,
    spot_checks: [{ x: 0, y: 0, z: 0, char: "S" }],
  };
  try {
    await writeFile(path.join(projectRoot, source), JSON.stringify(fixture));
    const compile = run("python3", [pythonCompiler, "compile", source, path.join(projectRoot, output), "--allow-unverified"]);
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const binary = run("python3", [pythonCompiler, "validate", source, output, "--allow-unverified"]);
    assert.equal(binary.status, 0, binary.stderr || binary.stdout);
    const reader = run("node", [nodeValidator, source, output]);
    assert.equal(reader.status, 0, reader.stderr || reader.stdout);
    assert.match(reader.stdout, /minecraft-data 1\.20\.4/);

    const mismatched = run("node", [nodeValidator, source, output, "1.21.4"]);
    assert.notEqual(mismatched.status, 0);
    assert.match(mismatched.stderr, /differs from blueprint minecraft_version/);
    await writeFile(path.join(projectRoot, source), JSON.stringify({ ...fixture, data_version: 4189 }));
    const wrongData = run("node", [nodeValidator, source, output]);
    assert.notEqual(wrongData.status, 0);
    assert.match(wrongData.stderr, /does not match.*DataVersion 3700/);
    await writeFile(path.join(projectRoot, source), JSON.stringify({ ...fixture, minecraft_version: "99.99.99" }));
    const unavailable = run("node", [nodeValidator, source, output]);
    assert.notEqual(unavailable.status, 0);
    assert.match(unavailable.stderr, /registry 99\.99\.99 unavailable/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
