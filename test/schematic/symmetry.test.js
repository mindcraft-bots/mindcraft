import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { diagnose } from '../../schematics/tooling/symmetry.mjs';

const directory = new URL('../../schematics/blueprints/pack1/', import.meta.url);
const tool = new URL('../../schematics/tooling/symmetry.mjs', import.meta.url);
const pathFor = name => new URL(`${name}.json`, directory);
const load = name => JSON.parse(readFileSync(pathFor(name), 'utf8'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const stateAt = (data, x, y, z) => data.legend[data.layers[y][z][x]];
const fixture = (legend, rows) => ({ minecraft_version: '1.21.4', data_version: 4189,
  width_x: rows[0].length, height_y: 1, length_z: rows.length, legend, layers: [rows] });

test('wardrobe keeps a mirror but the two doors have the reviewed outside hinges', () => {
  const data = load('01_wardrobe_nether_portal');
  for (const y of [0, 1]) for (const [x, hinge] of [[2, 'right'], [3, 'left']]) {
    assert.equal(stateAt(data, x, y, 1), `minecraft:dark_oak_door[facing=south,half=${y ? 'upper' : 'lower'},hinge=${hinge},open=true,powered=false]`);
  }
  const report = diagnose(data, 'x=2.5');
  assert.equal(report.exact, true);
  assert.deepEqual(report.pairs, { compared: 45, matched: 45, mismatched: 0, air_only: 39, coverage: 1 });
});

test('bee correction is an exact mirror and CLI check is read-only', () => {
  const bee = pathFor('02_bee_hot_air_balloon'), wardrobe = pathFor('01_wardrobe_nether_portal');
  const before = [hash(bee), hash(wardrobe)];
  const result = spawnSync(process.execPath, [tool.pathname, '--check', '--plane', 'x=4.5', bee.pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout).reports[0].results[0];
  assert.equal(report.exact, true);
  assert.deepEqual(report.pairs, { compared: 220, matched: 220, mismatched: 0, air_only: 545, coverage: 1 });
  assert.deepEqual(report.mismatch_classes, { occupancy: 0, material: 0, state: 0 });
  assert.deepEqual([hash(bee), hash(wardrobe)], before);
});

test('barn is globally asymmetric but the front roof profile is locally symmetric', () => {
  const data = load('03_big_red_barn');
  const global = diagnose(data, 'x=6.5');
  assert.equal(global.exact, false);
  assert.equal(global.pairs.mismatched, 95);
  assert.equal(global.out_of_bounds.cells, 1292);
  assert(global.out_of_bounds.occupied.length > 0);
  const roof = diagnose(data, 'x=6.5', '0,13,7,12,0,0');
  assert.equal(roof.exact, true);
  assert.equal(roof.pairs.compared, 7);
});

test('known whole-build planes include diagonal and center-plane cases', () => {
  for (const [name, plane] of [
    ['02_enderman_hot_air_balloon', 'x=3.5'], ['02_pig_hot_air_balloon', 'x=3.5'],
    ['03_storage_silo', 'z=4'], ['11_safety_fence', 'x=4'], ['11_safety_fence', 'z=1'],
    ['11_turn', 'x=z'], ['17_carousel', 'x=8'], ['17_strider_bath', 'x=4'],
  ]) assert.equal(diagnose(load(name), plane).exact, true, `${name} ${plane}`);
});

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

test('CLI supports multiple paths/planes and rejects unknown repair options without writes', () => {
  const path = pathFor('11_safety_fence');
  const before = hash(path);
  const ok = spawnSync(process.execPath, [tool.pathname, '--check', '--plane', 'x=4', '--plane', 'z=1', path.pathname, path.pathname], { encoding:'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).reports.length, 2);
  const rejected = spawnSync(process.execPath, [tool.pathname, '--fix', '--plane', 'x=4', path.pathname], { encoding:'utf8' });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /unknown option --fix/);
  assert.equal(hash(path), before);
});
