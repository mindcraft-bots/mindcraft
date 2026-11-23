#!/usr/bin/env node
/** Convert only through reviewed history edges, checked against generated profiles. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadRelease, validateBlueprint, validateState } from './history_registry.mjs';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const check = (ok, message) => { if (!ok) throw new Error(message); };
const own = (o, k) => Object.hasOwn(o, k);
const identifier = /^minecraft:[a-z0-9_./-]+$/;
const property = /^[a-z0-9_]+$/;
export const release = loadRelease;
function boundary(value) {
  check(object(value) && Object.keys(value).sort().join(',') === 'dataVersion,release', 'invalid history release boundary');
  const profile = release(value.release);
  check(value.dataVersion === profile.dataVersion, `history release ${value.release} DataVersion mismatch`);
  return value.dataVersion;
}
const applies = (edge, dv) => dv >= edge.target.min.dataVersion && (!edge.target.max || dv <= edge.target.max.dataVersion);
const inRange = (range, dv) => dv >= range.min.dataVersion && dv <= range.max.dataVersion;
function validateProperties(p) {
  check(object(p) && Object.keys(p).sort().join(',') === 'rename,values' && object(p.rename) && object(p.values), 'invalid history property rules');
  for (const [key, value] of Object.entries(p.rename)) check(property.test(key) && typeof value === 'string' && property.test(value), 'invalid property rename');
  for (const [key, values] of Object.entries(p.values)) {
    check(property.test(key) && object(values) && Object.keys(values).length > 0, 'invalid property values rule');
    for (const [from, to] of Object.entries(values)) check(property.test(from) && typeof to === 'string' && property.test(to), 'invalid property value mapping');
  }
}
export function validateHistory(history) {
  check(object(history) && Object.keys(history).every((k) => ['alternatives', 'blocks', 'schemaVersion', 'stateTransforms'].includes(k)) && history.schemaVersion === 1 && object(history.blocks) && Array.isArray(history.alternatives) && (!own(history, 'stateTransforms') || Array.isArray(history.stateTransforms)), 'invalid history schema');
  for (const [name, entry] of Object.entries(history.blocks)) {
    check(identifier.test(name) && object(entry) && Object.keys(entry).join(',') === 'introduced', `invalid history block ${name}`);
    boundary(entry.introduced);
    check(own(release(entry.introduced.release).blocks, name), `history introduction ${name} absent from ${entry.introduced.release}`);
  }
  const bounds = new Set([1]);
  for (const edge of history.alternatives) {
    check(object(edge) && ['from', 'to', 'target', 'properties'].every((k) => own(edge, k)) && Object.keys(edge).every((k) => ['from', 'to', 'target', 'properties', 'source', 'evidence'].includes(k)) && own(history.blocks, edge.from) && own(history.blocks, edge.to) && edge.from !== edge.to, 'invalid history alternative');
    if (own(edge, 'source')) {
      check(object(edge.source) && Object.keys(edge.source).sort().join(',') === 'max,min', 'history source requires bounded range');
      const min = boundary(edge.source.min), max = boundary(edge.source.max);
      check(min <= max && min >= history.blocks[edge.from].introduced.dataVersion, 'invalid history source bounds');
      for (const bound of [edge.source.min, edge.source.max]) check(own(release(bound.release).blocks, edge.from), `history source ${edge.from} absent from ${bound.release}`);
    }
    if (own(edge, 'evidence')) {
      check(object(edge.evidence) && Object.keys(edge.evidence).sort().join(',') === 'claim,registry,source,sourceAttribution' && Object.values(edge.evidence).every((v) => typeof v === 'string' && v.trim()), 'invalid history evidence');
    }
    check(object(edge.target) && own(edge.target, 'min') && Object.keys(edge.target).every((k) => k === 'min' || k === 'max'), 'invalid history target range');
    const min = boundary(edge.target.min), max = edge.target.max ? boundary(edge.target.max) : Infinity;
    check(min <= max && min >= history.blocks[edge.to].introduced.dataVersion, 'invalid history target bounds');
    for (const bound of [edge.target.min, edge.target.max].filter(Boolean)) check(own(release(bound.release).blocks, edge.to), `history alternative ${edge.to} absent from ${bound.release}`);
    bounds.add(min); if (Number.isFinite(max)) bounds.add(max + 1);
    validateProperties(edge.properties);
  }
  const rules = history.stateTransforms ?? [];
  for (const rule of rules) {
    check(object(rule) && Object.keys(rule).sort().join(',') === 'block,properties,source,target' && identifier.test(rule.block), 'invalid history state transformation');
    for (const range of [rule.source, rule.target]) {
      check(object(range) && Object.keys(range).sort().join(',') === 'max,min', 'state transformation requires bounded source and target ranges');
      const min = boundary(range.min), max = boundary(range.max);
      check(min <= max, 'invalid state transformation bounds');
      for (const bound of [range.min, range.max]) check(own(release(bound.release).blocks, rule.block), `state transformation ${rule.block} absent from ${bound.release}`);
    }
    validateProperties(rule.properties);
  }
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    const a = rules[i], b = rules[j];
    const overlaps = (x, y) => x.min.dataVersion <= y.max.dataVersion && y.min.dataVersion <= x.max.dataVersion;
    check(a.block !== b.block || !overlaps(a.source, b.source) || !overlaps(a.target, b.target), `ambiguous state transformations for ${a.block}`);
  }
  for (const dv of bounds) {
    const visiting = new Set(), done = new Set();
    const visit = (name) => {
      check(!visiting.has(name), `history cycle for target DataVersion ${dv}: ${name}`);
      if (done.has(name)) return;
      visiting.add(name);
      for (const edge of history.alternatives.filter((e) => e.from === name && applies(e, dv))) visit(edge.to);
      visiting.delete(name); done.add(name);
    };
    for (const name of Object.keys(history.blocks)) visit(name);
  }
  return history;
}
function transform(state, edge) {
  const match = /^([^\[]+)(?:\[(.*)\])?$/.exec(state), props = new Map();
  for (const entry of match[2] ? match[2].split(',') : []) {
    let [key, value] = entry.split('=');
    if (own(edge.properties.values, key)) {
      check(own(edge.properties.values[key], value), `missing explicit value mapping for ${key}=${value}`);
      value = edge.properties.values[key][value];
    }
    key = edge.properties.rename[key] ?? key;
    check(!props.has(key), `property transformation collision: ${key}`);
    props.set(key, value);
  }
  return edge.to + (props.size ? `[${[...props].map(([k, v]) => `${k}=${v}`).join(',')}]` : '');
}
export function convertBlueprint(blueprint, targetVersion, history, options = {}) {
  validateHistory(history);
  const source = release(blueprint.minecraft_version), target = release(targetVersion), allow = options.allowUnverified === true;
  validateBlueprint(blueprint, source, allow);
  check(allow || target.config.coverage !== 'partial', `partial schema profile for ${targetVersion}; use --allow-unverified for explicitly nonvalidated output`);
  const legend = {}, changes = [];
  for (const [character, state] of Object.entries(blueprint.legend)) {
    const original = validateState(state, source, allow).name;
    if (own(history.blocks, original)) check(source.dataVersion >= history.blocks[original].introduced.dataVersion, `source predates introduction of ${original}`);
    const queue = [{ state, path: [], evidence: [] }], results = [];
    while (queue.length) {
      const candidate = queue.shift(), name = candidate.state.split('[')[0];
      if (own(target.blocks, name)) {
        if (own(history.blocks, name)) check(target.dataVersion >= history.blocks[name].introduced.dataVersion, `target predates introduction of ${name}`);
        const rules = (history.stateTransforms ?? []).filter((rule) => original === name && rule.block === name &&
          source.dataVersion >= rule.source.min.dataVersion && source.dataVersion <= rule.source.max.dataVersion && applies(rule, target.dataVersion));
        check(rules.length <= 1, `ambiguous state transformations for ${name}`);
        const transformed = rules.length ? transform(candidate.state, { to: name, properties: rules[0].properties }) : candidate.state;
        validateState(transformed, target, allow);
        results.push({ state: transformed, path: rules.length ? [...candidate.path, name] : candidate.path, evidence: candidate.evidence });
        continue;
      }
      for (const edge of history.alternatives.filter((e) => e.from === name && applies(e, target.dataVersion) && (!e.source || inRange(e.source, source.dataVersion)))) queue.push({ state: transform(candidate.state, edge), path: [...candidate.path, edge.to], evidence: edge.evidence ? [...candidate.evidence, edge.evidence] : candidate.evidence });
    }
    check(results.length, `no authored fallback for ${state} in Minecraft ${targetVersion}`);
    check(results.length === 1, `ambiguous authored fallbacks for ${state} in Minecraft ${targetVersion}`);
    const result = results[0];
    legend[character] = result.state;
    if (result.path.length) changes.push({ from: state, to: result.state, via: result.path, ...(result.evidence.length ? { evidence: result.evidence } : {}) });
  }
  validateBlueprint({ ...blueprint, legend, minecraft_version: targetVersion, data_version: target.dataVersion }, target, allow);
  return { legend, sourceVersion: source.version, sourceDataVersion: source.dataVersion, targetVersion, targetDataVersion: target.dataVersion, validation: allow ? 'NONVALIDATED' : 'validated', changes };
}
function main() {
  const [blueprintPath, version, flag] = process.argv.slice(2);
  check(blueprintPath && version && (process.argv.length === 4 || (process.argv.length === 5 && flag === '--allow-unverified')), 'usage: convert_history.mjs <blueprint.json> <target-version> [--allow-unverified]');
  const blueprint = JSON.parse(readFileSync(blueprintPath === '-' ? 0 : blueprintPath, 'utf8'));
  if (version === '--validate-source') {
    const profile = release(blueprint.minecraft_version);
    validateBlueprint(blueprint, profile, flag === '--allow-unverified');
    console.log(JSON.stringify({ validation: flag ? 'NONVALIDATED' : 'validated', dataVersion: profile.dataVersion }));
  } else {
    const history = JSON.parse(readFileSync(new URL('./block_history.v1.json', import.meta.url), 'utf8'));
    console.log(JSON.stringify(convertBlueprint(blueprint, version, history, { allowUnverified: flag === '--allow-unverified' })));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`HISTORY VALIDATION FAILED: ${error.message}`); process.exitCode = 1; }
}
