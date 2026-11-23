import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DATA_ROOT, loadRelease, validateState, validateBlueprint } from '../../schematics/tooling/history_registry.mjs';
import { convertBlueprint, validateHistory } from '../../schematics/tooling/convert_history.mjs';

const root = resolve('.');
const history = JSON.parse(readFileSync('schematics/tooling/block_history.v1.json'));
const opt = { allowUnverified: true };
const clone = structuredClone;
const fixture = (state, version, dv) => ({ minecraft_version: version, data_version: dv, width_x: 2, height_y: 1, length_z: 1,
  legend: { A: state, B: 'minecraft:air' }, layers: [['AB']], expected_counts: { [state]: 1, 'minecraft:air': 1 }, non_air_count: 1,
  spot_checks: [{ x: 0, y: 0, z: 0, char: 'A' }] });
const stateFor = (name, schema) => name + (Object.keys(schema.properties).length ? `[${Object.entries(schema.defaults).map(([k, v]) => `${k}=${v}`).join(',')}]` : '');
const python = process.env.HISTORY_TEST_PYTHON || 'python3';
const runPython = (code, ...args) => spawnSync(python, ['-c', code, ...args], { cwd: root, encoding: 'utf8' });
const compileCode = `import sys,json\nsys.path.insert(0,'schematics/tooling')\nfrom compile_blueprint import compile_blueprint\nb,p,r=compile_blueprint(__import__('pathlib').Path(sys.argv[1]),__import__('pathlib').Path(sys.argv[2]),convert_to=(sys.argv[3] or None),allow_unverified=sys.argv[4]=='yes',return_report=True)\nprint(json.dumps(r))`;

test('exact profiles select release identity and counts, never dependency major fallback', () => {
  for (const [version, dv, count] of [['1.13',1519,593],['1.21.2',4080,1084],['1.21.7',4438,1105],['1.21.4',4189,1095],['26.1',4786,1168],['26.3',5023,1286]]) {
    const r = loadRelease(version); assert.equal(r.dataVersion, dv); assert.equal(Object.keys(r.blocks).length, count);
    assert.equal(r.version, version); assert.equal(r.delta.release, version);
    assert.equal(r.config.legal_combinations_coverage, 'complete');
    assert.match(r.config.feature_flags, /unknown/);
    validateState('minecraft:stone', r);
    assert.throws(() => validateBlueprint(fixture('minecraft:stone', version, dv + 1), r), /data_version.*does not match/);
  }
  assert.throws(() => loadRelease('1.12.2'), /unsupported or missing exact/);
  assert.throws(() => loadRelease('26.3.1'), /unsupported or missing exact/);
  const md = createRequire(import.meta.url)('minecraft-data');
  for (const version of ['1.21.2', '1.21.7']) {
    const r = loadRelease(version), stale = md(version);
    if (stale && Object.keys(stale.blocksByName).length < Object.keys(r.blocks).length) {
      const id = Object.keys(r.blocks).find((key) => !Object.hasOwn(stale.blocksByName, key.slice(10)));
      assert.ok(id); validateState(stateFor(id, r.blocks[id]), r);
    }
  }
  const r = loadRelease('26.3'); validateState('minecraft:stone', r, true);
});

