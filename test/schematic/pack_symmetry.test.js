import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import nbt from 'prismarine-nbt';
import { audit, auditAll, decodeVarints } from '../../schematics/tooling/audit_pack_symmetry.mjs';
import { loadRelease } from '../../schematics/tooling/history_registry.mjs';

const script=new URL('../../schematics/tooling/audit_pack_symmetry.mjs',import.meta.url);
const write=(root,p,data)=>{ const f=path.join(root,p); fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
const bp=(version,row)=>({minecraft_version:version,data_version:loadRelease(version).dataVersion,width_x:row.length,height_y:1,length_z:1,legend:{'.':'minecraft:air',A:'minecraft:stone'},layers:[[row]]});
function binary(d,version,legend=d.legend) {
  const tag=(type,value)=>({type,value});
  const states=[...new Set(Object.values(legend))];
  return gzipSync(nbt.writeUncompressed({type:'compound',name:'Schematic',value:{Version:tag('int',2),DataVersion:tag('int',loadRelease(version).dataVersion),Width:tag('short',d.width_x),Height:tag('short',d.height_y),Length:tag('short',d.length_z),PaletteMax:tag('int',states.length),Palette:tag('compound',Object.fromEntries(states.map((state,i)=>[state,tag('int',i)]))),BlockData:tag('byteArray',d.layers.flatMap(layer=>layer.flatMap(row=>[...row].map(c=>states.indexOf(legend[c])))))}}));
}
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'symmetry-packs-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const a=bp('1.21.4','AA.A'), b=bp('1.20.4','A.A'), c=bp('1.20.4','AA');
  for(const [pack,stem,d,versions] of [['pack2','alpha',a,['1.20.4','1.21.4','26.1']],['pack2','beta',b,['1.20.4']],['pack3','other',c,['1.20.4']]]) {
    write(root,`schematics/blueprints/${pack}/${stem}.json`,d);
    for(const v of versions) write(root,`schematics/schems/${pack}/${stem}.mc${v}.schem`,binary(d,v));
  }
  write(root,'schematics/schems/pack2/index.json',{schemaVersion:2,groups:{'7':{'3':'alpha.schem'},'42':{'9':'beta.schem'}}});
  write(root,'schematics/schems/pack3/index.json',{schemaVersion:2,groups:{'3':{'5':'other.schem'}}});
  write(root,'schematics/tooling/pack2/symmetry.json',{schema:1,builds:{alpha:{planes:[{plane:'x=0.5',bounds:'0,1,0,0,0,0',intent:'exact'}]}}});
  write(root,'schematics/screenshots/pack2/nested/deep/reference.PNG',Buffer.from('photo inventory only'));
  return root;
}
function inventory(root) {
  const result=[];
  function visit(dir) {for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {const p=path.join(dir,e.name); if(e.isDirectory()) visit(p); else if(e.isSymbolicLink()) result.push([path.relative(root,p),'symlink:'+fs.readlinkSync(p)]); else result.push([path.relative(root,p),fs.readFileSync(p).toString('base64')]);}}
  visit(root); return result;
}

test('VarInt decoding rejects malformed and noncanonical streams',()=>{
  assert.deepEqual(decodeVarints([0,127,128,1],3,129),[0,127,128]);
  for(const data of [[128],[128,0],[255,255,255,255,255,0],[2]]) assert.throws(()=>decodeVarints(data,1,2));
});

test('independent sparse packs discover different versions, local planes and assets deterministically without mutation',async t=>{
  const root=fixture(t), before=inventory(root), r=await audit('pack2',{root});
  assert.equal(r.status,'complete'); assert.equal(r.builds.length,2);
  assert.deepEqual(r.builds.map(b=>b.id),[{group:'7',id:'3'},{group:'42',id:'9'}]);
  assert.equal(r.reference_photos.length,1); assert.equal(r.builds[0].historical_original,null);
  assert.deepEqual(r.builds[0].schematics.map(s=>s.version),['1.20.4','1.21.4','26.1']);
  assert(r.builds[0].schematics.every(s=>s.status==='matched' && s.voxel_count===4));
  assert.equal(r.builds[0].symmetry[0].exact,false);
  assert.equal(r.builds[0].symmetry.find(p=>p.intent==='exact').expectation_met,true);
  assert.equal(JSON.stringify(await audit('pack2',{root})),JSON.stringify(r));
  assert.equal((await audit('pack3',{root})).builds.length,1);
  assert.deepEqual((await auditAll({root})).packs.map(p=>p.pack),['pack2','pack3']);
  assert.deepEqual(inventory(root),before);
});

