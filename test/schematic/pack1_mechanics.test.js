import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { auditPack1, diagnoseBlueprint } from '../../schematics/tooling/audit_pack1_mechanics.mjs';

const base = 'schematics/blueprints/pack1/';
const report = auditPack1();
const build = name => report.builds.find(b => b.source === `${base}${name}.json`);
const mismatchRows = b => b.stairs.mismatches.map(r => [...r.position,r.declared_shape,r.derived_shape]);

test('all 32 reviewed stair locations and declared/derived shapes', () => {
  assert.equal(report.builds.length, 30);
  assert.ok(report.builds.every(b => b.status === 'modeled'));
  assert.deepEqual(mismatchRows(build('09_river_steamboat')), [
    [5,3,10,'straight','inner_left'],[7,3,10,'straight','inner_right'],
    [5,3,14,'straight','inner_left'],[7,3,14,'straight','inner_right']
  ]);
  const corners = [];
  for (let i=0; i<6; i++) {
    const a=2+i, b=14-i, y=9+i;
    corners.push([a,y,a,'inner_right','outer_left'], [b,y,a,'inner_left','outer_right'],
      [a,y,b,'inner_left','outer_right'], [b,y,b,'inner_right','outer_left']);
  }
  assert.deepEqual(mismatchRows(build('17_carousel')), corners);
  assert.deepEqual(mismatchRows(build('18_giant_grandfather_clock')), [
    [2,6,1,'straight','outer_left'],[10,6,1,'straight','outer_right'],
    [2,6,9,'straight','outer_right'],[10,6,9,'straight','outer_left']
  ]);
  assert.equal(report.builds.reduce((n,b) => n+b.stairs.mismatches.length,0),32);
  for (const b of report.builds) for (const r of b.stairs.mismatches) {
    assert.notEqual(r.declared,r.derived);
    assert.match(r.derived, new RegExp(`shape=${r.derived_shape}`));
    assert.ok(r.evidence.length >= 2);
    assert.ok(r.evidence.every(e => e.classification === 'known' && e.state));
  }
});

test('all 80 carousel air-below carpets and all 36 rail/torch-below carpets', () => {
  const b=build('17_carousel'), cells=b.carpets.cells;
  const airCoords = [[5,3],[6,3],[7,3],[9,3],[10,3],[11,3],[4,4],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[11,4],[12,4],[3,5],[4,5],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],[11,5],[12,5],[13,5],[3,6],[4,6],[5,6],[11,6],[12,6],[13,6],[3,7],[4,7],[5,7],[11,7],[12,7],[13,7],[4,8],[5,8],[11,8],[12,8],[3,9],[4,9],[5,9],[11,9],[12,9],[13,9],[3,10],[4,10],[5,10],[11,10],[12,10],[13,10],[3,11],[4,11],[5,11],[6,11],[7,11],[8,11],[9,11],[10,11],[11,11],[12,11],[13,11],[4,12],[5,12],[6,12],[7,12],[8,12],[9,12],[10,12],[11,12],[12,12],[5,13],[6,13],[7,13],[9,13],[10,13],[11,13]];
  const nonAirCoords = [[6,2],[7,2],[8,2],[9,2],[10,2],[3,3],[4,3],[8,3],[12,3],[13,3],[3,4],[13,4],[2,6],[14,6],[2,7],[14,7],[2,8],[3,8],[13,8],[14,8],[2,9],[14,9],[2,10],[14,10],[3,12],[13,12],[3,13],[4,13],[8,13],[12,13],[13,13],[6,14],[7,14],[8,14],[9,14],[10,14]];
  const coords = result => cells.filter(c => c.result === result).map(c => [c.position[0],c.position[2]]);
  assert.deepEqual(coords('below_air'),airCoords);
  assert.deepEqual(coords('below_non_air'),nonAirCoords);
  assert.deepEqual([b.carpets.examined,b.carpets.below_air,b.carpets.below_non_air,b.carpets.unknown],[116,80,36,0]);
  for (const c of cells) {
    assert.equal(c.position[1],3);
    assert.deepEqual(c.evidence[0].position,[c.position[0],2,c.position[2]]);
    if (c.result === 'below_air') {
      assert.equal(c.evidence[0].state,'minecraft:air');
      assert.equal(c.derived_survival,false);
    } else {
      assert.match(c.evidence[0].state,/^minecraft:(rail|powered_rail|redstone_torch)\[/);
      assert.equal(c.derived_survival,true);
    }
  }
});

