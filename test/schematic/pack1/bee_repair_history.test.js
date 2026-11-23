import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import nbt from 'prismarine-nbt';
import { derive, plan } from '../../../schematics/tooling/symmetry_fix.mjs';
import { diagnose } from '../../../schematics/tooling/symmetry.mjs';
import { decodeVarints } from '../../../schematics/tooling/audit_pack_symmetry.mjs';
import { convertBlueprint } from '../../../schematics/tooling/convert_history.mjs';

const root = new URL('../../../', import.meta.url);
const read = name => readFileSync(new URL(name, root));
const json = name => JSON.parse(read(name));
const sha = data => createHash('sha256').update(data).digest('hex');
const source = 'schematics/blueprints/pack1/02_bee_hot_air_balloon.json';
const base = 'schematics/schems/pack1/02_bee_hot_air_balloon';
const fixture = 'test/schematic/pack1/fixtures/bee.pre-repair.json';
const approvalPath = 'schematics/tooling/validation/pack1/bee_symmetry_plan.json';
const states = (data, legend = data.legend) => data.layers.flatMap(layer => layer.flatMap(row => [...row].map(c => legend[c])));

test('approved bee repair replays the pinned historical source and matches both asset streams', async () => {
  const original = read(fixture), approval = json(approvalPath);
  const pinned = '8a1f66fed416f28889ebfcf180653735d8721718ee6500c0b716602bb49fd0df';
  assert.equal(sha(original), pinned);
  assert.equal(approval.source_sha256, pinned);
  assert.deepEqual(approval.changes.map(({from,to,before,after}) => ({from,to,before,after})), [
    {from:[1,10,1],to:[8,10,1],before:'minecraft:yellow_concrete',after:'minecraft:black_wool'},
    {from:[3,10,1],to:[6,10,1],before:'minecraft:black_wool',after:'minecraft:yellow_concrete'},
    {from:[1,12,0],to:[8,12,0],before:'minecraft:air',after:'minecraft:black_wool'},
    {from:[3,12,0],to:[6,12,0],before:'minecraft:black_wool',after:'minecraft:air'},
  ]);
  assert.deepEqual(plan(original, approval.config), approval);
  assert.throws(() => derive(original, {...approval, source_sha256: '0'.repeat(64)}), /does not exactly match/);
  const repaired = derive(original, approval), current = read(source);
  assert.deepEqual(repaired, current, 'production replay must reproduce the complete blueprint, including spot checks');
  const before = JSON.parse(original), after = JSON.parse(repaired);
  assert.deepEqual([before.width_x,before.height_y,before.length_z], [10,17,9]);
  assert.deepEqual(after.legend, before.legend);
  const oldStates = states(before), newStates = states(after);
  const changes = oldStates.flatMap((state, i) => state === newStates[i] ? [] : [{to:[i%10,Math.floor(i/90),Math.floor(i/10)%9],before:state,after:newStates[i]}]);
  const sort = a => a.sort((x,y) => JSON.stringify(x.to).localeCompare(JSON.stringify(y.to)));
  assert.deepEqual(sort(changes), sort(approval.changes.map(({to,before,after}) => ({to,before,after}))));
  assert.deepEqual([diagnose(before,'x=4.5').pairs.matched,diagnose(before,'x=4.5').pairs.compared], [217,221]);
  assert.equal(diagnose(after,'x=4.5').exact, true);
  const history = json('schematics/tooling/block_history.v1.json');
  for (const [version, dv] of [['1.21.4',4189],['26.1',4786]]) {
    const bytes = read(`${base}.mc${version}.schem`), {parsed} = await nbt.parse(bytes), tags = parsed.value;
    assert.equal(tags.DataVersion.value, dv);
    assert.deepEqual([tags.Width.value,tags.Height.value,tags.Length.value], [10,17,9]);
    const palette = [];
    for (const [state, id] of Object.entries(tags.Palette.value)) palette[id.value] = state;
    const actual = decodeVarints(tags.BlockData.value, newStates.length, palette.length).map(id => palette[id]);
    assert.deepEqual(actual, states(after, convertBlueprint(after, version, history).legend));
    const meta = json(`${base}.mc${version}.schem.provenance.json`);
    assert.equal(meta.blueprintSha256, sha(repaired));
    assert.equal(meta.sha256, sha(bytes));
  }
});

test('unrelated historical pack sources and binaries retain their frozen pre-repair hashes', () => {
  const raw = read('test/schematic/pack1/fixtures/pre-bee-repair-inventory.json');
  assert.equal(sha(raw), '631f8927619ad6cab62c78401889d745a72ecaa3b7a32a0ea3314a79eaec6097');
  const files = JSON.parse(raw).files, names = Object.keys(files);
  assert.equal(names.filter(n => n.startsWith('schematics/blueprints/')).length, 29);
  assert.equal(names.filter(n => n.endsWith('.schem')).length, 88);
  for (const name of names) assert.equal(sha(read(name)), files[name], name);
});

test('the real approval test rejects a tampered plan in a Git-free source copy', t => {
  if (process.env.BEE_APPROVAL_COPY === '1') {
    assert.equal(existsSync(path.join(fileURLToPath(root), '.git')), false);
    return; // Child verifies the copy instead of recursively copying itself.
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bee-approval-copy-'));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  const project = fileURLToPath(root);
  cpSync(path.join(project, 'schematics'), path.join(dir, 'schematics'), { recursive:true });
  cpSync(path.join(project, 'schematic-archive'), path.join(dir, 'schematic-archive'), { recursive:true });
  mkdirSync(path.join(dir, 'test/schematic/pack1'), { recursive:true });
  cpSync(path.join(project, 'test/schematic/pack1/bee_repair_history.test.js'), path.join(dir, 'test/schematic/pack1/bee_repair_history.test.js'));
  cpSync(path.join(project, 'test/schematic/pack1/fixtures'), path.join(dir, 'test/schematic/pack1/fixtures'), { recursive:true });
  cpSync(path.join(project, 'package.json'), path.join(dir, 'package.json'));
  symlinkSync(path.join(project, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  assert.equal(existsSync(path.join(dir, '.git')), false);
  const env = { ...process.env, BEE_APPROVAL_COPY:'1' };
  delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, ['--test', 'test/schematic/pack1/bee_repair_history.test.js'], { cwd:dir, env, encoding:'utf8' });
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
  assert.match(baseline.stdout, /ok 1 - approved bee repair/);
  const target = path.join(dir, approvalPath), approval = JSON.parse(readFileSync(target));
  approval.source_sha256 = '0'.repeat(64);
  writeFileSync(target, JSON.stringify(approval));
  const tampered = run();
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stdout, /not ok.*approved bee repair/);
  assert.match(tampered.stdout, /8a1f66fed416f28889ebfcf180653735d8721718ee6500c0b716602bb49fd0df/);
});
