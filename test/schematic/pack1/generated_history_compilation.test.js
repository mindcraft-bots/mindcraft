import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DATA_ROOT, loadRelease, validateState, validateBlueprint } from '../../../schematics/tooling/history_registry.mjs';
import { convertBlueprint, validateHistory } from '../../../schematics/tooling/convert_history.mjs';

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