const stair = (facing, half='bottom', material='oak') => `minecraft:${material}_stairs[facing=${facing},half=${half},shape=straight,waterlogged=false]`;
function fixture(entries, width=5, height=3, length=5) {
  const legend={'.':'minecraft:air'}, voxels=Array.from({length:height},()=>Array.from({length},()=>Array(width).fill('.')));
  entries.forEach(([x,y,z,state], i) => {const key=String.fromCharCode(65+i); legend[key]=state; voxels[y][z][x]=key;});
  return {schema:'explicit-layer-matrix-v1',minecraft_version:'1.21.4',data_version:4189,width_x:width,height_y:height,length_z:length,legend,layers:voxels.map(layer=>layer.map(row=>row.join('')))};
}
function center(entries) {
  const result=diagnoseBlueprint(fixture([[2,1,2,stair('north')],...entries]));
  return result.stairs.mismatches.find(r=>r.position.join() === '2,1,2') ?? result.stairs.unknown.find(r=>r.position.join() === '2,1,2') ?? {derived_shape:'straight'};
}

test('vanilla front priority, half, axis, handedness and side blockers across materials', () => {
  assert.equal(center([[2,1,1,stair('west')],[2,1,3,stair('east')]]).derived_shape,'outer_left');
  assert.equal(center([[2,1,1,stair('east')]]).derived_shape,'outer_right');
  assert.equal(center([[2,1,3,stair('west')]]).derived_shape,'inner_left');
  assert.equal(center([[2,1,3,stair('east')]]).derived_shape,'inner_right');
  assert.equal(center([[2,1,1,stair('west','top')],[2,1,3,stair('east')]]).derived_shape,'inner_right');
  assert.equal(center([[2,1,1,stair('south')]]).derived_shape,'straight');
  assert.equal(center([[2,1,1,stair('west')],[3,1,2,stair('north','bottom','spruce')],[2,1,3,stair('west')]]).derived_shape,'inner_left');
  assert.equal(center([[2,1,1,stair('west')],[3,1,2,stair('north','bottom','spruce')],[2,1,3,stair('east')]]).derived_shape,'straight');
  assert.equal(center([[2,1,3,stair('west')],[1,1,2,stair('north','bottom','spruce')]]).derived_shape,'straight');
  assert.equal(center([[2,1,1,stair('west')],[3,1,2,stair('north','top')]]).derived_shape,'outer_left');
  assert.equal(center([[2,1,1,stair('west','bottom','spruce')]]).derived_shape,'outer_left');
});

test('outside volume and incomplete or unrecognized states remain unknown', () => {
  const edge=diagnoseBlueprint(fixture([[0,1,0,stair('north')],[2,0,2,'minecraft:red_carpet']]));
  assert.equal(edge.stairs.unknown[0].derived_shape,null);
  assert.equal(edge.stairs.unknown[0].evidence[0].classification,'outside_volume_unknown');
  assert.equal(edge.carpets.cells[0].derived_survival,null);
  assert.equal(edge.carpets.cells[0].evidence[0].classification,'outside_volume_unknown');
  const incomplete=center([[2,1,1,'minecraft:oak_stairs[facing=west,half=bottom]']]);
  assert.equal(incomplete.derived_shape,null);
  assert.equal(incomplete.evidence[0].classification,'unrecognized_or_incomplete_state');
  const mod=center([[2,1,1,'example:custom_stairs[facing=west]']]);
  assert.equal(mod.derived_shape,null);
  const invalid=fixture([[2,1,2,'minecraft:red_carpet'],[2,0,2,'minecraft:made_up']]);
  assert.equal(diagnoseBlueprint(invalid).carpets.cells[0].derived_survival,null);
  const wrongVersion=structuredClone(invalid); wrongVersion.minecraft_version='26.1';
  assert.equal(diagnoseBlueprint(wrongVersion).status,'skipped');
  const wrongData=structuredClone(invalid); wrongData.data_version=0;
  assert.equal(diagnoseBlueprint(wrongData).status,'skipped');
  const wrongSchema=structuredClone(invalid); wrongSchema.schema='other';
  assert.equal(diagnoseBlueprint(wrongSchema).status,'skipped');
  const missingLayer=structuredClone(invalid); missingLayer.layers.pop();
  assert.equal(diagnoseBlueprint(missingLayer).status,'skipped');
  const moss=diagnoseBlueprint(fixture([[2,1,2,'minecraft:moss_carpet']]));
  assert.equal(moss.carpets.examined,0);
  const before=JSON.stringify(invalid);
  diagnoseBlueprint(invalid);
  assert.equal(JSON.stringify(invalid),before);
});

function inventory(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => {
    const file=path.join(dir,name);
    return [name,createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
  }));
}
test('CLI is reproducible and never changes any blueprints or schematics', () => {
  const blueprints=inventory(base), schematics=inventory('schematics/schems/pack1');
  const output=execFileSync(process.execPath,['schematics/tooling/audit_pack1_mechanics.mjs'],{encoding:'utf8',maxBuffer:10*1024*1024});
  assert.deepEqual(JSON.parse(output),report);
  assert.equal(output,fs.readFileSync('schematics/tooling/validation/pack1/mechanics_audit.json','utf8'));
  assert.deepEqual(inventory(base),blueprints);
  assert.deepEqual(inventory('schematics/schems/pack1'),schematics);
});
