#!/usr/bin/env node
// Voxel reflection diagnostic; patch application is deliberately separate and opt-in.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const minecraftData = require('minecraft-data');
const directions = ['north', 'east', 'south', 'west'];
const unchanged = new Set(['age', 'candles', 'distance', 'enabled', 'extended', 'face', 'half',
  'hanging', 'has_bottle_0', 'has_bottle_1', 'has_bottle_2', 'in_wall', 'inverted', 'layers',
  'leaves', 'level', 'lit', 'mode', 'open', 'persistent', 'power', 'powered', 'signal_fire',
  'snowy', 'stage', 'triggered', 'up', 'waterlogged']);
const air = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

function fail(message) { throw new Error(message); }

export function parseState(raw, registry) {
  if (typeof raw !== 'string') fail('block state must be a string');
  const match = /^(minecraft:[a-z0-9_]+)(?:\[([^\]]+)\])?$/.exec(raw);
  if (!match) fail(`invalid state: ${raw}`);
  const block = registry.blocksByName[match[1].slice(10)];
  if (!block) fail(`unknown block for registry: ${raw}`);
  const props = {};
  for (const part of match[2]?.split(',') ?? []) {
    const property = /^([a-z0-9_]+)=([a-z0-9_]+)$/.exec(part);
    if (!property || Object.hasOwn(props, property[1])) fail(`invalid property in ${raw}`);
    props[property[1]] = property[2];
  }
  if (block.states.length !== Object.keys(props).length) fail(`incomplete properties: ${raw}`);
  for (const state of block.states) {
    const value = props[state.name];
    const allowed = state.type === 'bool' ? ['true', 'false'] : state.values;
    if (!allowed?.includes(value)) fail(`invalid or missing ${state.name} in ${raw}`);
  }
  return { name: match[1], props };
}

export function render({ name, props }) {
  const pairs = Object.entries(props).sort(([a], [b]) => a.localeCompare(b));
  return name + (pairs.length ? `[${pairs.map(([k, v]) => `${k}=${v}`).join(',')}]` : '');
}

export function transform(state, plane) {
  const maps = {
    x: { north: 'north', south: 'south', east: 'west', west: 'east' },
    z: { north: 'south', south: 'north', east: 'east', west: 'west' },
    diagonal: { north: 'west', south: 'east', east: 'south', west: 'north' },
    antidiagonal: { north: 'east', south: 'west', east: 'north', west: 'south' },
  };
  const map = maps[plane.kind];
  const result = { name: state.name, props: {} };
  for (const [key, value] of Object.entries(state.props)) {
    let target = key, next = value;
    if (directions.includes(key)) target = map[key];
    else if (key === 'facing') {
      if (directions.includes(value)) next = map[value];
      else if (!['up', 'down'].includes(value)) fail(`unsupported facing in ${render(state)}`);
    } else if (key === 'axis') {
      if (!['x', 'y', 'z'].includes(value)) fail(`unsupported axis in ${render(state)}`);
      if (['diagonal', 'antidiagonal'].includes(plane.kind) && value !== 'y') next = value === 'x' ? 'z' : 'x';
    } else if (key === 'rotation') {
      if (!/^(?:[0-9]|1[0-5])$/.test(value)) fail(`unsupported rotation in ${render(state)}`);
      const offset = { x: 0, z: 8, diagonal: 12, antidiagonal: 4 }[plane.kind];
      next = String((offset - Number(value) + 16) % 16);
    } else if (key === 'hinge') {
      if (!state.name.endsWith('_door') || !['left', 'right'].includes(value)) fail(`unsupported hinge in ${render(state)}`);
      next = value === 'left' ? 'right' : 'left';
    } else if (key === 'shape') {
      if (state.name.endsWith('_stairs') && ['straight', 'inner_left', 'inner_right', 'outer_left', 'outer_right'].includes(value)) {
        next = value.endsWith('_left') ? value.replace('_left', '_right') : value.endsWith('_right') ? value.replace('_right', '_left') : value;
      } else if (state.name.endsWith('rail')) {
        if (value.startsWith('ascending_') && directions.includes(value.slice(10))) next = `ascending_${map[value.slice(10)]}`;
        else {
          const parts = value.split('_');
          if (parts.length !== 2 || !parts.every(part => directions.includes(part))) fail(`unsupported rail shape in ${render(state)}`);
          const reflected = new Set(parts.map(part => map[part]));
          const choices = ['north_south', 'east_west', 'south_east', 'south_west', 'north_west', 'north_east'];
          next = choices.find(choice => choice.split('_').every(part => reflected.has(part)));
          if (!next) fail(`unsupported rail shape in ${render(state)}`);
        }
      } else fail(`unsupported shape in ${render(state)}`);
    } else if (key === 'type') {
      if (value === 'left' || value === 'right') {
        if (!state.name.endsWith('chest')) fail(`unsupported type in ${render(state)}`);
        next = value === 'left' ? 'right' : 'left';
      } else if (!['single', 'bottom', 'top', 'double'].includes(value)) fail(`unsupported type in ${render(state)}`);
    } else if (!unchanged.has(key)) fail(`unsupported property ${key} in ${render(state)}`);
    result.props[target] = next;
  }
  return result;
}

