#!/usr/bin/env node
// Deliberately narrow repair policy: unknown or neighbour-dependent blocks fail closed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { diagnose, parsePlane, parseState, render, transform } from './symmetry.mjs';

const mc = createRequire(import.meta.url)('minecraft-data');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const key = p => p.join(',');
const stable = value => JSON.stringify(value);
// This intentionally excludes every block with connectivity, support, block entities,
// multiblock structure, or dynamic state, even when its reflection is known.
const inert = name => /^(?:minecraft:air|minecraft:(?:white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_(?:wool|concrete|terracotta)|minecraft:(?:stone|cobblestone|dirt|sandstone|bricks|glass)|minecraft:(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_(?:planks|log|wood)|minecraft:stripped_(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_(?:log|wood))$/.test(name);

function validateMetadata(d) {
  if (!d.expected_counts || typeof d.expected_counts !== 'object' || Array.isArray(d.expected_counts) || !Array.isArray(d.spot_checks)) fail('expected_counts and spot_checks required');
  const counts = {};
  for (const layer of d.layers) for (const row of layer) for (const ch of [...row]) {
    const state = d.legend[ch]; counts[state] = (counts[state] || 0) + 1;
  }
  if (stable(Object.entries(counts).sort()) !== stable(Object.entries(d.expected_counts).sort())) fail('source expected_counts inconsistent');
  if ('non_air_count' in d && d.non_air_count !== d.width_x*d.height_y*d.length_z - (counts['minecraft:air'] || 0)) fail('source non_air_count inconsistent');
  const registry = mc(d.minecraft_version);
  for (const s of d.spot_checks) {
    if (!s || typeof s !== 'object' || !['x','y','z'].every(k => Number.isSafeInteger(s[k])) || s.x < 0 || s.x >= d.width_x || s.y < 0 || s.y >= d.height_y || s.z < 0 || s.z >= d.length_z || [...d.layers[s.y][s.z]][s.x] !== s.char) fail('source spot_checks inconsistent');
    if (Object.hasOwn(s, 'state')) {
      let asserted;
      try {
        if (typeof s.state !== 'string' || /\s/.test(s.state)) fail('block state must be a whitespace-free string');
        asserted = render(parseState(s.state, registry));
      }
      catch (e) { fail(`source spot_checks invalid state: ${e.message}`); }
      if (asserted !== render(parseState(d.legend[s.char], registry))) fail('source spot_checks inconsistent state');
    }
  }
}

export function plan(bytes, config) {
  const d = JSON.parse(bytes.toString('utf8'));
  if (!config || stable(Object.keys(config).sort()) !== stable(['allow', 'authoritative', 'bounds', 'plane', 'threshold'])) fail('config requires exactly plane, bounds, authoritative, threshold, allow');
  if (typeof config.bounds !== 'string' || !/^(?:\d+,){5}\d+(?![\s\S])/.test(config.bounds) || !['low','high'].includes(config.authoritative) || typeof config.threshold !== 'number' || config.threshold < 0.95 || config.threshold > 1 || !Array.isArray(config.allow)) fail('explicit bounds, low/high side, threshold 0.95..1, and allowlist required');
  const allowed = config.allow.map(p => { if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isSafeInteger)) fail('invalid allowlist coordinate'); return key(p); });
  if (new Set(allowed).size !== allowed.length) fail('duplicate allowlist coordinate');
  const report = diagnose(d, config.plane, config.bounds);
  validateMetadata(d);
  if (report.out_of_bounds.cells || report.center.mismatched) fail(`unsafe region: ${report.out_of_bounds.cells} reflected cells outside bounds, ${report.center.mismatched} center mismatches`);
  if (report.pairs.coverage === null || report.pairs.coverage < config.threshold) fail(`unsafe agreement: ${report.pairs.matched}/${report.pairs.compared} below threshold ${config.threshold}; no authoritative side inferred`);
  const plane = parsePlane(config.plane), registry = mc(d.minecraft_version);
  const side = ([x,,z]) => plane.kind === 'x' ? x-plane.value : plane.kind === 'z' ? z-plane.value : plane.kind === 'diagonal' ? x-z-plane.value : x+z-plane.value;
  const at = ([x,y,z]) => d.legend[[...d.layers[y][z]][x]];
  const changes = report.mismatches.map(m => {
    const from = (config.authoritative === 'low' ? side(m.from) < 0 : side(m.from) > 0) ? m.from : m.to;
    const to = from === m.from ? m.to : m.from;
    const before = at(to), source = at(from);
    const transformed = render(transform(parseState(source, registry), plane));
    const existing = Object.values(d.legend).find(s => render(parseState(s, registry)) === transformed);
    return { from, to, source, before, after: existing ?? transformed, class: m.class };
  });
  if (stable(changes.map(c => key(c.to)).sort()) !== stable([...allowed].sort())) fail('allowlist must exactly equal all changed target positions, including air edits');
  const dirs = [[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (const c of changes) {
    if (!inert(c.before.split('[')[0]) || !inert(c.after.split('[')[0])) fail(`unsupported or neighbour-dependent edit at ${key(c.to)}`);
    for (const p of [c.from, c.to]) for (const [dx,dy,dz] of dirs) {
      const q = [p[0]+dx,p[1]+dy,p[2]+dz];
      if (q[0] >= 0 && q[0] < d.width_x && q[1] >= 0 && q[1] < d.height_y && q[2] >= 0 && q[2] < d.length_z && !inert(at(q).split('[')[0])) fail(`neighbour-dependent or unsupported neighbour at ${key(q)}`);
    }
    if (d.spot_checks.some(s => key([s.x,s.y,s.z]) === key(c.to) && Object.keys(s).some(k => !['x','y','z','char'].includes(k)))) fail(`annotated spot check at ${key(c.to)} requires manual review`);
  }
  return { schema: 1, source_sha256: sha(bytes), config, report, changes, warning: 'Agreement is not evidence of intended symmetry; verify every change against references. No side was selected automatically.' };
}

export function derive(bytes, approved) {
  const current = plan(bytes, approved.config);
  if (stable(current) !== stable(approved)) fail('approved patch does not exactly match current source and plan');
  const d = JSON.parse(bytes.toString('utf8'));
  for (const c of current.changes) {
    let symbol = Object.keys(d.legend).find(k => d.legend[k] === c.after);
    if (!symbol) {
      symbol = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-/:;<=>?@^_{}~'].find(k => !Object.hasOwn(d.legend, k));
      if (!symbol) fail('no safe legend symbol available');
      d.legend[symbol] = c.after;
    }
    const [x,y,z] = c.to, row = [...d.layers[y][z]]; row[x] = symbol; d.layers[y][z] = row.join('');
    for (const s of d.spot_checks) if (s.x === x && s.y === y && s.z === z) s.char = symbol;
  }
  const counts = {};
  for (const layer of d.layers) for (const row of layer) for (const ch of [...row]) counts[d.legend[ch]] = (counts[d.legend[ch]] || 0) + 1;
  d.expected_counts = counts;
  if ('non_air_count' in d) d.non_air_count = d.width_x*d.height_y*d.length_z - (counts['minecraft:air'] || 0);
  validateMetadata(d);
  if (!diagnose(d, approved.config.plane, approved.config.bounds).exact) fail('derived region is not exactly symmetric');
  return Buffer.from(JSON.stringify(d, null, 2) + '\n');
}

// Refuse symlinks in every existing component; outputs must not already exist.
function noSymlinks(file, missingLeaf = false) {
  const absolute = path.resolve(file), parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (let i=0; i<parts.length; i++) {
    current = path.join(current, parts[i]);
    try { if (fs.lstatSync(current).isSymbolicLink()) fail(`symlink refused: ${current}`); }
    catch (e) { if (e.code === 'ENOENT' && missingLeaf && i === parts.length-1) return; throw e; }
  }
}
function readSafe(file) { noSymlinks(file); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { if (!fs.fstatSync(fd).isFile()) fail('input must be a regular file'); return fs.readFileSync(fd); } finally { fs.closeSync(fd); } }
function install(file, bytes) {
  noSymlinks(file, true);
  const tmp = path.join(path.dirname(path.resolve(file)), `.symmetry-${randomUUID()}.tmp`);
  try { fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 }); fs.linkSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function main(args) {
  if (args.length === 3 && args[0] === '--plan') {
    const bytes = readSafe(args[1]), config = JSON.parse(readSafe(args[2]));
    console.log(JSON.stringify(plan(bytes, config), null, 2)); return;
  }
  if (args.length === 5 && args[0] === '--apply' && args[3] === '--output') {
    const source = args[1], approval = JSON.parse(readSafe(args[2])), output = args[4];
    if (path.resolve(source) === path.resolve(output)) fail('source overwrite is forbidden');
    const bytes = readSafe(source), derived = derive(bytes, approval);
    const receipt = { schema: 1, source, output, source_sha256: sha(bytes), output_sha256: sha(derived), approved_patch: approval };
    const receiptPath = `${output}.symmetry-audit.json`;
    noSymlinks(output, true); noSymlinks(receiptPath, true);
    if (fs.existsSync(output) || fs.existsSync(receiptPath)) fail('output or receipt already exists');
    if (sha(readSafe(source)) !== approval.source_sha256) fail('source changed before write');
    install(receiptPath, Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
    try { install(output, derived); } catch (e) { fs.unlinkSync(receiptPath); throw e; }
    console.log(JSON.stringify(receipt, null, 2)); return;
  }
  fail('usage: symmetry_fix.mjs --plan SOURCE CONFIG | --apply SOURCE APPROVED_PATCH --output NEW_FILE');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`symmetry fix refused: ${e.message}`); process.exitCode = 2; }
}
