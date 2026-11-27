import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = {
  minecraft_version: '1.21.4', data_version: 4189,
  width_x: 1, height_y: 1, length_z: 1,
  legend: { s: 'minecraft:stone' }, layers: [['s']],
  expected_counts: { 'minecraft:stone': 1 }, spot_checks: [],
};

function checkout() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mindcraft-pack-build-test-'));
  const tools = path.join(dir, 'schematics/tooling');
  mkdirSync(tools, { recursive: true });
  for (const name of ['build_pack.py', 'compile_pack.py', 'compile_blueprint.py', 'convert_history.mjs', 'history_registry.mjs', 'block_history.v1.json']) {
    cpSync(path.join(root, 'schematics/tooling', name), path.join(tools, name));
  }
  cpSync(path.join(root, 'schematics/tooling/block_history/generated'), path.join(tools, 'block_history/generated'), { recursive: true });
  mkdirSync(path.join(dir, 'schematics/blueprints/pack2'), { recursive: true });
  mkdirSync(path.join(dir, 'schematics/blueprints/pack3'), { recursive: true });
  writeFileSync(path.join(dir, 'schematics/blueprints/pack2/one.json'), JSON.stringify(fixture));
  writeFileSync(path.join(dir, 'schematics/blueprints/pack3/other.json'), JSON.stringify(fixture));
  return dir;
}

function run(dir, ...args) {
  return spawnSync('python3', ['schematics/tooling/build_pack.py', ...args], { cwd: dir, encoding: 'utf8' });
}
function build(dir, pack = 'pack2', version = '1.21.4') {
  const result = run(dir, 'build', '--pack', pack, '--target-version', version);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.result, 'rebuilt');
  assert.equal(summary.reuse, false);
  const location = path.join(dir, summary.build);
  return { summary, location, manifest: JSON.parse(readFileSync(path.join(location, 'manifest.json'))) };
}

