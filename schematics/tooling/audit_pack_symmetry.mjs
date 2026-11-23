#!/usr/bin/env node
// Reproducible, read-only pack voxel audit. JSON goes to stdout only.
import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import nbt from 'prismarine-nbt';
import minecraftData from 'minecraft-data';
import { diagnose, parsePlane, parseState, render, transform } from './symmetry.mjs';
import { convertBlueprint } from './convert_history.mjs';
import { loadRelease, validateBlueprint } from './history_registry.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const invariant = (ok, msg) => { if (!ok) throw new Error(msg); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const digest = b => createHash('sha256').update(b).digest('hex');
const packPattern = /^pack[1-9][0-9]*$/;
const filenamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const versionPattern = /^\d+(?:\.\d+)+$/;
const compareText = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const controls = s => [...s].some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127);

// JSON.parse alone silently accepts duplicate ownership keys.
function uniqueJson(text) {
  let i=0;
  const ws=()=>{ while (/[ \t\r\n]/.test(text[i] ?? '')) i++; };
  const string=()=>{ const start=i++; while(i<text.length) { if(text[i]==='\\') i+=2; else if(text[i++]==='"') return JSON.parse(text.slice(start,i)); } throw new Error('unterminated JSON string'); };
  const value=()=>{
    ws(); if(text[i]==='"') return string();
    if(text[i]==='{') { i++; ws(); const o=Object.create(null); if(text[i]==='}') {i++; return o;} for(;;) { ws(); invariant(text[i]==='"','expected JSON key'); const k=string(); invariant(!Object.hasOwn(o,k),`duplicate JSON key: ${k}`); ws(); invariant(text[i++] === ':','expected colon'); o[k]=value(); ws(); const c=text[i++]; if(c==='}') return o; invariant(c===',','expected comma'); } }
    if(text[i]==='[') { i++; ws(); const a=[]; if(text[i]===']') {i++; return a;} for(;;) { a.push(value()); ws(); const c=text[i++]; if(c===']') return a; invariant(c===',','expected comma'); } }
    const start=i; while(i<text.length && !/[\s,}\]]/.test(text[i])) i++; invariant(i>start,'expected JSON value'); return JSON.parse(text.slice(start,i));
  };
  const result=value(); ws(); invariant(i===text.length,'trailing JSON'); return result;
}

function filesystem(root) {
  invariant(typeof root==='string' && path.isAbsolute(root) && !controls(root), 'root must be an absolute directory');
  invariant(root===path.resolve(root) && fs.lstatSync(root).isDirectory() && fs.realpathSync(root)===root, 'unsafe root');
  function checked(p, optional=false) {
    invariant(typeof p==='string' && p.length && !path.isAbsolute(p) && !path.win32.isAbsolute(p) && !p.includes('\\') && !controls(p) && !/%2f|%5c/i.test(p) && p.split('/').every(c=>c && c!=='.' && c!=='..'), `unsafe path: ${p}`);
    let current=root;
    for(const part of p.split('/')) { current=path.join(current,part); let stat; try { stat=fs.lstatSync(current); } catch(e) { if(optional && e.code==='ENOENT') return null; throw e; } invariant(!stat.isSymbolicLink(),`symlink not allowed: ${p}`); }
    return current;
  }
  const read=p=>{const f=checked(p); invariant(fs.statSync(f).isFile(),`not a file: ${p}`); return fs.readFileSync(f);};
  return {checked,read,hash:p=>digest(read(p)),json:p=>uniqueJson(read(p).toString('utf8')),list:p=>fs.readdirSync(checked(p)).sort(compareText)};
}
export function decodeVarints(data, volume, paletteSize) {
  const result = []; let pos = 0;
  while (pos < data.length) {
    let value=0, shift=0, count=0, byte;
    do {
      invariant(pos < data.length && count < 5, 'truncated or excessive VarInt');
      byte = data[pos++] & 255; value += (byte & 127) * 2**shift; shift += 7; count++;
    } while (byte & 128);
    invariant(value < paletteSize && (count === 1 || value >= 2**(7*(count-1))), 'invalid/noncanonical palette VarInt');
    result.push(value);
  }
  invariant(result.length === volume, 'voxel count mismatch');
  return result;
}

