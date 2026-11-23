import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { audit, decodeVarints } from '../../schematics/tooling/audit_pack1_symmetry.mjs';

test('audit VarInt decoding rejects malformed and noncanonical streams', () => {
  assert.deepEqual(decodeVarints([0,127,128,1],3,129),[0,127,128]);
  for (const data of [[128],[128,0],[255,255,255,255,255,0],[2]]) assert.throws(() => decodeVarints(data,1,2));
});

test('persisted audit is reproducible and covers all sources, references and derivatives', async () => {
  const actual=await audit();
  const recorded=JSON.parse(readFileSync(new URL('../../schematics/tooling/validation/pack1/symmetry_audit.json',import.meta.url)));
  assert.deepEqual(actual,recorded);
  assert.equal(actual.builds.length,30); assert.equal(actual.reference_photos.length,40);
  assert.equal(actual.builds.filter(b=>b.symmetry.some(p=>p.exact)).length,9);
  assert.equal(actual.builds.flatMap(b=>b.schematics).length,90);
  assert(actual.builds.every(b=>b.schematics.slice(1).every(s=>!s.mismatched_voxels && s.palette_equal)));
  const originals=actual.builds.flatMap(b=>b.schematics.slice(0,1)).filter(s=>s.mismatched_voxels);
  assert.equal(originals.length,2); assert(originals.some(s=>s.path.includes('wardrobe') && s.mismatched_voxels===4)); assert(originals.some(s=>s.path.includes('bee_hot') && s.mismatched_voxels===4));
  assert.equal(actual.builds.filter(b=>b.conversions.length).length,6);
  const bee=actual.builds.find(b=>b.source.includes('bee_hot'));
  assert.equal(bee.symmetry[0].pairs.matched,220); assert.equal(bee.symmetry[0].pairs.compared,220);
  assert.equal(bee.symmetry[0].mismatches.length,0); assert.equal(bee.symmetry[0].exact,true);
  const plan=JSON.parse(readFileSync(new URL('../../schematics/tooling/validation/pack1/bee_symmetry_plan.json',import.meta.url)));
  assert.equal(plan.report.pairs.compared,221); assert.equal(plan.report.pairs.matched,217);
  // One pair counted in the original 221 is now air-only; all 221 original pairs match.
  assert.equal(bee.symmetry[0].pairs.matched+1,221);
  assert.deepEqual(bee.schematics[0].differences.map(d=>d.pos).sort(), [[6,10,1],[6,12,0],[8,10,1],[8,12,0]].sort());
  assert.deepEqual(bee.schematics.map(s=>s.data_version),[4189,4189,4786]);
  assert.deepEqual(bee.schematics.map(s=>s.mismatched_voxels),[4,0,0]);
});