test('selection rejects malformed labels and CLI rejects extra or missing arguments',async t=>{
  const root=fixture(t);
  for(const label of [undefined,'','pack0','pack01','pack2/../pack3','/pack2','pack2\\x','pack2\n','pack2%2fpack3','PACK2','pack2.3']) await assert.rejects(audit(label,{root}));
  for(const args of [[],['--pack'],['pack2'],['--pack','pack2','extra'],['--all','--all'],['--pack','pack1','--pack','pack2'],['--pack','../pack2'],['--unknown']]) {
    const r=spawnSync(process.execPath,[script.pathname,...args],{encoding:'utf8'}); assert.notEqual(r.status,0,JSON.stringify(args)); assert.equal(r.stdout,'');
  }
  await assert.rejects(audit('pack2',{root:'/tmp/../tmp'}),/unsafe root/);
});

test('missing, extra, duplicate, cross-pack and unsafe assets fail closed',async t=>{
  const root=fixture(t), dest=path.join(root,'schematics/schems/pack2'), index=path.join(dest,'index.json'), original=fs.readFileSync(index);
  const a=path.join(dest,'alpha.mc26.1.schem'), bytes=fs.readFileSync(a);
  fs.unlinkSync(a); write(root,'schematics/tooling/pack2/symmetry.json',{schema:1,targets:['26.1']});
  await assert.rejects(audit('pack2',{root}),/missing target/);
  fs.writeFileSync(a,bytes); write(root,'schematics/tooling/pack2/symmetry.json',{schema:1});
  write(root,'schematics/schems/pack2/rogue.mc1.20.4.schem',bytes); await assert.rejects(audit('pack2',{root}),/unowned/); fs.unlinkSync(path.join(dest,'rogue.mc1.20.4.schem'));
  fs.writeFileSync(index,'{"schemaVersion":2,"groups":{"7":{"3":"alpha.schem","3":"beta.schem"}}}'); await assert.rejects(audit('pack2',{root}),/duplicate JSON key/);
  write(root,'schematics/schems/pack2/index.json',{schemaVersion:2,groups:{'7':{'3':'alpha.schem','4':'alpha.schem'}}}); await assert.rejects(audit('pack2',{root}),/duplicate manifest/);
  fs.writeFileSync(index,original);
  const source=path.join(root,'schematics/blueprints/pack2/alpha.json'), originalSource=fs.readFileSync(source), d=JSON.parse(originalSource); d.source_image='schematics/screenshots/pack3/x.png'; fs.writeFileSync(source,JSON.stringify(d));
  await assert.rejects(audit('pack2',{root}),/cross-pack/); fs.writeFileSync(source,originalSource);
  fs.unlinkSync(a); fs.symlinkSync('/etc/passwd',a); await assert.rejects(audit('pack2',{root}),/symlink/);
});

test('unsupported targets and failed explicit expectations never report success',async t=>{
  const root=fixture(t), dest='schematics/schems/pack3/other.mc99.99.schem';
  write(root,dest,fs.readFileSync(path.join(root,'schematics/schems/pack3/other.mc1.20.4.schem')));
  write(root,'schematics/tooling/pack3/symmetry.json',{schema:1,builds:{other:{planes:[{plane:'x=0',intent:'exact'}]}}});
  const r=await audit('pack3',{root});
  assert.equal(r.status,'incomplete'); assert.equal(r.builds[0].symmetry_status,'expectation_failed');
  assert.equal(r.builds[0].schematics.find(s=>s.version==='99.99').status,'unsupported');
});