async function compare(p, d, legend, dataVersion, read, hash) {
  const raw=read(p), {parsed} = await nbt.parse(raw), v=parsed.value;
  invariant(parsed.name === 'Schematic' && v.Version.value === 2 && v.DataVersion.value === dataVersion, `${p}: version mismatch`);
  invariant(v.Width.value === d.width_x && v.Height.value === d.height_y && v.Length.value === d.length_z, `${p}: dimensions mismatch`);
  const entries = Object.entries(v.Palette.value).map(([s,t]) => [s,t.value]);
  const states = []; for (const [s,id] of entries) { invariant(Number.isInteger(id) && id >= 0 && id < entries.length && states[id] === undefined, `${p}: invalid palette`); states[id]=s; }
  invariant(v.PaletteMax.value === entries.length, `${p}: palette max mismatch`);
  const actual = decodeVarints(v.BlockData.value, d.width_x*d.height_y*d.length_z, entries.length);
  const differences=[]; let i=0;
  for (let y=0; y<d.height_y; y++) for (let z=0; z<d.length_z; z++) for (const [x,c] of [...d.layers[y][z]].entries()) {
    const a=states[actual[i++]]; if (a !== legend[c]) differences.push({pos:[x,y,z], blueprint:legend[c], schematic:a});
  }
  return {path:p,sha256:hash(p),data_version:dataVersion,voxel_count:i, mismatched_voxels:differences.length, differences,
    palette_equal: JSON.stringify([...new Set(Object.values(legend))].sort()) === JSON.stringify([...states].sort())};
}
function localPairs(d) {
  const registry = minecraftData(d.minecraft_version), pairs=[], cells=[];
  const at=(x,y,z)=>d.legend[[...d.layers[y][z]][x]];
  for (let y=0;y<d.height_y;y++) for (let z=0;z<d.length_z;z++) for (let x=0;x<d.width_x;x++) {
    const a=at(x,y,z), name=a.split('[')[0];
    if (!name.endsWith('_door') && !name.endsWith('_fence_gate')) continue;
    cells.push({position:[x,y,z],state:a});
    for (const [dx,dz] of [[1,0],[0,1]]) {
      if (x+dx>=d.width_x || z+dz>=d.length_z) continue;
      const b=at(x+dx,y,z+dz); if (b.split('[')[0] !== name) continue;
      const plane=parsePlane(dx ? `x=${x+0.5}` : `z=${z+0.5}`);
      pairs.push({positions:[[x,y,z],[x+dx,y,z+dz]],states:[a,b],mirrored:render(transform(parseState(a,registry),plane))===render(parseState(b,registry))});
    }
  }
  return {cells,pairs};
}
export async function audit(pack, options={}) {
  invariant(typeof pack==='string' && packPattern.test(pack),'pack must be a literal packN identifier');
  invariant(object(options) && Object.keys(options).every(k=>k==='root'),'invalid audit options');
  const io=filesystem(options.root ?? projectRoot), {checked,read,hash,json,list}=io;
  const base=`schematics/blueprints/${pack}`, dest=`schematics/schems/${pack}`, photos=`schematics/screenshots/${pack}`;
  const configPath=`schematics/tooling/${pack}/symmetry.json`;
  const config=checked(configPath,true) ? json(configPath) : {schema:1};
  invariant(object(config) && config.schema===1 && Object.keys(config).every(k=>['schema','targets','archive','builds'].includes(k)), 'invalid symmetry configuration');
  const targets=Object.hasOwn(config,'targets') ? config.targets : [];
  invariant(Array.isArray(targets) && (!Object.hasOwn(config,'targets') || targets.length>0) && targets.every(v=>typeof v==='string' && versionPattern.test(v)) && new Set(targets).size===targets.length,'invalid expected targets');
  invariant(config.archive===undefined || typeof config.archive==='boolean','invalid archive configuration');
  invariant(config.builds===undefined || object(config.builds),'invalid build configuration');
  const indexPath=`${dest}/index.json`, index=json(indexPath);
  invariant(object(index) && index.schemaVersion===2 && Object.keys(index).sort().join(',')==='groups,schemaVersion' && object(index.groups),'invalid manifest');
  const families=new Map();
  for(const [group,items] of Object.entries(index.groups)) {
    invariant(/^[1-9][0-9]*$/.test(group) && Number.isSafeInteger(Number(group)) && object(items),`invalid manifest group: ${group}`);
    for(const [id,name] of Object.entries(items)) {
      invariant(/^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id)) && typeof name==='string' && name.endsWith('.schem') && filenamePattern.test(name.slice(0,-6)),`invalid manifest entry: ${group}:${id}`);
      invariant(!families.has(name),`duplicate manifest family: ${name}`);
      families.set(name,{group,id});
    }
  }
  invariant(families.size>0,'empty manifest');
  const sources=list(base).filter(n=>n.endsWith('.json') && !/\.(?:provenance|validation|manifest|metadata|config|report|refs|references)\.json$/i.test(n));
  const expectedSources=[...families.keys()].map(n=>`${n.slice(0,-6)}.json`).sort(compareText);
  invariant(JSON.stringify(sources)===JSON.stringify(expectedSources),'source and manifest ownership mismatch');
  for(const name of Object.keys(config.builds ?? {})) invariant(families.has(`${name}.schem`),`unowned build configuration: ${name}`);
  const variants=new Map([...families.keys()].map(n=>[n,[]]));
  const destFiles=list(dest);
  for(const name of destFiles) {
    const p=`${dest}/${name}`; checked(p);
    if (!name.endsWith('.schem')) continue;
    const m=/^([a-zA-Z0-9][a-zA-Z0-9_-]*)\.mc(\d+(?:\.\d+)+)\.schem$/.exec(name);
    invariant(m && families.has(`${m[1]}.schem`),`unowned or malformed schematic: ${name}`);
    variants.get(`${m[1]}.schem`).push({name,version:m[2]});
  }
  for(const [family,vs] of variants) {
    invariant(vs.length>0,`missing variants: ${family}`);
    invariant(new Set(vs.map(v=>v.version)).size===vs.length,`duplicate variants: ${family}`);
    for(const target of targets) invariant(vs.some(v=>v.version===target),`missing target ${target}: ${family}`);
  }
  for(const name of destFiles.filter(n=>/\.schem\.provenance\.(json|sha256)$/.test(n))) {
    const artifact=name.replace(/\.provenance\.(json|sha256)$/,'');
    invariant(destFiles.includes(artifact),`orphan metadata: ${name}`);
    const other=`${artifact}.provenance.${name.endsWith('.json') ? 'sha256' : 'json'}`;
    invariant(destFiles.includes(other),`incomplete metadata: ${name}`);
    if(name.endsWith('.json')) {
      const meta=json(`${dest}/${name}`), match=/^(.*)\.mc(\d+(?:\.\d+)+)\.schem$/.exec(artifact);
      invariant(object(meta) && match && meta.artifact===artifact && meta.blueprint===`${base}/${match[1]}.json` && (meta.convertTo ?? meta.targetVersion ?? json(meta.blueprint).minecraft_version)===match[2] && meta.sha256===hash(`${dest}/${artifact}`) && meta.blueprintSha256===hash(meta.blueprint) && read(`${dest}/${other}`).toString('utf8').trim()===hash(`${dest}/${name}`),`metadata ownership mismatch: ${name}`);
    }
  }
  const references=[];
  function photosIn(dir) {
    for(const name of list(dir)) { const p=`${dir}/${name}`, stat=fs.statSync(checked(p)); if(stat.isDirectory()) photosIn(p); else if(stat.isFile() && /\.(?:jpe?g|png|webp)$/i.test(name)) references.push({path:p,sha256:hash(p)}); }
  }
  if(checked(photos,true)) photosIn(photos);
  let archived=new Map(), archive=null;
  if(config.archive) {
    archive=`schematic-archive/${pack}_originals`;
    const inv=json(`${archive}/inventory.json`);
    invariant(object(inv) && inv.schema===1 && Array.isArray(inv.files),'invalid archive inventory');
    for(const entry of inv.files) {
      invariant(object(entry) && families.has(entry.name) && !archived.has(entry.name) && Number.isSafeInteger(entry.data_version) && hash(`${archive}/${entry.name}`)===entry.sha256 && read(`${archive}/${entry.name}`).length===entry.bytes,`archive inventory mismatch: ${entry.name}`);
      archived.set(entry.name,entry);
    }
    invariant(archived.size===families.size && JSON.stringify(list(archive).filter(n=>n.endsWith('.schem')))===JSON.stringify([...families.keys()].sort(compareText)),'archive ownership mismatch');
  }
  const tool=filesystem(projectRoot), history=tool.json('schematics/tooling/block_history.v1.json');
  const inputPaths=new Set(['schematics/tooling/audit_pack_symmetry.mjs','schematics/tooling/symmetry.mjs','schematics/tooling/convert_history.mjs','schematics/tooling/history_registry.mjs','schematics/tooling/block_history.v1.json','schematics/tooling/block_history/generated/index.json','package-lock.json']);
  const release=v=>{
    const r=loadRelease(v), prefix='schematics/tooling/block_history/generated/';
    inputPaths.add(`${prefix}releases/${v}.json`);
    for(const ref of [r.config.registry,r.config.delta]) inputPaths.add(prefix+ref.path);
    return r;
  };
  const builds=[];
  for(const file of sources) {
    const source=`${base}/${file}`, d=json(source), stem=file.slice(0,-5), family=`${stem}.schem`;
    if(d.pack!==undefined) invariant(d.pack===pack,`cross-pack source metadata: ${source}`);
    if(d.source_image!==undefined) { invariant(typeof d.source_image==='string' && d.source_image.startsWith(`${photos}/`),`cross-pack photo metadata: ${source}`); invariant(references.some(r=>r.path===d.source_image),`missing reference photo: ${d.source_image}`); }
    invariant(object(d) && typeof d.minecraft_version==='string' && versionPattern.test(d.minecraft_version),'invalid source version');
    invariant(Number.isSafeInteger(d.data_version) && d.data_version>0,'invalid source DataVersion');
    invariant([d.width_x,d.height_y,d.length_z].every(n=>Number.isSafeInteger(n) && n>0),'invalid dimensions');
    invariant(object(d.legend) && Object.keys(d.legend).length>0,'invalid legend');
    for(const [key,state] of Object.entries(d.legend)) {
      invariant([...key].length===1 && typeof state==='string' && /^minecraft:[a-z0-9_./-]+(?:\[[a-z0-9_]+=[a-z0-9_]+(?:,[a-z0-9_]+=[a-z0-9_]+)*\])?$/.test(state),'invalid legend entry');
      const properties=state.includes('[') ? state.slice(state.indexOf('[')+1,-1).split(',').map(p=>p.split('=')[0]) : [];
      invariant(new Set(properties).size===properties.length,'duplicate state property');
    }
    invariant(Array.isArray(d.layers) && d.layers.length===d.height_y && d.layers.every(layer=>Array.isArray(layer) && layer.length===d.length_z && layer.every(row=>typeof row==='string' && [...row].length===d.width_x && [...row].every(c=>Object.hasOwn(d.legend,c)))),'invalid layers or row');
    const spec=config.builds && Object.hasOwn(config.builds,stem) ? config.builds[stem] : {};
    invariant(object(spec) && Object.keys(spec).every(k=>k==='planes'),'invalid build symmetry configuration');
    const extra=Object.hasOwn(spec,'planes') ? spec.planes : [];
    invariant(Array.isArray(extra) && extra.every(p=>object(p) && Object.keys(p).every(k=>['plane','bounds','intent'].includes(k)) && typeof p.plane==='string' && (p.bounds===undefined || typeof p.bounds==='string') && ['measure','exact','asymmetric'].includes(p.intent)),`invalid plane configuration: ${stem}`);
    invariant(new Set(extra.map(p=>JSON.stringify([p.plane,p.bounds ?? null]))).size===extra.length,`duplicate plane configuration: ${stem}`);
    for(const p of extra) {
      parsePlane(p.plane);
      if(p.bounds!==undefined) {
        invariant(/^\d+,\d+,\d+,\d+,\d+,\d+$/.test(p.bounds),`invalid bounds: ${stem}`);
        const b=p.bounds.split(',').map(Number), sizes=[d.width_x,d.height_y,d.length_z];
        invariant(b.every(Number.isSafeInteger) && b.every((n,i)=>n<sizes[Math.floor(i/2)]) && b[0]<=b[1] && b[2]<=b[3] && b[4]<=b[5],`invalid bounds: ${stem}`);
      }
    }
    const defaults=[`x=${(d.width_x-1)/2}`,`z=${(d.length_z-1)/2}`];
    if(d.width_x===d.length_z) defaults.push('x=z',`x=-z+${d.width_x-1}`);
    const planes=[...defaults.map(plane=>({plane,intent:'measure'})),...extra];
    let profile, unsupported;
    try { profile=release(d.minecraft_version); }
    catch(e) {
      if(!/unsupported or missing exact Java release|unsupported or unavailable coverage/i.test(e.message)) throw e;
      unsupported=e.message;
    }
    if(profile && profile.config.coverage==='partial') {
      // Check every known schema and structural invariant, even after an unknown schema.
      for(const [key,state] of Object.entries(d.legend)) {
        try { validateBlueprint({...d,legend:{[key]:state}},profile,true); }
        catch(e) { if(!/^unknown schema for /.test(e.message)) throw e; }
      }
      unsupported=`partial schema profile for ${profile.version}; source validation is incomplete`;
    } else if(profile) validateBlueprint(d,profile);
    if(unsupported) {
      builds.push({id:families.get(family),source,sha256:hash(source),minecraft_version:d.minecraft_version,data_version:d.data_version,dimensions:[d.width_x,d.height_y,d.length_z],symmetry_status:'unsupported',symmetry_reason:unsupported,symmetry:[],door_gate_cells:[],local_door_gate_pairs:[],conversions:[],schematics:variants.get(family).map(v=>({path:`${dest}/${v.name}`,sha256:hash(`${dest}/${v.name}`),version:v.version,status:'unsupported',reason:unsupported})),historical_original:null});
      continue;
    }
    let symmetry=[], local={cells:[],pairs:[]}, symmetryStatus='measured', reason=null;
    try {
      symmetry=planes.map(p=>{ const r=diagnose(d,p.plane,p.bounds); const n=r.mismatches.length, o=r.out_of_bounds.occupied.length; return {...r,intent:p.intent,expectation_met:p.intent==='measure' ? null : p.intent==='exact' ? r.exact : !r.exact,mismatch_total:n,mismatches:r.mismatches.slice(0,12),mismatches_truncated:Math.max(0,n-12),out_of_bounds:{...r.out_of_bounds,occupied:r.out_of_bounds.occupied.slice(0,12),occupied_total:o,occupied_truncated:Math.max(0,o-12)}}; });
      local=localPairs(d);
      if(symmetry.some(r=>r.expectation_met===false)) symmetryStatus='expectation_failed';
    } catch(e) {
      if(!/unsupported or inconsistent registry version|unsupported .*transform|cannot mirror|unsupported.*state/i.test(e.message)) throw e;
      symmetryStatus='unsupported'; reason=e.message;
    }
    const results=[], conversions=[], seenDataVersions=new Set();
    for(const v of variants.get(family)) {
      const p=`${dest}/${v.name}`; let converted;
      try { const target=release(v.version); invariant(!seenDataVersions.has(target.dataVersion),`duplicate target DataVersion: ${family}`); seenDataVersions.add(target.dataVersion); converted=convertBlueprint(d,v.version,history); }
      catch(e) {
        if(!/unsupported or missing exact Java release|unsupported or unavailable coverage|partial schema profile|no authored fallback|unknown legal combinations/i.test(e.message)) throw e;
        results.push({path:p,sha256:hash(p),version:v.version,status:'unsupported',reason:e.message}); continue;
      }
      const result=await compare(p,d,converted.legend,converted.targetDataVersion,read,hash);
      results.push({...result,version:v.version,status:result.mismatched_voxels || !result.palette_equal ? 'mismatch' : 'matched'});
      conversions.push(...converted.changes.map(c=>({...c,target_version:v.version,voxel_count:d.layers.flatMap(layer=>layer.flatMap(row=>[...row])).filter(ch=>d.legend[ch]===c.from).length})));
    }
    let historical_original=null;
    if(archive) { const item=archived.get(family); invariant(item.data_version===profile.dataVersion,`archive DataVersion mismatch: ${family}`); historical_original=await compare(`${archive}/${family}`,d,d.legend,item.data_version,read,hash); }
    builds.push({id:families.get(family),source,sha256:hash(source),minecraft_version:d.minecraft_version,data_version:d.data_version,dimensions:[d.width_x,d.height_y,d.length_z],symmetry_status:symmetryStatus,symmetry_reason:reason,symmetry,door_gate_cells:local.cells,local_door_gate_pairs:local.pairs,conversions,schematics:results,historical_original});
  }
  const inputs=[...inputPaths].sort(compareText).map(p=>({path:p,sha256:tool.hash(p)}));
  inputs.push({path:indexPath,sha256:hash(indexPath)});
  for(const name of destFiles.filter(n=>/\.schem\.provenance\.(json|sha256)$/.test(n))) inputs.push({path:`${dest}/${name}`,sha256:hash(`${dest}/${name}`)});
  if(checked(configPath,true)) inputs.push({path:configPath,sha256:hash(configPath)});
  if(archive) inputs.push({path:`${archive}/inventory.json`,sha256:hash(`${archive}/inventory.json`)});
  const status=builds.some(b=>b.symmetry_status!=='measured' || b.schematics.some(s=>s.status!=='matched')) ? 'incomplete' : 'complete';
  return {schema:3,pack,status,method:'Read-only reflection measurements and independent Sponge v2 voxel comparisons; photo inventory is not visual analysis.',inputs,reference_photos:references,builds};
}