test('pin authenticates index, profile, registry and delta and fails for missing files', () => {
  for (const path of ['index.json','releases/1.13.json','registries/1.13.json.gz','deltas/1.13.json.gz']) {
    const dir = mkdtempSync(join(tmpdir(), 'history-tamper-'));
    try {
      cpSync(DATA_ROOT, dir, { recursive: true });
      const file = join(dir, path); const bytes = readFileSync(file); bytes[bytes.length - 1] ^= 1; writeFileSync(file, bytes);
      assert.throws(() => loadRelease('1.13', dir), /SHA-256 mismatch/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const dir = mkdtempSync(join(tmpdir(), 'history-missing-'));
  try { cpSync(DATA_ROOT, dir, { recursive: true }); unlinkSync(join(dir, 'deltas/1.13.json.gz')); assert.throws(() => loadRelease('1.13', dir)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('schema, coverage and combination uncertainty are never silently verified', () => {
  const full = loadRelease('1.13'), modern = loadRelease('1.21.4'), partial = clone(loadRelease('1.15.2'));
  partial.config.coverage = 'partial'; partial.blocks['minecraft:acacia_planks'] = null;
  validateState('minecraft:stone', full);
  validateState('minecraft:stone', modern);
  validateState('minecraft:stone', modern, true);
  const unknown = clone(modern); unknown.blocks['minecraft:stone'].combinations = 'unknown';
  assert.throws(() => validateState('minecraft:stone', unknown), /unknown legal combinations/);
  validateState('minecraft:stone', unknown, true);
  assert.throws(() => validateBlueprint(fixture('minecraft:stone','1.15.2',2230), partial), /partial schema/);
  assert.throws(() => validateState('minecraft:acacia_planks', partial, true), /unknown schema/);
  assert.throws(() => validateState('minecraft:no_such_block', modern, true), /not a vanilla/);
  assert.throws(() => validateState('minecraft:chain[axis=bad,waterlogged=true]', modern, true), /illegal/);
  assert.throws(() => validateState('minecraft:chain[axis=x]', modern, true), /complete canonical/);
  assert.throws(() => validateState('minecraft:chain[axis=x,axis=y,waterlogged=true]', modern, true), /duplicate/);
  const synthetic = { version: 'test', blocks: { 'minecraft:test': { properties: { a: ['x','y'], b: ['x','y'] }, defaults: { a:'x', b:'x' }, combinations: [['x','x'],['y','y']] } } };
  validateState('minecraft:test[a=x,b=x]', synthetic);
  assert.throws(() => validateState('minecraft:test[a=x,b=y]', synthetic, true), /illegal property combination/);
});

test('independent reports validate exact states for 1.20.2 and neighboring releases', () => {
  const target = loadRelease('1.20.2');
  assert.equal(target.dataVersion, 3578); assert.equal(target.config.coverage, 'exact');
  assert.equal(target.config.legal_combinations_coverage, 'complete');
  for (const state of ['minecraft:air', 'minecraft:stone', 'minecraft:oak_sapling[stage=1]']) validateState(state, target);
  assert.throws(() => validateState('minecraft:stone[axis=x]', target), /complete canonical/);
  assert.throws(() => validateState('minecraft:oak_sapling[stage=2]', target), /illegal/);
  for (const version of ['1.20.1', '1.20.3']) validateState('minecraft:stone', loadRelease(version));
  const source = fixture('minecraft:oak_sapling[stage=1]', '1.13', 1519);
  const unchanged = convertBlueprint(source, '1.20.2', history);
  assert.equal(unchanged.validation, 'validated'); assert.equal(unchanged.legend.A, source.legend.A); assert.deepEqual(unchanged.changes, []);
  assert.throws(() => convertBlueprint({ ...source, data_version: 3578 }, '1.20.2', history), /data_version.*does not match/);
});

test('historical release targets validate state domains without guessing across transitions', () => {
  for (const [version, dv] of [['1.14',1952],['1.15.2',2230],['1.16.5',2586],['1.17',2724],['1.18.2',2975],['1.19.4',3337],['1.20.4',3700]]) {
    const release = loadRelease(version);
    assert.equal(release.dataVersion, dv); assert.equal(release.config.legal_combinations_coverage, 'complete');
    validateState('minecraft:stone', release);
    assert.throws(() => validateState('minecraft:stone[axis=x]', release), /complete canonical/);
    assert.throws(() => validateBlueprint(fixture('minecraft:stone',version,dv + 1), release), /data_version.*does not match/);
  }
  validateState('minecraft:cobblestone_wall[east=true,north=false,south=false,up=true,waterlogged=false,west=false]', loadRelease('1.15.2'));
  assert.throws(() => validateState('minecraft:cobblestone_wall[east=true,north=false,south=false,up=true,waterlogged=false,west=false]', loadRelease('1.16')), /illegal/);
});

test('reviewed graph validates source and target, cycles, and refuses wall ambiguity', () => {
  const chain = 'minecraft:chain[axis=x,waterlogged=true]', iron = 'minecraft:iron_chain[axis=x,waterlogged=true]';
  const b = fixture(chain, '1.21.4', 4189);
  assert.equal(convertBlueprint(b, '26.1', history).validation, 'validated');
  const result = convertBlueprint(b, '26.1', history, opt);
  assert.equal(result.legend.A, iron); assert.equal(result.targetDataVersion, 4786); assert.equal(result.validation, 'NONVALIDATED');
  assert.equal(convertBlueprint(fixture(iron,'26.1',4786), '1.21.4', history, opt).legend.A, chain);
  assert.throws(() => convertBlueprint({ ...b, data_version: 3700 }, '26.1', history, opt), /data_version.*does not match/);
  assert.throws(() => convertBlueprint(fixture(iron,'1.21.4',4189), '26.1', history, opt), /not a vanilla/);
  assert.throws(() => convertBlueprint(fixture('minecraft:pale_oak_planks','1.21.4',4189), '1.13', history, opt), /no authored fallback/);
  const broken = clone(history); broken.alternatives[0].properties.values.axis = { y: 'y' };
  assert.throws(() => convertBlueprint(b, '26.1', broken, opt), /missing explicit value mapping/);
  const intro = { release: '1.16', dataVersion: 2566 }, min = { release: '26.1', dataVersion: 4786 };
  const edge = (from, to) => ({ from, to, target: { min }, properties: { rename: {}, values: {} } });
  const cyc = { schemaVersion: 1, blocks: { 'minecraft:stone': { introduced: intro }, 'minecraft:dirt': { introduced: intro } },
    alternatives: [edge('minecraft:stone','minecraft:dirt'), edge('minecraft:dirt','minecraft:stone')] };
  assert.throws(() => validateHistory(cyc), /history cycle/);
  const wall = 'minecraft:cobblestone_wall[east=true,north=false,south=false,up=true,waterlogged=false,west=false]';
  assert.throws(() => convertBlueprint(fixture(wall,'1.15.2',2230), '1.16', history, opt), /illegal|unknown schema/);
});

test('bounded same-name state rules are explicit, unambiguous and revalidated', () => {
  // Synthetic rule exercises the mechanism only; it is not an authored conversion.
  const rule = { block: 'minecraft:oak_sapling',
    source: { min: { release: '1.13', dataVersion: 1519 }, max: { release: '1.13', dataVersion: 1519 } },
    target: { min: { release: '1.13.1', dataVersion: 1628 }, max: { release: '1.13.1', dataVersion: 1628 } },
    properties: { rename: {}, values: { stage: { '0': '1' } } } };
  const h = { ...clone(history), stateTransforms: [rule] };
  const b = fixture('minecraft:oak_sapling[stage=0]', '1.13', 1519);
  const result = convertBlueprint(b, '1.13.1', h);
  assert.equal(result.legend.A, 'minecraft:oak_sapling[stage=1]');
  assert.equal(result.validation, 'validated');
  assert.equal(convertBlueprint(b, '1.13.2', h).legend.A, b.legend.A);
  assert.throws(() => convertBlueprint(fixture('minecraft:oak_sapling[stage=1]','1.13',1519), '1.13.1', h), /missing explicit value mapping/);
  const invalid = clone(h); invalid.stateTransforms[0].properties.values.stage['0'] = '999';
  assert.throws(() => convertBlueprint(b, '1.13.1', invalid), /illegal stage=999/);
  const ambiguous = clone(h); ambiguous.stateTransforms.push(clone(rule));
  assert.throws(() => validateHistory(ambiguous), /ambiguous state transformations/);
  const unbounded = clone(h); delete unbounded.stateTransforms[0].source.max;
  assert.throws(() => validateHistory(unbounded), /bounded source and target/);
});

test('compilation is isolated, atomic, no-clobber, and labels unverified variants', () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-compile-'));
  try {
    const source = join(dir,'fixture.json'), out = join(dir,'out.schem'), unverified = join(dir,'out.mc26.1.nonvalidated.schem');
    writeFileSync(source, JSON.stringify(fixture('minecraft:stone','1.13',1519)));
    let result = runPython(compileCode,source,out,'','no'); assert.equal(result.status,0,result.stderr); const bytes = readFileSync(out); assert.equal(JSON.parse(result.stdout).validation,'STRICT_VALIDATED');
    result = runPython(compileCode,source,out,'','no'); assert.notEqual(result.status,0); assert.deepEqual(readFileSync(out),bytes);
    writeFileSync(source, JSON.stringify(fixture('minecraft:chain[axis=x,waterlogged=true]','1.21.4',4189)));
    const strictModern = join(dir,'out.mc26.1.schem');
    result = runPython(compileCode,source,strictModern,'26.1','no'); assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).validation,'STRICT_VALIDATED');
    result = runPython(compileCode,source,unverified,'26.1','yes'); assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).validation,'NONVALIDATED');
    const inspect = runPython("import nbtlib,sys; n=nbtlib.load(sys.argv[1]); print(int(n['DataVersion']),int(n['Width']),int(n['Height']),int(n['Length']),sorted(n['Palette']))",unverified);
    assert.equal(inspect.status,0,inspect.stderr); assert.match(inspect.stdout,/4786 2 1 1/); assert.match(inspect.stdout,/iron_chain\[axis=x,waterlogged=true\]/);
    assert.notEqual(runPython(compileCode,source,join(dir,'bad.schem'),'26.1','yes').status,0);
    const newest = join(dir,'out.mc26.3.nonvalidated.schem');
    result = runPython(compileCode,source,newest,'26.3','yes'); assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).conversion.targetDataVersion, 5023);
    const forced = join(dir,'forced.nonvalidated.schem');
    const failDuringValidation = `import sys,pathlib\nsys.path.insert(0,'schematics/tooling')\nimport compile_blueprint as c\ndef fail(*args): raise ValueError('injected validation failure')\nc.validate_schematic=fail\nc.compile_blueprint(pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]),allow_unverified=True)`;
    assert.notEqual(runPython(failDuringValidation,source,forced).status,0); assert.equal(existsSync(forced),false);
    writeFileSync(source, JSON.stringify(fixture('minecraft:stone','1.12.2',1343)));
    assert.notEqual(runPython(compileCode,source,forced,'','yes').status,0); assert.equal(existsSync(forced),false);
    writeFileSync(source, JSON.stringify(fixture('minecraft:no_such_block','1.21.4',4189)));
    const fail = join(dir,'fail.nonvalidated.schem'); assert.notEqual(runPython(compileCode,source,fail,'','yes').status,0); assert.equal(existsSync(fail),false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('strictly compiles independent historical version targets with exact DataVersions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-release-targets-'));
  try {
    const source = join(dir, 'fixture.json');
    writeFileSync(source, JSON.stringify(fixture('minecraft:stone', '1.13', 1519)));
    for (const [version, dv] of [['1.14',1952],['1.15.2',2230],['1.16.5',2586],['1.17',2724],['1.18.2',2975],['1.19.4',3337],['1.20.4',3700],['1.20.5',3837],['1.21.2',4080],['1.21.4',4189],['1.21.7',4438],['26.1',4786],['26.3',5023]]) {
      const output = join(dir, `target-${version}.schem`);
      const result = runPython(compileCode, source, output, version, 'no');
      assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).validation, 'STRICT_VALIDATED');
      const inspect = runPython("import nbtlib,sys; print(int(nbtlib.load(sys.argv[1])['DataVersion']))", output);
      assert.equal(inspect.status, 0, inspect.stderr); assert.equal(Number(inspect.stdout.trim()), dv);
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('strict compilation uses exact modern reports even when installed dependency falls back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-modern-exact-'));
  try {
    const md = createRequire(import.meta.url)('minecraft-data');
    for (const [version, dv] of [['1.21.2',4080],['1.21.7',4438]]) {
      const release = loadRelease(version), local = md(version);
      const id = local && Object.keys(release.blocks).find(key => !Object.hasOwn(local.blocksByName, key.slice(10)));
      const state = id ? stateFor(id, release.blocks[id]) : 'minecraft:stone';
      const source = join(dir, `source-${version}.json`), output = join(dir, `out-${version}.schem`);
      writeFileSync(source, JSON.stringify(fixture(state, version, dv)));
      const result = runPython(compileCode, source, output, '', 'no');
      assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).validation, 'STRICT_VALIDATED');
      const inspect = runPython("import nbtlib,sys; n=nbtlib.load(sys.argv[1]); print(int(n['DataVersion']),sorted(n['Palette']))", output);
      assert.equal(inspect.status, 0, inspect.stderr); assert.match(inspect.stdout, new RegExp(`^${dv} `)); assert.ok(inspect.stdout.includes(state));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compiled semantic rename report carries attribution and registry evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-rename-report-'));
  try {
    const source = join(dir, 'fixture.json'), output = join(dir, 'out.mc1.20.5.nonvalidated.schem');
    writeFileSync(source, JSON.stringify(fixture('minecraft:grass', '1.13', 1519)));
    const result = runPython(compileCode, source, output, '1.20.5', 'yes');
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.validation, 'NONVALIDATED');
    assert.equal(report.conversion.targetDataVersion, 3837);
    const change = report.conversion.changes[0];
    assert.equal(change.from, 'minecraft:grass'); assert.equal(change.to, 'minecraft:short_grass');
    assert.match(change.evidence[0].source, /Java_Edition_1.20.3#Blocks/);
    assert.match(change.evidence[0].sourceAttribution, /Minecraft Wiki/);
    assert.match(change.evidence[0].registry, /sources.lock.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('1.21.4 domain-checked compilation preserves an existing versioned binary', () => {
  const dir = mkdtempSync(join(tmpdir(),'history-preserved-'));
  try {
    const source = resolve('schematics/blueprints/pack1/03_big_red_barn.json');
    const expected = readFileSync('schematics/schems/pack1/03_big_red_barn.mc1.21.4.schem');
    const output = join(dir,'barn.nonvalidated.schem');
    const result = runPython(compileCode,source,output,'1.21.4','yes'); assert.equal(result.status,0,result.stderr);
    assert.deepEqual(readFileSync(output), expected);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('pack1 barn compiles for exact 1.20.2 without an unreviewed state conversion', () => {
  const dir = mkdtempSync(join(tmpdir(),'history-1202-pack-'));
  try {
    const source = resolve('schematics/blueprints/pack1/03_big_red_barn.json');
    const output = join(dir,'barn.mc1.20.2.nonvalidated.schem');
    const strict = join(dir,'barn.mc1.20.2.schem');
    let result = runPython(compileCode,source,strict,'1.20.2','no');
    assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).validation,'STRICT_VALIDATED');
    result = runPython(compileCode,source,output,'1.20.2','yes'); assert.equal(result.status,0,result.stderr);
    const report = JSON.parse(result.stdout), original = JSON.parse(readFileSync(source));
    assert.equal(report.validation,'NONVALIDATED'); assert.equal(report.conversion.targetDataVersion,3578);
    assert.deepEqual(report.conversion.changes,[]); assert.deepEqual(report.conversion.legend,original.legend);
    for (const state of Object.values(report.conversion.legend)) validateState(state,loadRelease('1.20.2'));
    const inspect = runPython("import nbtlib,sys; n=nbtlib.load(sys.argv[1]); print(int(n['DataVersion']), int(n['Width']), int(n['Height']), int(n['Length']))",output);
    assert.equal(inspect.status,0,inspect.stderr); assert.match(inspect.stdout,/3578 18 17 19/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
