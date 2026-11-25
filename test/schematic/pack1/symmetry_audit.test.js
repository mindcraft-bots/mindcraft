import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { audit } from '../../../schematics/tooling/audit_pack_symmetry.mjs';

const json = name => JSON.parse(readFileSync(new URL(`../../../${name}`, import.meta.url)));

test('active audit is deterministic and covers every current family and derivative', async () => {
  const actual = await audit('pack1');
  assert.deepEqual(await audit('pack1'), actual);
  const manifest = json('schematics/schems/pack1/index.json');
  const families = Object.values(manifest.groups).flatMap(group => Object.values(group)).sort();
  assert.equal(families.length, 30); assert.equal(new Set(families).size, 30);
  assert.deepEqual(actual.builds.map(b => b.source.split('/').at(-1).replace(/\.json$/, '.schem')).sort(), families);
  assert.equal(actual.reference_photos.length, 40);
  assert.equal(actual.status, 'complete');
  assert(actual.inputs.every(i => !i.path.includes('schematic-archive/') && !i.path.includes('tmp/history/')));
  assert(actual.builds.every(b => b.historical_original === null));
  for (const b of actual.builds) {
    const stem = b.source.split('/').at(-1).replace(/\.json$/, '');
    assert.deepEqual(b.schematics.map(s => s.path).sort(), ['1.21.4','26.1'].map(v => `schematics/schems/pack1/${stem}.mc${v}.schem`).sort());
    assert.deepEqual(b.schematics.map(s => [s.version,s.data_version]), [['1.21.4',4189],['26.1',4786]]);
    assert(b.schematics.every(s => s.status === 'matched' && s.mismatched_voxels === 0 && s.palette_equal));
  }
  assert.equal(actual.builds.filter(b => b.symmetry.some(p => p.intent === 'measure' && p.exact)).length, 9);
  const barn = actual.builds.find(b => b.source.includes('big_red_barn'));
  assert.equal(barn.symmetry.find(p => p.intent === 'exact').expectation_met, true);
  assert.equal(actual.builds.flatMap(b => b.schematics).length, 60);
  assert.equal(actual.builds.flatMap(b => b.schematics).reduce((n,s) => n+s.voxel_count, 0), 143414);
  assert.equal(actual.builds.filter(b => b.conversions.length).length, 6);
  const conversions = actual.builds.flatMap(b => b.conversions);
  assert.deepEqual(conversions.map(c => c.voxel_count).sort((a,b) => a-b), [1,2,2,19,24,24,24]);
  for (const c of conversions) {
    assert.match(c.from, /^minecraft:chain\[axis=[xy],waterlogged=false\]$/);
    assert.equal(c.to, c.from.replace('minecraft:chain', 'minecraft:iron_chain'));
    assert.deepEqual(c.via, ['minecraft:iron_chain']);
  }
  const bee = actual.builds.find(b => b.source.includes('bee_hot'));
  assert.deepEqual([bee.symmetry[0].pairs.matched, bee.symmetry[0].pairs.compared], [220,220]);
  assert.equal(bee.symmetry[0].mismatches.length, 0); assert.equal(bee.symmetry[0].exact, true);
  const plan = json('schematics/tooling/validation/pack1/bee_symmetry_plan.json');
  assert.deepEqual([plan.report.pairs.matched, plan.report.pairs.compared], [217,221]);
  assert.equal(bee.symmetry[0].pairs.matched + 1, 221);
});

test('frozen symmetry audit retains its historical original comparisons', () => {
  const recorded = json('schematics/tooling/validation/pack1/symmetry_audit.json');
  assert.equal(recorded.status, 'complete');
  assert.equal(recorded.builds.length, 30); assert.equal(recorded.reference_photos.length, 40);
  assert.equal(recorded.builds.flatMap(b => b.schematics).length, 60);
  assert.equal(recorded.builds.flatMap(b => b.schematics).reduce((n,s) => n+s.voxel_count, 0), 143414);
  assert.equal(recorded.builds.reduce((n,b) => n+b.historical_original.voxel_count, 0), 71707);
  assert.equal(recorded.builds.filter(b => b.historical_original.mismatched_voxels === 0).length, 28);
  const originals = recorded.builds.map(b => b.historical_original).filter(s => s.mismatched_voxels);
  assert.equal(originals.length, 2);
  const wardrobe = originals.find(s => s.path.includes('wardrobe'));
  assert.equal(wardrobe.mismatched_voxels, 4);
  assert.deepEqual(wardrobe.differences.map(d => d.pos).sort(), [[2,0,1],[3,0,1],[2,1,1],[3,1,1]].sort());
  const bee = originals.find(s => s.path.includes('bee_hot'));
  assert.equal(bee.mismatched_voxels, 4);
  assert.deepEqual(bee.differences.map(d => d.pos).sort(), [[6,10,1],[6,12,0],[8,10,1],[8,12,0]].sort());
});