export async function auditAll(options={}) {
  invariant(object(options) && Object.keys(options).every(k=>k==='root'),'invalid audit options');
  const io=filesystem(options.root ?? projectRoot), dir='schematics/blueprints';
  const names=io.list(dir).filter(n=>packPattern.test(n));
  const packs=[];
  for(const name of names) {
    try {
      invariant(fs.statSync(io.checked(`${dir}/${name}`)).isDirectory(),`invalid pack: ${name}`);
      packs.push(await audit(name,options));
    } catch(e) { packs.push({pack:name,status:'incomplete',errors:[e.message]}); }
  }
  return {schema:1,status:packs.length && packs.every(p=>p.status==='complete') ? 'complete' : 'incomplete',packs,...(packs.length ? {} : {errors:['no packs found']})};
}
async function main() {
  const args=process.argv.slice(2);
  try {
    invariant(args.length===1 && args[0]==='--all' || args.length===2 && args[0]==='--pack' && packPattern.test(args[1]),'usage: audit_pack_symmetry.mjs --pack packN | --all');
    const report=await (args[0]==='--all' ? auditAll() : audit(args[1]));
    console.log(JSON.stringify(report,null,2)); if(report.status!=='complete') process.exitCode=1;
  } catch(e) { console.error(`symmetry audit failed: ${e.message}`); process.exitCode=1; }
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) void main();
