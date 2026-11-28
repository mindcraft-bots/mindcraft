import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolveSchematicPath } from '../../src/utils/schematic/paths.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = process.env.HISTORY_TEST_PYTHON || 'python3';
const guides = [
  'schematics/tooling/prompts/002-4-create-schemas-from-pictures.md',
  'schematics/tooling/prompts/003-voxel-architect-mode-instructions.md',
  'schematics/README.md',
];

test('active generation templates name versioned outputs and require an explicit target', () => {
  for (const file of guides) {
    const text = readFileSync(path.join(root, file), 'utf8');
    const outputs = [...text.matchAll(/schematics\/schems\/<packN>\/<(?:NN_building_slug|prefixed_slug)>[^`\s]*/g)].map(m => m[0]);
    assert(outputs.length > 0, file);
    for (const output of outputs) assert.match(output, /\.mc<MC_VERSION>\.schem$/, `${file}: ${output}`);
    assert.match(text, /--target-version <MC_VERSION>/, file);
    assert.match(text, /provenance/i, file);
    assert.match(text, /unsuffixed/i, file);
    for (const command of text.replaceAll('\\\n', ' ').split('\n').filter(line => /compile_blueprint\.py (?:compile|validate) /.test(line))) {
      assert.match(command, /\.mc<MC_VERSION>\.schem/, `${file}: ${command}`);
      assert.match(command, /--target-version <MC_VERSION>/, `${file}: ${command}`);
    }
  }
});

test('compiler guide direct compile examples are versioned; conversion labels its generated variant', () => {
  const text = readFileSync(path.join(root, 'schematics/tooling/BLUEPRINT_TOOLING.md'), 'utf8');
  const commands = text.replaceAll('\\\n', ' ').split('\n').filter(line => /compile_blueprint\.py compile\s+/.test(line));
  assert(commands.length >= 3);
  for (const command of commands) {
    if (command.includes('--convert-to')) {
      assert.match(text, /Produces \/tmp\/barn\.mc26\.1\.nonvalidated\.schem/);
    } else {
      assert.match(command, /\.mc\d+(?:\.\d+)+\.schem\s+--target-version\s+\d/);
    }
  }
});

test('documented target compile validates, publishes sidecars and resolves without clobbering', async t => {
  const dir = mkdtempSync(path.join(root, '.workflow-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'fixture.json');
  const output = path.join(dir, 'fixture.mc1.21.4.schem');
  writeFileSync(source, JSON.stringify({ minecraft_version: '1.21.4', data_version: 4189,
    width_x: 2, height_y: 1, length_z: 1, legend: { S: 'minecraft:stone', A: 'minecraft:air' },
    layers: [['SA']], expected_counts: { 'minecraft:stone': 1, 'minecraft:air': 1 },
    non_air_count: 1, spot_checks: [{ x: 0, y: 0, z: 0, char: 'S' }] }));
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  const compile = () => run(python, ['schematics/tooling/compile_blueprint.py', 'compile', source, output, '--target-version', '1.21.4']);
  let result = compile();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const before = [output, `${output}.provenance.json`, `${output}.provenance.sha256`].map(p => readFileSync(p));
  const metadata = JSON.parse(before[1]);
  assert.equal(metadata.targetVersion, '1.21.4');
  assert.equal(metadata.validation, 'STRICT_VALIDATED');
  result = run(python, ['schematics/tooling/compile_blueprint.py', 'validate', source, output, '--target-version', '1.21.4']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(process.execPath, ['schematics/tooling/validate_blueprint.mjs', source, output, '1.21.4', '--require-strict-provenance']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await resolveSchematicPath('fixture.schem', dir, { version: '1.21.4' }), output);
  assert.equal(await resolveSchematicPath('fixture.mc1.21.4.schem', dir, { version: '1.21.4' }), output);
  result = compile();
  assert.notEqual(result.status, 0);
  [output, `${output}.provenance.json`, `${output}.provenance.sha256`].forEach((p, i) => assert.deepEqual(readFileSync(p), before[i]));
});
