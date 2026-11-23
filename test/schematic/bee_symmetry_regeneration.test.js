import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { derive } from '../../schematics/tooling/symmetry_fix.mjs';
import { diagnose } from '../../schematics/tooling/symmetry.mjs';
import { schematicProvenance } from '../../src/utils/schematic/provenance.js';

const source = 'schematics/blueprints/pack1/02_bee_hot_air_balloon.json';
const base = 'schematics/schems/pack1/02_bee_hot_air_balloon';
const plan = JSON.parse(readFileSync('schematics/tooling/validation/pack1/bee_symmetry_plan.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const original = execFileSync('git', ['show', `03be8a6:${source}`]);
const states = data => data.layers.flatMap(layer => layer.flatMap(row => [...row].map(ch => data.legend[ch])));

test('reviewed hash-bound repair changes exactly the four authorized east cells', () => {
  assert.equal(sha(original), plan.source_sha256);
  const current = readFileSync(source), before = JSON.parse(original), after = JSON.parse(current);
  assert.deepEqual(derive(original, plan), current);
  assert.deepEqual([before.width_x,before.height_y,before.length_z], [10,17,9]);
  assert.deepEqual(after.legend,before.legend);
  const a = states(before), b = states(after), differences = [];
  for (let i=0;i<a.length;i++) if (a[i]!==b[i]) differences.push({to:[i%10,Math.floor(i/90),Math.floor(i/10)%9],before:a[i],after:b[i]});
  assert.deepEqual(differences.sort((x,y)=>JSON.stringify(x.to).localeCompare(JSON.stringify(y.to))),
    plan.changes.map(({to,before,after})=>({to,before,after})).sort((x,y)=>JSON.stringify(x.to).localeCompare(JSON.stringify(y.to))));
  assert.equal(differences.length,4); assert(differences.every(c=>c.to[0]>4.5));
  const oldReport=diagnose(before,'x=4.5'), newReport=diagnose(after,'x=4.5');
  assert.deepEqual([oldReport.pairs.matched,oldReport.pairs.compared],[217,221]);
  assert(newReport.exact); assert.deepEqual([newReport.pairs.matched,newReport.pairs.compared],[220,220]);
  let oldOccupiedPairs=0, nowBothAir=0;
  for (let y=0;y<17;y++) for (let z=0;z<9;z++) for (let x=0;x<5;x++) {
    const state=(d,x)=>d.legend[d.layers[y][z][x]];
    if (state(before,x)!=='minecraft:air'||state(before,9-x)!=='minecraft:air') {
      oldOccupiedPairs++;
      if (state(after,x)==='minecraft:air' && state(after,9-x)==='minecraft:air') nowBothAir++;
    }
  }
  assert.equal(oldOccupiedPairs,221); assert.equal(nowBothAir,1);
  assert.equal(newReport.pairs.matched+nowBothAir,221);
});

test('all other original sources and binaries retain their pre-correction Git bytes', () => {
  const lines=execFileSync('git',['ls-tree','-r','03be8a6','--','schematics/blueprints/pack1','schematics/schems/pack1'],{encoding:'utf8'}).trim().split('\n');
  let blueprints=0, schematics=0;
  for (const line of lines) {
    const match=/^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line); assert(match); const [,expected,file]=match;
    if (file.startsWith('schematics/blueprints/pack1/') && file.endsWith('.json') && file!==source) blueprints++;
    else if (file.startsWith('schematics/schems/pack1/') && file.endsWith('.schem') && !file.startsWith(`${base}.mc`)) schematics++;
    else continue;
    assert.equal(blob(readFileSync(file)),expected,file);
  }
  assert.equal(blueprints,29); assert.equal(schematics,88);
});

test('bee provenance and mixed conversion inventory identify the new content; originals remain archival', async () => {
  assert.equal((await schematicProvenance(`${base}.schem`)).validationStatus,'HISTORICAL_UNKNOWN');
  for (const [version,dv] of [['1.21.4',4189],['26.1',4786]]) {
    const file=`${base}.mc${version}.schem`, bytes=readFileSync(file);
    assert.equal((await schematicProvenance(file)).validationStatus,'STRICT_VALIDATED');
    const meta=JSON.parse(readFileSync(`${file}.provenance.json`));
    assert.equal(meta.blueprint,source); assert.equal(meta.blueprintSha256,sha(readFileSync(source)));
    assert.equal(meta.packReport,null); assert.equal(meta.packReportSha256,null); assert.equal(meta.sha256,sha(bytes));
    const report=JSON.parse(readFileSync(`schematics/schems/pack1/conversion.mc${version}.json`));
    const entry=report.entries.find(e=>e.schematic===file.split('/').at(-1));
    assert.equal(entry.sha256,sha(bytes)); assert.equal(entry.targetDataVersion,dv); assert.equal(entry.validation,'STRICT_VALIDATED');
    const attempted=spawnSync(process.env.HISTORY_TEST_PYTHON||'python3',['schematics/tooling/compile_blueprint.py','compile',source,`${base}.schem`,'--convert-to',version],{encoding:'utf8'});
    assert.notEqual(attempted.status,0); assert.match(attempted.stderr,/refusing to overwrite|File exists/); assert.equal(sha(readFileSync(file)),sha(bytes));
  }
});
