#!/usr/bin/env node
// Reproducible, read-only pack1 voxel audit. JSON goes to stdout only.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import nbt from 'prismarine-nbt';
import minecraftData from 'minecraft-data';
import { diagnose, parsePlane, parseState, render, transform } from './symmetry.mjs';
import { convertBlueprint } from './convert_history.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const read = p => fs.readFileSync(path.join(root,p));
const hash = p => createHash('sha256').update(read(p)).digest('hex');
const json = p => JSON.parse(read(p));
const list = p => fs.readdirSync(path.join(root,p)).sort();
const invariant = (ok, msg) => { if (!ok) throw new Error(msg); };
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

async function compare(p, d, legend, dataVersion) {
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
export async function audit() {
  const base='schematics/blueprints/pack1', dest='schematics/schems/pack1', photos='schematics/screenshots/pack1';
  const files=list(base).filter(n=>n.endsWith('.json'));
  const history=json('schematics/tooling/block_history.v1.json');
  const references=[];
  for (const folder of list(photos)) {
    const p=`${photos}/${folder}`;
    if (fs.statSync(path.join(root,p)).isDirectory()) for (const f of list(p)) { const q=`${p}/${f}`; if (/\.jpe?g$/i.test(f)) references.push({path:q,sha256:hash(q)}); }
    else if (/\.jpe?g$/i.test(folder)) references.push({path:p,sha256:hash(p)});
  }
  const builds=[];
  for (const file of files) {
    const source=`${base}/${file}`, d=json(source), stem=file.slice(0,-5);
    const planes=[`x=${(d.width_x-1)/2}`,`z=${(d.length_z-1)/2}`];
    if (d.width_x===d.length_z) planes.push('x=z',`x=-z+${d.width_x-1}`);
    const symmetry=planes.map(p=>{
      const r=diagnose(d,p); return {...r,mismatches:r.mismatches.slice(0,12),mismatches_truncated:r.mismatches.length>12,out_of_bounds:{...r.out_of_bounds,occupied:r.out_of_bounds.occupied.slice(0,12),occupied_total:r.out_of_bounds.occupied.length}};
    });
    const converted=convertBlueprint(d,'26.1',history);
    const results=[];
    for (const [suffix,legend,version] of [['',d.legend,d.data_version],['.mc1.21.4',d.legend,4189],['.mc26.1',converted.legend,converted.targetDataVersion]]) results.push(await compare(`${dest}/${stem}${suffix}.schem`,d,legend,version));
    const conversions=converted.changes.map(c=>({...c,voxel_count:d.layers.flatMap(layer=>layer.flatMap(row=>[...row])).filter(ch=>d.legend[ch]===c.from).length}));
    const local=localPairs(d);
    builds.push({source,sha256:hash(source),dimensions:[d.width_x,d.height_y,d.length_z],symmetry,door_gate_cells:local.cells,local_door_gate_pairs:local.pairs,conversions,schematics:results});
  }
  const inputPaths=['schematics/schems/pack1/index.json','schematics/tooling/symmetry.mjs','schematics/tooling/audit_pack1_symmetry.mjs','schematics/tooling/convert_history.mjs','schematics/tooling/history_registry.mjs','schematics/tooling/block_history.v1.json','schematics/tooling/block_history/generated/releases/1.21.4.json','schematics/tooling/block_history/generated/releases/26.1.json','schematics/tooling/block_history/generated/registries/1.21.4.json.gz','schematics/tooling/block_history/generated/registries/26.1.json.gz','package-lock.json'];
  return {schema:1,method:'Read-only full-volume paired-state reflection and independent NBT voxel decoding; photo hashes are inventory, not machine visual analysis.',inputs:inputPaths.map(p=>({path:p,sha256:hash(p)})),reference_photos:references,builds};
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  audit().then(report=>console.log(JSON.stringify(report,null,2))).catch(e=>{console.error(`pack1 audit failed: ${e.stack}`);process.exitCode=1;});
}
