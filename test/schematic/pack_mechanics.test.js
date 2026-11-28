import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditPack, diagnoseBlueprint } from '../../schematics/tooling/audit_pack_mechanics.mjs';

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

const project = fileURLToPath(new URL('../../', import.meta.url));
function temporaryProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mechanics-audit-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  fs.mkdirSync(path.join(root,'schematics/blueprints'), {recursive:true});
  fs.mkdirSync(path.join(root,'schematics/tooling'), {recursive:true});
  for (const name of ['audit_pack_mechanics.mjs','mechanics_model_1_21_4.mjs']) fs.copyFileSync(path.join(project,'schematics/tooling',name),path.join(root,'schematics/tooling',name));
  fs.copyFileSync(path.join(project,'package-lock.json'),path.join(root,'package-lock.json'));
  fs.symlinkSync(path.join(project,'node_modules'),path.join(root,'node_modules'));
  return root;
}
function packDir(root, pack) {
  const dir=path.join(root,'schematics/blueprints',pack);
  fs.mkdirSync(dir);
  return dir;
}
function put(dir, name, object) { fs.writeFileSync(path.join(dir,name), JSON.stringify(object)); }
function cli(root, ...args) {
  return spawnSync(process.execPath,[path.join(root,'schematics/tooling/audit_pack_mechanics.mjs'),...args],{cwd:os.tmpdir(),encoding:'utf8',maxBuffer:10*1024*1024});
}

test('different synthetic packs are discovered independently, without references or archives', t => {
  const root=temporaryProject(t), two=packDir(root,'pack2'), three=packDir(root,'pack3');
  put(two,'z.json',fixture([[0,0,0,'minecraft:red_carpet']],1,1,1));
  put(two,'a.json',fixture([[2,1,2,stair('north')],[2,1,1,stair('west')]]));
  put(two,'a.provenance.json',{schema:'explicit-layer-matrix-v1',layers:[]});
  put(two,'references.json',{schema:'reference-index-v1',images:['optional.png']});
  put(three,'one.json',fixture([]));
  const before=fs.readFileSync(path.join(two,'a.json'));
  const report=auditPack('pack2',{root});
  assert.deepEqual(report.builds.map(b=>b.source),['schematics/blueprints/pack2/a.json','schematics/blueprints/pack2/z.json']);
  assert.deepEqual(report.summary,{sources:2,modeled:2,skipped:0,with_unknowns:1});
  assert.equal(report.builds[0].stairs.mismatches.find(c=>c.position.join()==='2,1,2').derived_shape,'outer_left');
  assert.equal(report.builds[1].carpets.unknown,1);
  assert.equal(auditPack('pack3',{root}).summary.sources,1);
  assert.equal(auditPack('pack3',{root}).status,'modeled');
  const first=cli(root,'--pack','pack2'), second=cli(root,'--pack','pack2');
  assert.equal(first.status,0,first.stderr);
  assert.equal(first.stdout,second.stdout);
  assert.equal(JSON.parse(first.stdout).pack,'pack2');
  assert.deepEqual(fs.readFileSync(path.join(two,'a.json')),before);
  assert.deepEqual(fs.readdirSync(two).sort(),['a.json','a.provenance.json','references.json','z.json']);
});

test('unsupported source versions are explicitly skipped and fail the CLI', t => {
  const root=temporaryProject(t), dir=packDir(root,'pack3');
  const bp=fixture([]); bp.minecraft_version='26.1'; bp.data_version=9999;
  put(dir,'future.json',bp);
  const result=cli(root,'--pack','pack3');
  assert.equal(result.status,1);
  const report=JSON.parse(result.stdout);
  assert.equal(report.status,'incomplete');
  assert.equal(report.summary.skipped,1);
  assert.equal(report.builds[0].status,'skipped');
  assert.equal(report.builds[0].minecraft_version,'26.1');
  assert.match(report.builds[0].reason,/unsupported Minecraft version/);
});

test('partial blueprints are reported as skipped instead of silently discarded', t => {
  const root=temporaryProject(t), dir=packDir(root,'pack3');
  put(dir,'partial.json',{minecraft_version:'1.21.4',data_version:4189,layers:[]});
  const result=cli(root,'--pack','pack3');
  assert.equal(result.status,1);
  const report=JSON.parse(result.stdout);
  assert.equal(report.summary.skipped,1);
  assert.match(report.builds[0].reason,/incomplete/);
});

test('strict selection and configuration reject unsafe paths, malformed and ignored arguments', t => {
  const root=temporaryProject(t); packDir(root,'pack2');
  for (const args of [[],['pack2'],['--pack'],['--pack','false'],['--pack','pack2','--pack','pack3'],['--pack=pack2'],['--all'],['--pack','pack2','--unknown'],['--pack','../pack2'],['--pack','/pack2'],['--pack','pack2%2f..'],['--pack','pack2%5c..'],['--pack','pack2\n'],['--pack','pack02'],['--pack','pack0']]) {
    const result=cli(root,...args);
    assert.notEqual(result.status,0,JSON.stringify(args));
    assert.equal(result.stdout,'',JSON.stringify(args));
  }
  for (const pack of [false, null, '../pack2', '/pack2', 'pack2%2f..', 'pack2\\x', 'pack2\u0000']) assert.throws(()=>auditPack(pack,{root}));
  assert.throws(()=>auditPack('pack2',{root,ignored:true}),/configuration/);
  assert.throws(()=>auditPack('pack2',{root:'relative'}),/absolute/);
  assert.throws(()=>auditPack('pack2',{root}),/no source blueprints/);
  assert.throws(()=>auditPack('pack4',{root}));
  fs.writeFileSync(path.join(root,'schematics/blueprints/pack2/broken.json'),'{');
  assert.throws(()=>auditPack('pack2',{root}),/invalid JSON/);
  fs.unlinkSync(path.join(root,'schematics/blueprints/pack2/broken.json'));
  put(path.join(root,'schematics/blueprints/pack2'),'bad%2Fname.json',fixture([]));
  assert.throws(()=>auditPack('pack2',{root}),/unsafe source filename/);
});

test('source directories and JSON entries cannot escape via symlinks', t => {
  const root=temporaryProject(t), dir=packDir(root,'pack2');
  const outside=path.join(root,'external.json'); put(root,'external.json',fixture([]));
  fs.symlinkSync(outside,path.join(dir,'escape.json'));
  assert.throws(()=>auditPack('pack2',{root}),/unsafe/);
  fs.unlinkSync(path.join(dir,'escape.json'));
  fs.symlinkSync(dir,path.join(root,'schematics/blueprints/pack3'));
  assert.throws(()=>auditPack('pack3',{root}),/unsafe/);
  const link=path.join(os.tmpdir(),path.basename(root)+'-link');
  fs.symlinkSync(root,link); t.after(()=>fs.unlinkSync(link));
  assert.throws(()=>auditPack('pack2',{root:link}),/unsafe/);
});