test('a different pack compares an actual history conversion and optional archive',async t=>{
  const root=fixture(t), source='schematics/blueprints/pack3/other.json';
  const chain='minecraft:chain[axis=x,waterlogged=true]', iron='minecraft:iron_chain[axis=x,waterlogged=true]';
  const d=bp('1.21.4','AA.'); d.legend.A=chain;
  d.source_image='schematics/screenshots/pack3/top.webp';
  write(root,source,d);
  write(root,'schematics/screenshots/pack3/top.webp',Buffer.from('independent reference'));
  write(root,'schematics/schems/pack3/other.mc1.21.4.schem',binary(d,'1.21.4'));
  write(root,'schematics/schems/pack3/other.mc26.1.schem',binary(d,'26.1',{...d.legend,A:iron}));
  fs.unlinkSync(path.join(root,'schematics/schems/pack3/other.mc1.20.4.schem'));
  const original=binary(d,'1.21.4'), archive='schematic-archive/pack3_originals';
  write(root,`${archive}/other.schem`,original);
  write(root,`${archive}/inventory.json`,{schema:1,files:[{name:'other.schem',data_version:d.data_version,bytes:original.length,sha256:createHash('sha256').update(original).digest('hex')}]});
  write(root,'schematics/tooling/pack3/symmetry.json',{schema:1,targets:['1.21.4','26.1'],archive:true});
  const before=inventory(root), r=await audit('pack3',{root}), b=r.builds[0];
  assert.equal(r.status,'complete'); assert.equal(r.reference_photos.length,1);
  assert.deepEqual(b.conversions.map(c=>[c.from,c.to,c.voxel_count,c.target_version]),[[chain,iron,2,'26.1']]);
  assert(b.schematics.every(s=>s.status==='matched' && s.mismatched_voxels===0));
  assert.equal(b.historical_original.mismatched_voxels,0);
  assert.deepEqual(inventory(root),before);
  write(root,'schematics/schems/pack3/other.mc26.1.schem',binary(d,'26.1'));
  const altered=inventory(root), mismatched=await audit('pack3',{root});
  assert.equal(mismatched.status,'incomplete'); assert.equal(mismatched.builds[0].schematics.find(s=>s.version==='26.1').mismatched_voxels,2);
  assert.deepEqual(inventory(root),altered);
  write(root,`${archive}/inventory.json`,{schema:1,files:[]});
  const invalid=inventory(root); await assert.rejects(audit('pack3',{root}),/archive ownership mismatch/); assert.deepEqual(inventory(root),invalid);
});

test('unsupported source releases remain incomplete and all-pack aggregation propagates failures',async t=>{
  const root=fixture(t), source='schematics/blueprints/pack3/other.json';
  const d=bp('1.20.4','AA'); d.minecraft_version='99.99'; d.data_version=99999; write(root,source,d);
  const before=inventory(root), r=await audit('pack3',{root}), all=await auditAll({root});
  assert.equal(r.status,'incomplete'); assert.equal(r.builds[0].symmetry_status,'unsupported');
  assert(r.builds[0].schematics.every(s=>s.status==='unsupported'));
  assert.equal(all.status,'incomplete'); assert.deepEqual(inventory(root),before);
});

test('manifest ownership, unsafe references and symlinked directories fail without mutation',async t=>{
  const root=fixture(t), index='schematics/schems/pack2/index.json', source='schematics/blueprints/pack2/alpha.json';
  const originalIndex=fs.readFileSync(path.join(root,index)), originalSource=fs.readFileSync(path.join(root,source));
  async function rejected(pattern) { const before=inventory(root); await assert.rejects(audit('pack2',{root}),pattern); assert.deepEqual(inventory(root),before); }
  write(root,index,{schemaVersion:2,groups:{'7':{'3':'alpha.schem'}}}); await rejected(/ownership mismatch/);
  fs.writeFileSync(path.join(root,index),originalIndex);
  write(root,'schematics/blueprints/pack2/stray.json',bp('1.20.4','A')); await rejected(/ownership mismatch/);
  fs.unlinkSync(path.join(root,'schematics/blueprints/pack2/stray.json'));
  const d=JSON.parse(originalSource); d.source_image='schematics/screenshots/pack2/../pack3/x.png'; write(root,source,d); await rejected(/missing reference photo/);
  fs.writeFileSync(path.join(root,source),originalSource);
  fs.symlinkSync('/etc',path.join(root,'schematics/screenshots/pack2/escape')); await rejected(/symlink/);
});

