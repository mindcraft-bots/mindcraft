import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SCHEMATICS_DIR, listSchematicEntries, resolveSchematicPath } from '../../src/utils/schematic/paths.js';
import { writeFixtureProvenance } from './provenance_fixture.js';
import { syntheticSponge } from './synthetic_sponge.js';

// The same manifest/listing contract applies to every discovered pack, not a fixed inventory.
async function checkPackContract(root) {
  const packs = (await readdir(path.join(root, 'schems'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^pack[0-9]+$/.test(entry.name)).map(entry => entry.name).sort();
  const versions = new Set();
  const mappings = new Map();
  for (const pack of packs) {
    const folder = path.join(root, 'schems', pack);
    const index = JSON.parse(await readFile(path.join(folder, 'index.json'), 'utf8'));
    assert.equal(index.schemaVersion, 2, pack);
    mappings.set(pack, Object.entries(index.groups).flatMap(([group, ids]) =>
      Object.entries(ids).map(([id, filename]) => ({ group: Number(group), id: Number(id), filename }))));
    for (const name of await readdir(folder)) {
      const match = /\.mc(\d+(?:\.\d+)+)(?:\.nonvalidated)?\.schem$/.exec(name);
      if (match) versions.add(match[1]);
    }
  }
  for (const version of versions) {
    const options = { version, allowNonvalidatedSchematic: true };
    const entries = await listSchematicEntries(root, options);
    for (const entry of entries.filter(item => packs.includes(item.pack))) {
      const base = entry.fileName.replace(/\.mc\d+(?:\.\d+)+(?:\.nonvalidated)?\.schem$/, '.schem');
      const owners = mappings.get(entry.pack);
      const owner = owners.find(item => item.filename === entry.fileName) ?? owners.find(item => item.filename === base);
      assert.deepEqual([entry.group, entry.fileId], owner ? [owner.group, owner.id] : [null, null], entry.fileName);
    }
    for (const entry of entries.filter(item => packs.includes(item.pack) && item.selected)) {
      const expected = path.join(root, 'schems', entry.pack, entry.fileName);
      assert.equal(await resolveSchematicPath(entry.selector, root, options), expected);
      assert.equal(await resolveSchematicPath(`${entry.pack}:${entry.fileName}`, root, options), expected);
      assert.equal(entry.compatible, true);
    }
  }
  return packs;
}

test('all available real packs satisfy the shared selection contract', async () => {
  assert.ok((await checkPackContract(SCHEMATICS_DIR)).length > 0);
});

test('the shared contract handles sparse, different pack2 and pack3 inventories', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pack-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [pack, version, groups] of [
    ['pack2', '1.21.4', { 7: { 12: 'observatory.schem' } }],
    ['pack3', '26.1', { 3: { 9: 'canal.schem', 15: 'tower.schem' }, 25: { 2: 'orchard.schem' } }],
  ]) {
    const folder = path.join(root, 'schems', pack);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'index.json'), JSON.stringify({ schemaVersion: 2, groups }));
    for (const filename of Object.values(groups).flatMap(group => Object.values(group))) {
      const file = path.join(folder, filename.replace(/\.schem$/, `.mc${version}.schem`));
      const bytes = syntheticSponge(version);
      await writeFile(file, bytes);
      writeFixtureProvenance(file, bytes);
    }
  }
  assert.deepEqual(await checkPackContract(root), ['pack2', 'pack3']);
  const entries = await listSchematicEntries(root, { version: '26.1', allowNonvalidatedSchematic: true });
  assert.deepEqual(entries.map(e => [e.pack, e.group, e.fileId]), [
    ['pack2', 7, 12], ['pack3', 3, 9], ['pack3', 3, 15], ['pack3', 25, 2],
  ]);
});
