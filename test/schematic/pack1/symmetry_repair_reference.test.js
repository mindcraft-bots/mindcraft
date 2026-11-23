import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { plan, derive } from '../../../schematics/tooling/symmetry_fix.mjs';
import minecraftData from 'minecraft-data';
import { diagnose, parsePlane, parseState, render, transform } from '../../../schematics/tooling/symmetry.mjs';

const tool = new URL('../../../schematics/tooling/symmetry_fix.mjs', import.meta.url).pathname;
const load = n => JSON.parse(fs.readFileSync(new URL(`../../../schematics/blueprints/pack1/${n}.json`, import.meta.url)));
const bytes = d => Buffer.from(JSON.stringify(d));
const fixture = (last = 'b') => ({ minecraft_version:'1.21.4', data_version:4189, width_x:40, height_y:1, length_z:1,
  legend:{ a:'minecraft:stone', b:'minecraft:dirt', '.':'minecraft:air' }, layers:[['a'.repeat(39)+last]],
  expected_counts: last === 'b' ? {'minecraft:stone':39,'minecraft:dirt':1} : {'minecraft:stone':39,'minecraft:air':1},
  non_air_count:last === 'b' ? 40 : 39, spot_checks:[{x:39,y:0,z:0,char:last}] });
const config = { plane:'x=19.5', bounds:'0,39,0,0,0,0', authoritative:'low', threshold:0.95, allow:[[39,0,0]] };
const cli = (...args) => spawnSync(process.execPath, [tool,...args], {encoding:'utf8'});

test('actual bee and barn are never selected or silently repaired', () => {
  const bee = bytes(load('02_bee_hot_air_balloon'));
  assert.throws(() => plan(bee,{plane:'x=4.5',bounds:'0,9,0,17,0,8',authoritative:'low',threshold:0.99,allow:[]}), /unsafe agreement|bounds/);
  const barn = load('03_big_red_barn');
  assert.equal(diagnose(barn,'x=6.5').exact,false);
  assert.throws(() => plan(bytes(barn),{plane:'x=6.5',bounds:`0,${barn.width_x-1},0,${barn.height_y-1},0,${barn.length_z-1}`,authoritative:'low',threshold:0.95,allow:[]}), /unsafe region/);
});