test('unreviewed fallback and malformed source or binary never pass as matched',async t=>{
  const root=fixture(t), source='schematics/blueprints/pack3/other.json', target='schematics/schems/pack3/other.mc1.20.4.schem';
  const d=bp('1.21.4','AA'); d.legend.A='minecraft:pale_oak_planks'; write(root,source,d);
  write(root,target,binary(d,'1.20.4'));
  let before=inventory(root), r=await audit('pack3',{root});
  assert.equal(r.status,'incomplete'); assert.equal(r.builds[0].schematics[0].status,'unsupported');
  assert.match(r.builds[0].schematics[0].reason,/no authored fallback/); assert.deepEqual(inventory(root),before);
  d.minecraft_version='1.20.4'; d.data_version=loadRelease('1.20.4').dataVersion; d.legend.A='minecraft:stone'; d.layers=[['A']]; write(root,source,d);
  before=inventory(root); await assert.rejects(audit('pack3',{root})); assert.deepEqual(inventory(root),before);
  d.layers=[['AA']]; write(root,source,d); write(root,target,Buffer.from('not nbt'));
  before=inventory(root); await assert.rejects(audit('pack3',{root})); assert.deepEqual(inventory(root),before);
});


// A self-contained CLI copy keeps real repository assets and authenticated profiles untouched.
function cliFixture(t) {
  const root=fixture(t), project=path.resolve(path.dirname(script.pathname),'../..');
  for(const file of ['audit_pack_symmetry.mjs','symmetry.mjs','convert_history.mjs','history_registry.mjs','block_history.v1.json']) {
    fs.copyFileSync(path.join(project,'schematics/tooling',file),path.join(root,'schematics/tooling',file));
  }
  fs.cpSync(path.join(project,'schematics/tooling/block_history/generated'),path.join(root,'schematics/tooling/block_history/generated'),{recursive:true});
  fs.copyFileSync(path.join(project,'package-lock.json'),path.join(root,'package-lock.json'));
  fs.symlinkSync(path.join(project,'node_modules'),path.join(root,'node_modules'));
  return {root, run:(...args)=>spawnSync(process.execPath,[path.join(root,'schematics/tooling/audit_pack_symmetry.mjs'),...args],{cwd:root,encoding:'utf8'})};
}

test('all-pack CLI continues after ownership errors and reports empty and unknown selections without mutation',async t=>{
  const {root,run}=cliFixture(t);
  const healthyBefore=inventory(root), healthy=run('--all');
  assert.equal(healthy.status,0,healthy.stderr); const healthyReport=JSON.parse(healthy.stdout);
  assert.equal(healthyReport.status,'complete'); assert.deepEqual(healthyReport.packs.map(p=>p.pack),['pack2','pack3']);
  assert.deepEqual(inventory(root),healthyBefore);
  write(root,'schematics/schems/pack2/index.json',{schemaVersion:2,groups:{'7':{'3':'alpha.schem'}}});
  const before=inventory(root), result=run('--all');
  assert.equal(result.status,1); assert.equal(result.stderr,'');
  const report=JSON.parse(result.stdout);
  assert.equal(report.status,'incomplete'); assert.deepEqual(report.packs.map(p=>p.pack),['pack2','pack3']);
  assert.equal(report.packs[0].status,'incomplete'); assert.match(report.packs[0].errors[0],/ownership mismatch/);
  assert.equal(report.packs[1].status,'complete'); assert.equal(report.packs[1].builds[0].source,'schematics/blueprints/pack3/other.json');
  assert.equal(run('--all').stdout,result.stdout); assert.deepEqual(inventory(root),before);
  const single=run('--pack','pack2'); assert.equal(single.status,1); assert.equal(single.stdout,''); assert.match(single.stderr,/ownership mismatch/);
  const unknown=run('--pack','pack999'); assert.equal(unknown.status,1); assert.equal(unknown.stdout,'');
  fs.rmSync(path.join(root,'schematics/blueprints/pack2'),{recursive:true}); fs.rmSync(path.join(root,'schematics/blueprints/pack3'),{recursive:true});
  const emptyBefore=inventory(root), empty=run('--all');
  assert.equal(empty.status,1); assert.deepEqual(JSON.parse(empty.stdout),{schema:1,status:'incomplete',packs:[],errors:['no packs found']});
  assert.deepEqual(inventory(root),emptyBefore);
});

