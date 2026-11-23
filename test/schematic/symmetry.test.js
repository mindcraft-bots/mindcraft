import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { diagnose } from '../../schematics/tooling/symmetry.mjs';

const tool = new URL('../../schematics/tooling/symmetry.mjs', import.meta.url);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const fixture = (legend, rows) => ({ minecraft_version: '1.21.4', data_version: 4189,
  width_x: rows[0].length, height_y: 1, length_z: rows.length, legend, layers: [rows] });

test('direction, stair handedness, fence connections, chest halves and diagonal axis transform', () => {
  const stairs = fixture({ a:'minecraft:oak_stairs[facing=east,half=bottom,shape=inner_left,waterlogged=false]',
    b:'minecraft:oak_stairs[facing=west,half=bottom,shape=inner_right,waterlogged=false]' }, ['ab']);
  assert.equal(diagnose(stairs, 'x=0.5').exact, true);
  const fences = fixture({ a:'minecraft:oak_fence[east=true,north=false,south=false,waterlogged=false,west=false]',
    b:'minecraft:oak_fence[east=false,north=false,south=false,waterlogged=false,west=true]' }, ['ab']);
  assert.equal(diagnose(fences, 'x=0.5').exact, true);
  const chests = fixture({ a:'minecraft:chest[facing=north,type=left,waterlogged=false]',
    b:'minecraft:chest[facing=north,type=right,waterlogged=false]' }, ['ab']);
  assert.equal(diagnose(chests, 'x=0.5').exact, true);
  const logs = fixture({ '.':'minecraft:air', a:'minecraft:oak_log[axis=x]', b:'minecraft:oak_log[axis=z]' }, ['.a','b.']);
  assert.equal(diagnose(logs, 'x=z').exact, true);
  const rails = fixture({ a:'minecraft:rail[shape=south_east,waterlogged=false]',
    b:'minecraft:rail[shape=south_west,waterlogged=false]' }, ['ab']);
  assert.equal(diagnose(rails, 'x=0.5').exact, true);
  const slopes = fixture({ a:'minecraft:rail[shape=ascending_east,waterlogged=false]',
    b:'minecraft:rail[shape=ascending_west,waterlogged=false]' }, ['ab']);
  assert.equal(diagnose(slopes, 'x=0.5').exact, true);
  const diagonal = fixture({ '.':'minecraft:air', a:'minecraft:wall_torch[facing=north]',
    b:'minecraft:wall_torch[facing=west]' }, ['.a','b.']);
  assert.equal(diagnose(diagonal, 'x=z').exact, true);
});

test('classifies state differences, checks center, bounds and rejects unsupported states', () => {
  const torch = 'minecraft:wall_torch[facing=east]';
  const data = fixture({ a:torch, '.':'minecraft:air' }, ['a.a']);
  const report = diagnose(data, 'x=1');
  assert.deepEqual(report.mismatch_classes, { occupancy:0, material:0, state:1 });
  assert.deepEqual(report.mismatches[0].from, [0,0,0]);
  assert.equal(diagnose(fixture({a:torch}, ['a']), 'x=0').center.mismatched, 1);
  const outside = diagnose(data, 'x=0');
  assert.equal(outside.out_of_bounds.cells, 2);
  assert.equal(outside.out_of_bounds.occupied.length, 1);
  assert.equal(diagnose(data, 'x=1', '0,1,0,0,0,0').out_of_bounds.occupied[0].outside, 'region');
  assert.equal(diagnose(fixture({ a:'minecraft:oak_sign[rotation=0,waterlogged=false]' }, ['a']), 'x=0').exact, true);
  assert.throws(() => diagnose(fixture({ a:'minecraft:oak_stairs[facing=east]' }, ['a']), 'x=0'), /incomplete properties/);
  assert.throws(() => diagnose(data, 'x=1.25'), /invalid plane/);
});

test('CLI supports multiple paths/planes and rejects unknown repair options without writes', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'symmetry-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.json');
  writeFileSync(file, JSON.stringify(fixture({ a: 'minecraft:stone' }, ['aaa', 'aaa', 'aaa'])));
  const before = hash(file);
  const ok = spawnSync(process.execPath, [tool.pathname, '--check', '--plane', 'x=1', '--plane', 'z=1', file, file], { encoding:'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).reports.length, 2);
  const rejected = spawnSync(process.execPath, [tool.pathname, '--fix', '--plane', 'x=1', file], { encoding:'utf8' });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /unknown option --fix/);
  assert.equal(hash(file), before);
});
