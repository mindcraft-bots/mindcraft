import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = process.env.HISTORY_TEST_PYTHON || 'python3';

test('shallow source fixture without Git creates audit parents, refuses collisions and symlink escapes', t => {
  const copy = mkdtempSync(path.join(os.tmpdir(), 'audit-source-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  mkdirSync(path.join(copy, 'schematics/tooling'), { recursive: true });
  cpSync(path.join(root, 'schematics/tooling/audit_batch.py'), path.join(copy, 'schematics/tooling/audit_batch.py'));
  mkdirSync(path.join(copy, 'schematics/blueprints/pack2'), { recursive: true });
  mkdirSync(path.join(copy, 'schematics/schems/pack2'), { recursive: true });
  writeFileSync(path.join(copy, 'schematics/blueprints/pack2/fixture.json'), JSON.stringify({ minecraft_version: '1.21.4', data_version: 4189 }));
  assert.equal(existsSync(path.join(copy, '.git')), false);
  assert.equal(existsSync(path.join(copy, 'tmp')), false);
  const run = output => spawnSync(python, ['schematics/tooling/audit_batch.py', '--pack', 'pack2', '--minecraft-version', '1.21.4', '--data-version', '4189', '--output-dir', output], { cwd: copy, encoding: 'utf8' });
  // Missing tooling/assets intentionally fail the audit after creating its isolated reports.
  const result = run('tmp/nested/report');
  assert.notEqual(result.status, 0);
  assert(existsSync(path.join(copy, 'tmp/nested/report/batch_validation.json')), result.stderr || result.stdout);
  const marker = path.join(copy, 'tmp/nested/report/user-data');
  writeFileSync(marker, 'keep');
  assert.notEqual(run('tmp/nested/report').status, 0);
  assert.equal(readFileSync(marker, 'utf8'), 'keep');
  const outside = path.join(copy, 'outside');
  mkdirSync(outside); writeFileSync(path.join(outside, 'user-data'), 'keep');
  symlinkSync(outside, path.join(copy, 'tmp/link'));
  assert.notEqual(run('tmp/link/report').status, 0);
  assert.notEqual(run('tmp/../outside/report').status, 0);
  assert.equal(existsSync(path.join(outside, 'report')), false);
  assert.equal(readFileSync(path.join(outside, 'user-data'), 'utf8'), 'keep');
  renameSync(path.join(copy, 'tmp'), path.join(copy, 'original-tmp'));
  symlinkSync(outside, path.join(copy, 'tmp'));
  assert.notEqual(run('tmp/report').status, 0);
  assert.equal(existsSync(path.join(outside, 'report')), false);
  assert.equal(readFileSync(path.join(copy, 'original-tmp/nested/report/user-data'), 'utf8'), 'keep');
  assert.equal(readFileSync(path.join(outside, 'user-data'), 'utf8'), 'keep');
});

test('batch report source and asset links resolve from different output depths', t => {
  const copy = mkdtempSync(path.join(os.tmpdir(), 'audit-links-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const name of ['schematics/tooling', 'src/agent/commands', 'schematics/blueprints/pack2', 'schematics/schems/pack2']) mkdirSync(path.join(copy, name), { recursive: true });
  cpSync(path.join(root, 'schematics/tooling/audit_batch.py'), path.join(copy, 'schematics/tooling/audit_batch.py'));
  for (const name of ['src/agent/commands/actions.js','schematics/blueprints/pack2/build.json','schematics/schems/pack2/build.schem']) writeFileSync(path.join(copy, name), 'fixture');
  const code = `
import json, sys
from pathlib import Path
sys.path.insert(0, 'schematics/tooling')
import audit_batch
item = {'blueprint': {'path': 'schematics/blueprints/pack2/build.json'}, 'schematic': {'path': 'schematics/schems/pack2/build.schem'}, 'group': 7, 'id': 4, 'checks': {'production_reader': {'result': 'PASS'}, 'binary': {'result': 'PASS'}, 'deterministic_regeneration': {'result': 'PASS'}}}
print(json.dumps([audit_batch.make_rows({'builds': [item]}, 'pack2', Path(p).resolve())[0] for p in sys.argv[1:]]))
`;
  const dirs = ['tmp/report', 'tmp/one/two/deep/report'];
  const result = spawnSync(python, ['-B','-c',code,...dirs], { cwd:copy, encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  for (let i=0; i<dirs.length; i++) {
    const links = [...rows[i].matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]);
    assert.equal(links.length, 3);
    const resolved = links.map(link => path.resolve(copy, dirs[i], link.replace(/:\d+$/, '')));
    assert.deepEqual(resolved, ['schematics/blueprints/pack2/build.json','schematics/schems/pack2/build.schem','src/agent/commands/actions.js'].map(p=>path.join(copy,p)));
    assert(resolved.every(existsSync)); assert.match(links[2], /actions\.js:492$/);
  }
  assert.notEqual(rows[0], rows[1]);
});