test('isolated pack builds never reuse unknown runtimes and preserve unrelated data', () => {
  const dir = checkout();
  try {
    const source = path.join(dir, 'schematics/blueprints/pack2/one.json');
    const other = path.join(dir, 'schematics/blueprints/pack3/other.json');
    const originalOther = readFileSync(other);
    assert.match(run(dir, 'list').stdout, /pack2\npack3/);
    for (const [pack, version] of [['../pack2', '1.21.4'], ['pack0', '1.21.4'], ['pack2', '../1.21.4'], ['pack9', '1.21.4'], ['pack2', '99.99']]) {
      assert.notEqual(run(dir, 'build', '--pack', pack, '--target-version', version).status, 0);
    }
    const first = build(dir), second = build(dir);
    assert.equal(first.manifest.key, second.manifest.key);
    assert.notEqual(first.location, second.location);
    assert.deepEqual(first.manifest.outputs, second.manifest.outputs);
    assert.equal(first.summary.blueprints, 1);
    const old = lstatSync(source);
    writeFileSync(source, JSON.stringify({ ...fixture, comment: 'changed bytes' }));
    utimesSync(source, old.atime, old.mtime);
    const edited = build(dir);
    assert.notEqual(edited.manifest.key, first.manifest.key);
    const extra = path.join(path.dirname(source), 'two.json');
    writeFileSync(extra, JSON.stringify(fixture));
    const added = build(dir);
    assert.equal(added.summary.blueprints, 2);
    assert.notEqual(added.manifest.key, edited.manifest.key);
    rmSync(extra);
    assert.equal(build(dir).manifest.key, edited.manifest.key);
    const tool = path.join(dir, 'schematics/tooling/block_history.v1.json');
    writeFileSync(tool, readFileSync(tool, 'utf8') + '\n');
    assert.notEqual(build(dir).manifest.key, edited.manifest.key);
    const changedTool = path.join(dir, 'schematics/tooling/convert_history.mjs');
    writeFileSync(changedTool, readFileSync(changedTool, 'utf8') + '\n');
    assert.notEqual(build(dir).manifest.key, edited.manifest.key);
    const nonvalidated = run(dir, 'build', '--pack', 'pack2', '--target-version', '1.21.4', '--allow-unverified');
    assert.equal(nonvalidated.status, 0, nonvalidated.stderr);
    const unverifiedBuild = JSON.parse(nonvalidated.stdout);
    assert.equal(JSON.parse(readFileSync(path.join(dir, unverifiedBuild.build, 'manifest.json'))).policy.allowUnverified, true);
    const changedRuntime = spawnSync('python3', ['schematics/tooling/build_pack.py', 'build', '--pack', 'pack2', '--target-version', '1.21.4'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
    });
    assert.equal(changedRuntime.status, 0, changedRuntime.stderr);
    assert.equal(JSON.parse(changedRuntime.stdout).reuse, false);
    // Malformed manifests and missing artifacts are never candidates for reuse.
    writeFileSync(path.join(first.location, 'manifest.json'), '{');
    const output = path.join(first.location, 'snapshot/schematics/schems/pack2');
    rmSync(path.join(output, readdirSync(output).find((name) => name.endsWith('.provenance.sha256'))));
    writeFileSync(path.join(output, 'conversion.mc1.21.4.json'), 'corrupt');
    rmSync(path.join(output, readdirSync(output).find((name) => name.endsWith('.schem'))));
    assert.equal(build(dir).summary.reuse, false);
    assert.deepEqual(readFileSync(other), originalOther);
    assert.equal(existsSync(path.join(dir, 'schematics/schems')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects symlinks and failed compiles without publishing partial builds', () => {
  const dir = checkout();
  try {
    const source = path.join(dir, 'schematics/blueprints/pack2/one.json');
    writeFileSync(source, '{');
    assert.notEqual(run(dir, 'build', '--pack', 'pack2', '--target-version', '1.21.4').status, 0);
    const cache = path.join(dir, '.schematic-builds/pack2');
    assert.deepEqual(readdirSync(cache), ['.lock']);
    rmSync(source);
    symlinkSync(path.join(dir, 'schematics/blueprints/pack3/other.json'), source);
    assert.notEqual(run(dir, 'build', '--pack', 'pack2', '--target-version', '1.21.4').status, 0);
    assert.deepEqual(readdirSync(cache), ['.lock']);
    const script = `import sys\nsys.path.insert(0, 'schematics/tooling')\nfrom build_pack import rename_noreplace\nrename_noreplace(sys.argv[1], sys.argv[2])`;
    mkdirSync(path.join(dir, 'a')); mkdirSync(path.join(dir, 'b'));
    writeFileSync(path.join(dir, 'b/user'), 'untouched');
    assert.notEqual(spawnSync('python3', ['-c', script, 'a', 'b'], { cwd: dir }).status, 0);
    assert.equal(readFileSync(path.join(dir, 'b/user'), 'utf8'), 'untouched');
    const stageScript = `from pathlib import Path\nimport sys\nsys.path.insert(0, 'schematics/tooling')\nfrom build_pack import private_stage, rename_noreplace\nwith private_stage(Path('.')) as stage:\n    rename_noreplace(stage, Path('published'))\n    stage.mkdir()\n    (stage / 'user').write_text('untouched')\nassert (stage / 'user').read_text() == 'untouched'\ntry:\n    with private_stage(Path('.')) as stage:\n        stage.rename('moved')\n        stage.mkdir()\n        (stage / 'user').write_text('untouched')\n        raise ValueError('failure')\nexcept ValueError:\n    pass\nassert (stage / 'user').read_text() == 'untouched'`;
    const stageResult = spawnSync('python3', ['-c', stageScript], { cwd: dir, encoding: 'utf8' });
    assert.equal(stageResult.status, 0, stageResult.stderr);
    rmSync(path.join(cache, '.lock'));
    symlinkSync(path.join(dir, 'b/user'), path.join(cache, '.lock'));
    assert.notEqual(run(dir, 'build', '--pack', 'pack2', '--target-version', '1.21.4').status, 0);
    assert.equal(readFileSync(path.join(dir, 'b/user'), 'utf8'), 'untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent builds serialize and publish distinct complete directories', async () => {
  const dir = checkout();
  try {
    function launch() {
      return new Promise((resolve, reject) => {
        const child = spawn('python3', ['schematics/tooling/build_pack.py', 'build', '--pack', 'pack2', '--target-version', '1.21.4'], { cwd: dir });
        let stdout = '', stderr = '';
        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
    }
    const results = await Promise.all([launch(), launch()]);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const builds = results.map((result) => JSON.parse(result.stdout).build);
    assert.notEqual(builds[0], builds[1]);
    for (const name of builds) assert.ok(existsSync(path.join(dir, name, 'manifest.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
