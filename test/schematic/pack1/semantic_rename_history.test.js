import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DATA_ROOT, loadRelease } from '../../../schematics/tooling/history_registry.mjs';
import { convertBlueprint, validateHistory } from '../../../schematics/tooling/convert_history.mjs';

const history = JSON.parse(readFileSync(new URL('../../../schematics/tooling/block_history.v1.json', import.meta.url)));
const releases = JSON.parse(readFileSync(`${DATA_ROOT}/index.json`)).releases;
const opt = { allowUnverified: true };
const fixture = (state, version, dv) => ({ minecraft_version: version, data_version: dv, legend: { A: state } });
const pairs = [
  { old: 'minecraft:grass', modern: 'minecraft:short_grass', last: 3578, first: 3698, url: 'https://minecraft.wiki/w/Java_Edition_1.20.3#Blocks' },
  { old: 'minecraft:grass_path', modern: 'minecraft:dirt_path', last: 2586, first: 2724, url: 'https://minecraft.wiki/w/Java_Edition_1.17#Blocks' },
];

test('pack1 secret island uses the reviewed rename only for the independently covered old target', () => {
  const blueprint = JSON.parse(readFileSync(new URL('../../../schematics/blueprints/pack1/07_secret_island_base.json', import.meta.url)));
  assert.equal(blueprint.legend.R, 'minecraft:short_grass');
  const isolated = convertBlueprint(fixture(blueprint.legend.R, blueprint.minecraft_version, blueprint.data_version), '1.13', history, opt);
  assert.equal(isolated.legend.A, 'minecraft:grass');
  assert.match(isolated.changes[0].evidence[0].source, /1.20.3/);
  const result = convertBlueprint(blueprint, '1.20.2', history, opt);
  assert.equal(result.validation, 'NONVALIDATED'); assert.equal(result.legend.R, 'minecraft:grass');
  assert.equal(result.changes.length, 1); assert.match(result.changes[0].evidence[0].source, /1.20.3/);
  const adjacent = convertBlueprint(blueprint, '1.20.1', history, opt);
  assert.equal(adjacent.legend.R, 'minecraft:grass');
});
