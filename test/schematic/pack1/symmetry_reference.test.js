import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { diagnose } from '../../../schematics/tooling/symmetry.mjs';

const directory = new URL('../../../schematics/blueprints/pack1/', import.meta.url);
const tool = new URL('../../../schematics/tooling/symmetry.mjs', import.meta.url);
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

