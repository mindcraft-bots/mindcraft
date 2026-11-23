import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { discoverSchematicTests } from '../run_schematic_tests.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = name => readFile(path.join(root, name), 'utf8');
const exists = name => access(path.join(root, name));

test('root agent guidance scopes reusable tooling and preserves evidence', async () => {
  const guidance = await read('AGENTS.md');
  for (const pattern of [
    /canonical root location/i, /discovery vary/i, /nested guidance/i,
    /pack-neutral in both names and behavior/i, /honored or rejected/i,
    /hidden live pack1/i, /pack2\/pack3/i, /no-overwrite/i,
    /test\/schematic\/pack<N>\//, /schematics\/tooling\/validation\/pack<N>\//,
    /configuration out of blueprint folders/i, /historical evidence/i,
    /not assume every build or pack is symmetric/i, /DataVersions.*provenance.*release checks/i,
  ]) assert.match(guidance, pattern);
});

test('live guides refer to actual generic tools and scoped evidence', async () => {
  const guides = [
    'schematics/tooling/SYMMETRY.md',
    'schematics/tooling/PACK_MECHANICS.md',
    'schematics/tooling/BLUEPRINT_TOOLING.md',
    'schematics/tooling/validation/README.md',
  ];
  for (const name of guides) {
    const text = await read(name);
    for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(target)) continue;
      const relative = target.split('#', 1)[0].replace(/:\d+(?:-\d+)?$/, '');
      if (/(?:^|\/)pack1(?:\/|$)/i.test(relative)) continue; // Scoped evidence is covered by pack1 tests.
      if (relative) await exists(path.join(path.dirname(name), relative));
    }
    assert.doesNotMatch(text, /audit_pack1_|PACK1_MECHANICS\.md|bee_symmetry_regeneration\.test\.js|pack1_(?:mechanics|symmetry_audit)\.test\.js/);
  }
  for (const name of [
    'schematics/tooling/audit_pack_symmetry.mjs',
    'schematics/tooling/audit_pack_mechanics.mjs',
    'schematics/tooling/audit_batch.py',
    'test/schematic/pack_symmetry.test.js',
    'test/schematic/pack_mechanics.test.js',
  ]) await exists(name);

  const symmetry = await read(guides[0]);
  const mechanics = await read(guides[1]);
  const compiler = await read(guides[2]);
  const validation = await read(guides[3]);
  assert.match(symmetry, /node schematics\/tooling\/audit_pack_symmetry\.mjs --pack pack2/);
  assert.match(mechanics, /node schematics\/tooling\/audit_pack_mechanics\.mjs --pack pack2/);
  assert.match(compiler, /python3 schematics\/tooling\/audit_batch\.py --pack pack2 --minecraft-version 1\.21\.4 --data-version 4189 --output-dir tmp\/pack2-audit-new/);
  assert.match(compiler, /nbtlib==2\.0\.4/);
  assert.match(symmetry, /archive: true[\s\S]*absent or false does not require an archive/);
  assert.match(symmetry, /not.*requirements for symmetry/i);
  assert.match(mechanics, /only Java 1\.21\.4, data version 4189/i);
  assert.doesNotMatch(mechanics, />\s*\/tmp\/pack1-mechanics\.json/);
  assert.match(validation, /batch_validation\.json[^\n]*historical, not a current batch run/i);
});

test('schematic suite recursively discovers scoped tests and prompts describe pack scope', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-doc-discovery-'));
  try {
    await mkdir(path.join(temporary, 'pack2'));
    await writeFile(path.join(temporary, 'generic.test.js'), '');
    await writeFile(path.join(temporary, 'pack2', 'scoped.test.js'), '');
    assert.deepEqual(discoverSchematicTests(temporary), [
      path.join(temporary, 'generic.test.js'), path.join(temporary, 'pack2', 'scoped.test.js'),
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const readme = await read('README.md');
  assert.match(readme, /Node 22 recommended/);
  assert.match(readme, /npm run test:schematic[^\n]*recursively/i);
  for (const name of [
    'schematics/tooling/prompts/002-4-create-schemas-from-pictures.md',
    'schematics/tooling/prompts/003-voxel-architect-mode-instructions.md',
  ]) {
    const prompt = await read(name);
    assert.match(prompt, /pack1 examples.*illustrative/i);
    assert.match(prompt, /pack-neutral/i);
    assert.match(prompt, /audit_batch\.py --pack <packN>/);
    assert.match(prompt, /recursive/i);
  }
});
