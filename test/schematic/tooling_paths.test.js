import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "../..");
const pythonCompiler = path.join(projectRoot, "schematics/tooling/compile_blueprint.py");
const nodeValidator = path.join(projectRoot, "schematics/tooling/validate_blueprint.mjs");
const blueprint = "schematics/blueprints/pack1/03_big_red_barn.json";
const schematic = "schematics/schems/pack1/03_big_red_barn.schem";

function run(command, args, cwd = os.tmpdir()) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

test("compiler and production validator resolve pack paths from a different cwd", () => {
  assert.ok(existsSync(path.join(projectRoot, blueprint)));
  assert.ok(existsSync(path.join(projectRoot, schematic)));

  const binary = run("python3", [pythonCompiler, "validate", blueprint, schematic]);
  assert.equal(binary.status, 0, binary.stderr || binary.stdout);
  assert.match(binary.stdout, /"volume":/);

  const reader = run("node", [nodeValidator, blueprint, schematic, "1.21.4"]);
  assert.equal(reader.status, 0, reader.stderr || reader.stdout);
  assert.match(reader.stdout, /"fullVoxelAndStateComparison": "PASS"/);
});

test("tooling rejects inputs that resolve outside the repository", async () => {
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "schematic-outside-"));
  const outside = path.join(outsideDir, "not-a-repository-blueprint.json");
  try {
    await writeFile(outside, "{}");
    const binary = run("python3", [pythonCompiler, "validate", outside, schematic]);
    assert.notEqual(binary.status, 0);
    assert.match(binary.stderr, /escapes project root/);

    const reader = run("node", [nodeValidator, outside, schematic]);
    assert.notEqual(reader.status, 0);
    assert.match(reader.stderr, /escapes project root/);
  } finally {
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("audit refuses an unknown pack instead of generating an empty successful report", () => {
  const runner = path.join(projectRoot, "schematics/tooling/audit_batch.py");
  const result = run("python3", [runner, "--pack", "pack987654"]);
  assert.equal(result.status, 2, result.stdout || result.stderr);
  assert.match(result.stderr, /no blueprint directory for pack987654/);
  assert.equal(existsSync(path.join(projectRoot, "schematics/schems/pack987654/batch_report.md")), false);
});

test("compiler and production validator accept another pack and registry version, but reject mismatched or unavailable versions", async () => {
  // Keep repository-confined inputs outside pack1; always remove the fixture.
  const directory = path.join(projectRoot, "schematics/blueprints", `pack${Date.now()}${process.pid}`);
  await mkdir(directory);
  const source = path.relative(projectRoot, path.join(directory, "stone.json"));
  const output = path.relative(projectRoot, path.join(directory, "stone.schem"));
  const fixture = {
    minecraft_version: "1.20.4", data_version: 3700,
    width_x: 1, height_y: 1, length_z: 1,
    legend: { S: "minecraft:stone" }, layers: [["S"]],
    expected_counts: { "minecraft:stone": 1 }, non_air_count: 1,
    spot_checks: [{ x: 0, y: 0, z: 0, char: "S" }],
  };
  try {
    await writeFile(path.join(projectRoot, source), JSON.stringify(fixture));
    const compile = run("python3", [pythonCompiler, "compile", source, path.join(projectRoot, output)]);
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const binary = run("python3", [pythonCompiler, "validate", source, output]);
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
