import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { syntheticSponge } from './synthetic_sponge.js';
import { writeFixtureProvenance } from './provenance_fixture.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const absent = ['.git', 'schematic-archive/pack1_originals', 'schematics/blueprints/pack1',
  'schematics/schems/pack1', 'schematics/tooling/pack1', 'schematics/tooling/validation/pack1', 'test/schematic/pack1'];

test('all generic schematic tests run in a source copy without real pack1 or Git', { timeout: 600000 }, t => {
  if (process.env.SCHEMATIC_GENERIC_ISOLATION === '1') {
    for (const name of absent) assert.equal(existsSync(path.join(root, name)), false, name);
    for (const pack of ['pack2', 'pack3']) assert(existsSync(path.join(root, 'schematics/schems', pack, 'fixture.mc1.21.4.schem')));
    return; // This is the child invocation of this same test, not an omitted test.
  }
  const copy = mkdtempSync(path.join(os.tmpdir(), 'schematic-generic-isolation-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  const excluded = new Set(['.git', 'node_modules', 'tmp']);
  cpSync(root, copy, { recursive: true, filter: source => {
    const parts = path.relative(root, source).split(path.sep);
    return !excluded.has(parts[0]) && !parts.some(part => part === 'pack1' || part === 'pack1_originals');
  }});
  symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
  for (const pack of ['pack2', 'pack3']) {
    const blueprints = path.join(copy, 'schematics/blueprints', pack);
    const schems = path.join(copy, 'schematics/schems', pack);
    mkdirSync(blueprints, { recursive: true }); mkdirSync(schems, { recursive: true });
    writeFileSync(path.join(blueprints, 'fixture.json'), JSON.stringify({ minecraft_version:'1.21.4', data_version:4189,
      width_x:1, height_y:1, length_z:1, legend:{s:'minecraft:stone'}, layers:[['s']] }));
    writeFileSync(path.join(schems, 'index.json'), JSON.stringify({ schemaVersion:2, groups:{7:{1:'fixture.schem'}} }));
    const file = path.join(schems, 'fixture.mc1.21.4.schem'), bytes = syntheticSponge();
    writeFileSync(file, bytes);
    writeFixtureProvenance(file, bytes);
  }
  for (const name of absent) assert.equal(existsSync(path.join(copy, name)), false, name);
  const directory = path.join(copy, 'test/schematic');
  const files = readdirSync(directory).filter(name => name.endsWith('.test.js')).sort().map(name => path.join(directory, name));
  assert(files.length > 0 && files.includes(path.join(directory, 'generic_pack_isolation.test.js')));
  const env = { ...process.env, SCHEMATIC_GENERIC_ISOLATION:'1' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: copy, env, encoding:'utf8', timeout:590000, maxBuffer:20 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.error || child.stderr || child.stdout);
  assert.match(child.stdout, /# fail 0/);
  assert.match(child.stdout, /# skipped 0/);
  const count = /^# tests (\d+)$/m.exec(child.stdout);
  assert(count, 'missing child test summary');
  t.diagnostic(`${files.length} generic files executed ${count[1]} tests without pack1 or Git`);
});