test('explicit target and plane arrays reject null, wrong types and duplicates without mutation',async t=>{
  const root=fixture(t), config='schematics/tooling/pack3/symmetry.json';
  const plane={plane:'x=0',intent:'exact'};
  for(const value of [null,{},'1.20.4',[],['1.20.4','1.20.4']]) {
    write(root,config,{schema:1,targets:value}); const before=inventory(root);
    await assert.rejects(audit('pack3',{root}),/invalid expected targets/); assert.deepEqual(inventory(root),before);
  }
  for(const value of [null,{},'x=0',[plane,plane]]) {
    write(root,config,{schema:1,builds:{other:{planes:value}}}); const before=inventory(root);
    await assert.rejects(audit('pack3',{root}),/invalid plane configuration|duplicate plane configuration/); assert.deepEqual(inventory(root),before);
  }
  write(root,config,{schema:1,builds:{other:{planes:[]}}});
  assert.equal((await audit('pack3',{root})).status,'complete');
});

test('authenticated synthetic partial source profiles yield incomplete JSON but malformed blueprints fail',t=>{
  const {root,run}=cliFixture(t), generated=path.join(root,'schematics/tooling/block_history/generated');
  const indexPath=path.join(generated,'index.json'), index=JSON.parse(fs.readFileSync(indexPath));
  const entry=index.releases.find(e=>e.release==='1.20.4'), configPath=path.join(generated,entry.config);
  const config=JSON.parse(fs.readFileSync(configPath)), registryPath=path.join(generated,config.registry.path);
  const registry=JSON.parse(gunzipSync(fs.readFileSync(registryPath)));
  registry.blocks['minecraft:stone']=null;
  fs.writeFileSync(registryPath,gzipSync(JSON.stringify(registry)));
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  config.registry.sha256=hash(fs.readFileSync(registryPath)); config.coverage='partial'; config.schema_coverage='partial'; config.known_schema_count--; config.unknown_schema_count++;
  fs.writeFileSync(configPath,JSON.stringify(config)); entry.coverage='partial'; entry.sha256=hash(fs.readFileSync(configPath));
  fs.writeFileSync(indexPath,JSON.stringify(index));
  const registryModule=path.join(root,'schematics/tooling/history_registry.mjs');
  fs.writeFileSync(registryModule,fs.readFileSync(registryModule,'utf8').replace(/(INDEX_SHA256 = ')[a-f0-9]{64}/,`$1${hash(fs.readFileSync(indexPath))}`));
  const before=inventory(root), result=run('--pack','pack3');
  assert.equal(result.status,1,result.stderr); const report=JSON.parse(result.stdout);
  assert.equal(report.status,'incomplete'); assert.equal(report.builds[0].symmetry_status,'unsupported');
  assert.match(report.builds[0].symmetry_reason,/partial schema profile/);
  assert(report.builds[0].schematics.every(s=>s.status==='unsupported' && /partial schema profile/.test(s.reason)));
  const mixed=run('--pack','pack2'); assert.equal(mixed.status,1,mixed.stderr);
  const mixedReport=JSON.parse(mixed.stdout);
  assert.equal(mixedReport.status,'incomplete');
  assert.equal(mixedReport.builds[0].schematics.find(s=>s.version==='1.20.4').status,'unsupported');
  assert.equal(mixedReport.builds[1].symmetry_status,'unsupported');
  assert.deepEqual(inventory(root),before);
  const source='schematics/blueprints/pack3/other.json', d=JSON.parse(fs.readFileSync(path.join(root,source)));
  for(const mutate of [v=>v.layers=[['A']],v=>v.data_version=1,v=>v.legend.B='minecraft:not_a_real_block']) {
    const bad=structuredClone(d); mutate(bad); write(root,source,bad); const snapshot=inventory(root), invalid=run('--pack','pack3');
    assert.equal(invalid.status,1); assert.equal(invalid.stdout,''); assert.match(invalid.stderr,/invalid layers|data_version|not a vanilla/); assert.deepEqual(inventory(root),snapshot);
  }
});