export function parsePlane(text) {
  let m = /^(x|z)=(-?\d+(?:\.5)?)$/.exec(text);
  if (m) return { kind: m[1], value: Number(m[2]), label: text };
  m = /^x=z(?:([+-])(\d+))?$/.exec(text);
  if (m) return { kind: 'diagonal', value: m[2] ? Number(m[2]) * (m[1] === '-' ? -1 : 1) : 0, label: text };
  m = /^x=-z(?:([+-])(\d+))?$/.exec(text);
  if (m) return { kind: 'antidiagonal', value: m[2] ? Number(m[2]) * (m[1] === '-' ? -1 : 1) : 0, label: text };
  fail(`invalid plane ${text}; use x=2.5, z=4, x=z+2, or x=-z+4`);
}

function reflected([x, y, z], plane) {
  if (plane.kind === 'x') return [2 * plane.value - x, y, z];
  if (plane.kind === 'z') return [x, y, 2 * plane.value - z];
  if (plane.kind === 'antidiagonal') return [plane.value - z, y, plane.value - x];
  return [z + plane.value, y, x - plane.value];
}

function classify(a, b) {
  if (air.has(a.name) !== air.has(b.name)) return 'occupancy';
  if (a.name !== b.name) return 'material';
  return 'state';
}

export function diagnose(data, planeText, boundsText) {
  const plane = parsePlane(planeText);
  const sizes = [data.width_x, data.height_y, data.length_z];
  if (!sizes.every(n => Number.isSafeInteger(n) && n > 0)) fail('invalid dimensions');
  const registry = minecraftData(data.minecraft_version);
  if (!registry || registry.version.minecraftVersion !== data.minecraft_version || registry.version.dataVersion !== data.data_version) fail(`unsupported or inconsistent registry version ${data.minecraft_version}/${data.data_version}`);
  if (!data.legend || !Array.isArray(data.layers) || data.layers.length !== sizes[1]) fail('invalid legend or layers');
  const palette = {};
  for (const [symbol, raw] of Object.entries(data.legend)) {
    if ([...symbol].length !== 1) fail('legend symbols must be single characters');
    const state = parseState(raw, registry);
    // Reject unsupported transforms even if the affected state happens to match itself.
    palette[symbol] = { state, mirror: transform(state, plane) };
  }
  for (const layer of data.layers) {
    if (!Array.isArray(layer) || layer.length !== sizes[2]) fail('invalid layer length');
    for (const row of layer) {
      if (typeof row !== 'string' || [...row].length !== sizes[0] || [...row].some(c => !palette[c])) fail('invalid row or unknown legend symbol');
    }
  }
  if (boundsText && !/^\d+,\d+,\d+,\d+,\d+,\d+$/.test(boundsText)) fail('invalid bounds');
  const b = boundsText ? boundsText.split(',').map(Number) : [0, sizes[0]-1, 0, sizes[1]-1, 0, sizes[2]-1];
  if (b.length !== 6 || !b.every(Number.isSafeInteger) || b.some((n, i) => n < 0 || n >= sizes[Math.floor(i/2)]) || b[0] > b[1] || b[2] > b[3] || b[4] > b[5]) fail('bounds must be inclusive xmin,xmax,ymin,ymax,zmin,zmax inside blueprint');
  const contains = ([x,y,z]) => x >= b[0] && x <= b[1] && y >= b[2] && y <= b[3] && z >= b[4] && z <= b[5];
  const cell = ([x,y,z]) => palette[[...data.layers[y][z]][x]];
  const order = ([x,y,z]) => (y * sizes[2] + z) * sizes[0] + x;
  const report = { plane: plane.label, bounds: b, pairs: { compared: 0, matched: 0, mismatched: 0, air_only: 0 },
    center: { cells: 0, occupied: 0, mismatched: 0 }, out_of_bounds: { cells: 0, occupied: [] },
    mismatch_classes: { occupancy: 0, material: 0, state: 0 }, mismatches: [] };
  for (let y=b[2]; y<=b[3]; y++) for (let z=b[4]; z<=b[5]; z++) for (let x=b[0]; x<=b[1]; x++) {
    const from = [x,y,z], to = reflected(from, plane), a = cell(from);
    if (!contains(to)) {
      report.out_of_bounds.cells++;
      if (!air.has(a.state.name)) report.out_of_bounds.occupied.push({ from, to, state: render(a.state), outside: to.some((v,i) => v < 0 || v >= sizes[i]) ? 'blueprint' : 'region' });
      continue;
    }
    if (order(from) > order(to)) continue;
    const same = order(from) === order(to), target = cell(to).state;
    const mismatch = render(a.mirror) !== render(target);
    if (same) { report.center.cells++; if (!air.has(a.state.name)) report.center.occupied++; if (mismatch) report.center.mismatched++; }
    else if (air.has(a.state.name) && air.has(target.name) && !mismatch) report.pairs.air_only++;
    else { report.pairs.compared++; if (mismatch) report.pairs.mismatched++; else report.pairs.matched++; }
    if (mismatch) {
      const category = classify(a.state, target);
      report.mismatch_classes[category]++;
      report.mismatches.push({ class: category, from, to, source: render(a.state), expected: render(a.mirror), actual: render(target), center: same });
    }
  }
  report.pairs.coverage = report.pairs.compared ? report.pairs.matched / report.pairs.compared : null;
  report.exact = !report.mismatches.length && !report.out_of_bounds.cells;
  return report;
}

function main(argv) {
  const paths = [], planes = [];
  let bounds, check = false;
  for (let i=0; i<argv.length; i++) {
    const arg = argv[i];
    if (arg === '--plane') { if (!argv[i+1]) fail('--plane requires a value'); planes.push(argv[++i]); }
    else if (arg === '--bounds') { if (!argv[i+1] || bounds) fail('--bounds requires one value'); bounds = argv[++i]; }
    else if (arg === '--check') check = true;
    else if (arg.startsWith('-')) fail(`unknown option ${arg}`);
    else paths.push(arg);
  }
  if (!paths.length || !planes.length) fail('usage: node schematics/tooling/symmetry.mjs --plane x=2.5 [--plane z=4] [--bounds xmin,xmax,ymin,ymax,zmin,zmax] [--check] blueprint.json [...]');
  const reports = paths.map(path => ({ path, results: planes.map(plane => diagnose(JSON.parse(fs.readFileSync(path, 'utf8')), plane, bounds)) }));
  console.log(JSON.stringify({ reports }, null, 2));
  return check && reports.some(item => item.results.some(result => !result.exact)) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(`symmetry: ${error.message}`); process.exitCode = 2; }
}
