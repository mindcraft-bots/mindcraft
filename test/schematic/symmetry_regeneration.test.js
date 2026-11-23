import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { plan, derive } from '../../schematics/tooling/symmetry_fix.mjs';
import { diagnose } from '../../schematics/tooling/symmetry.mjs';

test('reviewed synthetic repair changes only authorized cells and rejects stale approval', () => {
  const source = {
    minecraft_version: '1.21.4', data_version: 4189,
    width_x: 80, height_y: 2, length_z: 1,
    legend: { a: 'minecraft:stone', b: 'minecraft:dirt' },
    layers: [['a'.repeat(76) + 'bbbb'], ['a'.repeat(80)]],
    expected_counts: { 'minecraft:stone': 156, 'minecraft:dirt': 4 },
    non_air_count: 160, spot_checks: [{ x: 79, y: 0, z: 0, char: 'b' }],
  };
  const bytes = Buffer.from(JSON.stringify(source));
  const config = { plane: 'x=39.5', bounds: '0,79,0,1,0,0', authoritative: 'low',
    threshold: 0.95, allow: [76, 77, 78, 79].map(x => [x, 0, 0]) };
  const approval = plan(bytes, config);
  assert.deepEqual(approval.changes.map(change => change.to).sort(), config.allow.slice().sort());
  assert(approval.changes.every(change => change.before === 'minecraft:dirt' && change.after === 'minecraft:stone'));
  const output = JSON.parse(derive(bytes, approval));
  assert.equal(output.layers[0][0], 'a'.repeat(80));
  assert.equal(output.layers[1][0], source.layers[1][0]);
  assert.deepEqual(output.expected_counts, { 'minecraft:stone': 160 });
  assert.equal(output.spot_checks[0].char, 'a');
  assert.equal(diagnose(output, config.plane, config.bounds).exact, true);
  assert.throws(() => derive(Buffer.from(JSON.stringify({ ...source, note: 'changed' })), approval), /does not exactly match/);
  assert.throws(() => plan(bytes, { ...config, allow: config.allow.slice(1) }), /allowlist/);
});
