#!/usr/bin/env node
// Read-only: reports are written to stdout, never to the pack or its assets.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { diagnoseBlueprint } from './mechanics_model_1_21_4.mjs';
export { diagnoseBlueprint } from './mechanics_model_1_21_4.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = data => createHash('sha256').update(data).digest('hex');
const implementation = 'schematics/tooling/audit_pack_mechanics.mjs';
const modelFile = 'schematics/tooling/mechanics_model_1_21_4.mjs';
const hasControls = text => [...text].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

function validatePack(pack) {
  if (typeof pack !== 'string' || !/^pack[1-9][0-9]*$/.test(pack)) {
    throw new Error('pack must be a literal packN identifier with a positive integer, e.g. pack2');
  }
}

// Refuse symlinks altogether on the selected source path, including file entries.
// This prevents both escape and aliasing, without depending on the current cwd.
function checkedDirectory(parent, name) {
  const target = path.join(parent, name);
  const info = fs.lstatSync(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe or non-directory path: ${target}`);
  return target;
}

export function auditPack(pack, options = {}) {
  validatePack(pack);
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => k !== 'root')) {
    throw new Error('invalid audit configuration');
  }
  const root = options.root ?? projectRoot;
  if (typeof root !== 'string' || !path.isAbsolute(root) || hasControls(root)) throw new Error('root must be an absolute directory path');
  const rootInfo = fs.lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || fs.realpathSync(root) !== path.resolve(root)) throw new Error('unsafe or non-directory root');
  const base = `schematics/blueprints/${pack}`;
  const directory = checkedDirectory(checkedDirectory(checkedDirectory(root, 'schematics'), 'blueprints'), pack);
  const builds = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes:true}).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!entry.name.endsWith('.json')) continue;
    if (hasControls(entry.name) || entry.name.includes('\\') || /%2f|%5c/i.test(entry.name)) throw new Error(`unsafe source filename in ${base}`);
    // These conventional sidecars are not source blueprints, even if they contain blueprint-like metadata.
    if (/\.(?:provenance|validation|manifest|metadata|config|report|refs|references)\.json$/i.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`unsafe or non-file source: ${base}/${entry.name}`);
    const raw = fs.readFileSync(file);
    let blueprint;
    try { blueprint = JSON.parse(raw); } catch (error) { throw new Error(`invalid JSON in ${base}/${entry.name}: ${error.message}`); }
    // Non-blueprint JSON metadata is ignored; partial blueprint-like objects are reported as skipped.
    if (!blueprint || typeof blueprint !== 'object' || Array.isArray(blueprint) ||
        !(['layers','legend','width_x','height_y','length_z'].some(key => Object.hasOwn(blueprint,key)) ||
          ['explicit-layer-matrix-v1','explicit_layers_v1'].includes(blueprint.schema))) continue;
    const source = `${base}/${entry.name}`;
    builds.push({source, sha256:digest(raw), minecraft_version:blueprint.minecraft_version ?? null,
      data_version:blueprint.data_version ?? null, ...diagnoseBlueprint(blueprint)});
  }
  if (!builds.length) throw new Error(`no source blueprints found in ${base}`);
  const modeled = builds.filter(b => b.status === 'modeled').length;
  const skipped = builds.length - modeled;
  const unknown = builds.filter(b => b.status === 'modeled' && (b.unmodeled.length || b.stairs.unknown.length || b.carpets.unknown)).length;
  return {
    schema:2, pack, status:skipped ? 'incomplete' : unknown ? 'modeled_with_unknowns' : 'modeled',
    summary:{sources:builds.length, modeled, skipped, with_unknowns:unknown},
    model:'Mojang Java Edition 1.21.4, data version 4189',
    method:'Read-only blueprint snapshot; stair shape recalculation and wool carpet non-air-below predicate only.',
    limits:'Not symmetry, placement, a live-server test, or a prediction of update timing. Outside-volume and incomplete states are unknown. Other block support rules are not modeled. Authored stair shapes may be intentional and may persist until updated. No rules for other Minecraft versions are tested.',
    implementation:{path:implementation, sha256:digest(fs.readFileSync(path.join(projectRoot,implementation)))},
    mechanics_model:{path:modelFile, sha256:digest(fs.readFileSync(path.join(projectRoot,modelFile)))},
    registry_dependency:{path:'package-lock.json', sha256:digest(fs.readFileSync(path.join(projectRoot,'package-lock.json')))},
    vanilla_evidence:{server_sha1:'4707d00eb834b446575d89a61a11b5d548d8c001', mappings_sha1:'0b1e60cc509cfb0172573ae56b436c29febbc187', details:'schematics/tooling/PACK_MECHANICS.md'},
    builds
  };
}

function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--pack') throw new Error('usage: node schematics/tooling/audit_pack_mechanics.mjs --pack packN');
  validatePack(args[1]);
  return args[1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report = auditPack(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
    if (report.summary.skipped) process.exitCode = 1;
  } catch (error) {
    console.error(`pack mechanics audit failed: ${error.message}`);
    process.exitCode = 1;
  }
}
