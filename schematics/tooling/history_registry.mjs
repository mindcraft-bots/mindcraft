/** Authenticated generated Java release profiles; no minecraft-data fallback. */
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INDEX_SHA256 = '872c65a8d38c3525aab3e1e42d14e49e2014a81086f29606b6f0c0bcaedab888';
export const DATA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), 'block_history/generated');
const check = (ok, message) => { if (!ok) throw new Error(message); };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.hasOwn(o, k);

export function loadRelease(version, root = DATA_ROOT, indexHash = INDEX_SHA256) {
  check(typeof version === 'string' && /^\d+(?:\.\d+)+$/.test(version), `invalid Java release ${version}`);
  const base = realpathSync(root);
  const read = (path, digest) => {
    check(typeof path === 'string' && !path.startsWith('/') && !path.split('/').includes('..'), `unsafe history path ${path}`);
    const filename = realpathSync(resolve(base, path));
    check(filename.startsWith(base + sep), `history path escapes generated tree: ${path}`);
    const bytes = readFileSync(filename);
    check(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) && hash(bytes) === digest, `history SHA-256 mismatch: ${path}`);
    return bytes;
  };
  const index = JSON.parse(read('index.json', indexHash));
  check(index.schema === 1 && index.edition === 'java' && Array.isArray(index.releases), 'unsupported history index schema or edition');
  const entries = index.releases.filter((entry) => entry.release === version);
  check(entries.length === 1, `unsupported or missing exact Java release ${version} (pre-1.13, Bedrock and snapshots unsupported)`);
  const entry = entries[0];
  check(['exact', 'shared', 'partial'].includes(entry.coverage), `unsupported or unavailable coverage for ${version}: ${entry.coverage}`);
  check(Number.isSafeInteger(entry.data_version) && entry.data_version > 0, `invalid DataVersion for ${version}`);
  const config = JSON.parse(read(entry.config, entry.sha256));
  check(config.schema === 1 && config.edition === 'java' && config.release === version && config.data_version === entry.data_version && config.coverage === entry.coverage, `release profile identity mismatch for ${version}`);
  check(config.generator === index.generator && config.generator_sha256 === index.generator_sha256 && config.source_lock_sha256 === index.source_lock_sha256, `release profile provenance mismatch for ${version}`);
  check(config.identifier_coverage === 'complete-as-reported' && ['partial', 'complete-as-reported'].includes(config.schema_coverage) && ['complete', 'unknown'].includes(config.legal_combinations_coverage), `unsupported profile coverage for ${version}`);
  const payload = (ref) => {
    check(object(ref), `missing profile payload for ${version}`);
    const data = JSON.parse(gunzipSync(read(ref.path, ref.sha256)));
    check(data.schema === 1 && data.edition === 'java' && data.release === version, `history payload identity mismatch for ${version}`);
    return data;
  };
  const registry = payload(config.registry), delta = payload(config.delta);
  check(object(registry.blocks) && Object.keys(registry.blocks).length === config.block_count, `registry count mismatch for ${version}`);
  const known = Object.values(registry.blocks).filter((schema) => schema !== null).length;
  check(known === config.known_schema_count && config.block_count - known === config.unknown_schema_count &&
    (config.schema_coverage === 'partial') === (known !== config.block_count), `schema coverage mismatch for ${version}`);
  const pos = index.releases.indexOf(entry), previous = pos ? index.releases[pos - 1] : null;
  let afterGap = false;
  if (previous) {
    check(object(previous) && typeof previous.release === 'string' && /^\d+(?:\.\d+)+$/.test(previous.release) &&
      index.releases.filter((item) => item.release === previous.release).length === 1, `invalid preceding release for ${version}`);
    const prior = JSON.parse(read(previous.config, previous.sha256));
    check(prior.schema === 1 && prior.edition === 'java' && prior.release === previous.release &&
      prior.coverage === previous.coverage && prior.generator === index.generator &&
      prior.generator_sha256 === index.generator_sha256, `preceding profile identity or provenance mismatch for ${previous.release}`);
    if (previous.coverage === 'unavailable') {
      check(prior.data_version === null && !own(previous, 'data_version') &&
        typeof prior.reason === 'string' && prior.reason.trim().length > 0 &&
        !own(prior, 'registry') && !own(prior, 'delta') && !own(prior, 'source_lock_sha256'),
      `unavailable profile metadata mismatch for ${previous.release}`);
      afterGap = true;
    } else {
      check(['exact', 'shared', 'partial'].includes(previous.coverage) &&
        Number.isSafeInteger(previous.data_version) && previous.data_version > 0 &&
        prior.data_version === previous.data_version && prior.source_lock_sha256 === index.source_lock_sha256,
      `invalid preceding coverage or metadata for ${version}`);
    }
  }
  if (pos === 0 || afterGap) {
    const baseline = delta.baseline;
    check(delta.kind === (afterGap ? 'after_gap' : 'baseline') && delta.from === null &&
      Array.isArray(baseline) && baseline.length === config.block_count &&
      new Set(baseline).size === baseline.length && baseline.every((name) => own(registry.blocks, name)) &&
      Array.isArray(delta.added) && delta.added.length === 0 && Array.isArray(delta.removed) && delta.removed.length === 0 &&
      object(delta.changed) && Object.keys(delta.changed).length === 0 &&
      Array.isArray(delta.schema_indeterminate) && delta.schema_indeterminate.length === 0 &&
      config.same_registry_as_previous === false, `delta identity or baseline mismatch for ${version}`);
  } else {
    check(delta.kind === 'adjacent' && delta.from === previous.release && Array.isArray(delta.baseline) &&
      delta.baseline.length === 0, `delta identity mismatch for ${version}`);
  }
  return { version, dataVersion: entry.data_version, config, blocks: registry.blocks, delta };
}

