import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { audit } from '../../../schematics/tooling/audit_pack_symmetry.mjs';

test('persisted audit is reproducible and covers all sources, references and derivatives', async () => {
  const actual=await audit('pack1');
  const recorded=JSON.parse(readFileSync(new URL('../../../schematics/tooling/validation/pack1/symmetry_audit.json',import.meta.url)));
  assert.deepEqual(actual,recorded);
  assert.equal(actual.builds.length,30); assert.equal(actual.reference_photos.length,40);
  assert.equal(actual.status,'complete');
  assert.equal(actual.builds.filter(b=>b.symmetry.some(p=>p.intent==='measure' && p.exact)).length,9);
  const barn=actual.builds.find(b=>b.source.includes('big_red_barn'));
  assert.equal(barn.symmetry.find(p=>p.intent==='exact').expectation_met,true);
  assert.equal(actual.builds.flatMap(b=>b.schematics).length,60);
  assert(actual.builds.every(b=>b.schematics.every(s=>!s.mismatched_voxels && s.palette_equal)));
  const originals=actual.builds.map(b=>b.historical_original).filter(s=>s.mismatched_voxels);
  assert.equal(originals.length,2); assert(originals.some(s=>s.path.includes('wardrobe') && s.mismatched_voxels===4)); assert(originals.some(s=>s.path.includes('bee_hot') && s.mismatched_voxels===4));
  assert.equal(actual.builds.flatMap(b=>b.schematics).reduce((n,s)=>n+s.voxel_count,0),143414);
  assert.equal(actual.builds.reduce((n,b)=>n+b.historical_original.voxel_count,0),71707);
  assert.equal(actual.builds.filter(b=>b.conversions.length).length,6);
  const conversions=actual.builds.flatMap(b=>b.conversions);
  assert.deepEqual(conversions.map(c=>c.voxel_count).sort((a,b)=>a-b),[1,2,2,19,24,24,24]);
  for (const c of conversions) {
    assert.match(c.from, /^minecraft:chain\[axis=[xy],waterlogged=false\]$/);
    assert.equal(c.to, c.from.replace('minecraft:chain', 'minecraft:iron_chain'));
    assert.deepEqual(c.via,['minecraft:iron_chain']);
  }
  const bee=actual.builds.find(b=>b.source.includes('bee_hot'));
  assert.equal(bee.symmetry[0].pairs.matched,220); assert.equal(bee.symmetry[0].pairs.compared,220);
  assert.equal(bee.symmetry[0].mismatches.length,0); assert.equal(bee.symmetry[0].exact,true);
  const plan=JSON.parse(readFileSync(new URL('../../../schematics/tooling/validation/pack1/bee_symmetry_plan.json',import.meta.url)));
  assert.equal(plan.report.pairs.compared,221); assert.equal(plan.report.pairs.matched,217);
  // One pair counted in the original 221 is now air-only; all 221 original pairs match.
  assert.equal(bee.symmetry[0].pairs.matched+1,221);
  assert.deepEqual(bee.historical_original.differences.map(d=>d.pos).sort(), [[6,10,1],[6,12,0],[8,10,1],[8,12,0]].sort());
  assert.deepEqual(bee.schematics.map(s=>s.data_version),[4189,4786]);
  assert.deepEqual(bee.schematics.map(s=>s.mismatched_voxels),[0,0]);
});