export function validateState(raw, release, allowUnverified = false) {
  const m = typeof raw === 'string' && /^(minecraft:[a-z0-9_./-]+)(?:\[([^\]]+)\])?$/.exec(raw);
  check(m, `malformed vanilla block state ${JSON.stringify(raw)}`);
  const [, name, text] = m, props = Object.create(null);
  if (text) for (const part of text.split(',')) {
    const pair = /^([a-z0-9_]+)=([a-z0-9_]+)$/.exec(part);
    check(pair && !own(props, pair[1]), `malformed or duplicate property in ${raw}`);
    props[pair[1]] = pair[2];
  }
  check(own(release.blocks, name), `${raw} is not a vanilla Minecraft ${release.version} block`);
  const schema = release.blocks[name];
  check(object(schema), `unknown schema for ${name} in ${release.version}`);
  check(object(schema.properties) && object(schema.defaults), `invalid schema for ${name}`);
  const keys = Object.keys(schema.properties).sort();
  check(JSON.stringify(Object.keys(props).sort()) === JSON.stringify(keys), `${raw} must specify the complete canonical property set (${keys.join(',') || 'none'})`);
  for (const key of keys) {
    const values = schema.properties[key];
    check(Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string') && values.includes(schema.defaults[key]), `invalid schema domain for ${name}.${key}`);
    check(values.includes(props[key]), `${raw} has illegal ${key}=${props[key]} for Minecraft ${release.version}`);
  }
  check(JSON.stringify(Object.keys(schema.defaults).sort()) === JSON.stringify(keys), `invalid defaults for ${name}`);
  const combinations = schema.combinations;
  if (combinations === 'unknown') {
    check(allowUnverified, `unknown legal combinations for ${name} in ${release.version}; use --allow-unverified for explicitly nonvalidated output`);
  } else if (combinations !== 'cartesian') {
    check(Array.isArray(combinations) && combinations.every((c) => Array.isArray(c) && c.length === keys.length), `invalid combinations for ${name}`);
    check(combinations.some((c) => c.every((v, i) => v === props[keys[i]])), `illegal property combination for ${raw}`);
  }
  return { name, props, unverified: combinations === 'unknown' };
}

export function validateBlueprint(blueprint, release, allowUnverified = false) {
  check(blueprint.minecraft_version === release.version, `target Minecraft version ${release.version} does not match blueprint minecraft_version ${JSON.stringify(blueprint.minecraft_version)}`);
  check(Number.isSafeInteger(blueprint.data_version) && blueprint.data_version === release.dataVersion, `blueprint data_version ${blueprint.data_version} does not match ${release.version} DataVersion ${release.dataVersion}`);
  check(allowUnverified || release.config.coverage !== 'partial', `partial schema profile for ${release.version}; use --allow-unverified for explicitly nonvalidated output`);
  check(object(blueprint.legend) && Object.keys(blueprint.legend).length, 'blueprint legend must be an object');
  for (const [key, state] of Object.entries(blueprint.legend)) {
    check([...key].length === 1, 'invalid legend key');
    validateState(state, release, allowUnverified);
  }
}
