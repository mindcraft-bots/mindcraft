import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCHEMATICS_DIR, resolveSchematicPath } from '../../../src/utils/schematic/paths.js';
import { schematicProvenance } from '../../../src/utils/schematic/provenance.js';

const archive = path.resolve('schematic-archive/pack1_originals');
const pack = path.join(SCHEMATICS_DIR, 'schems/pack1');
const sha = data => createHash('sha256').update(data).digest('hex');

async function verifyInventory(directory, inventory) {
  const names = inventory.files.map(item => item.name);
  assert.equal(new Set(names).size, names.length, 'duplicate archive entry');
  assert.deepEqual((await readdir(directory)).filter(n => n.endsWith('.schem')).sort(), [...names].sort());
  for (const item of inventory.files) {
    assert.equal(path.basename(item.name), item.name, 'archive entry must be a basename');
    const file = path.join(directory, item.name);
    assert.equal(await realpath(file), file);
    const bytes = await readFile(file);
    assert.equal(sha(bytes), item.sha256, item.name);
    assert.equal(bytes.length, item.bytes, item.name);
  }
}

test('archived originals and active variants match inventories and cannot select archive', async () => {
  const inventory = JSON.parse(await readFile(path.join(archive, 'inventory.json')));
  const historical = JSON.parse(await readFile('schematics/tooling/historical_artifacts.v1.json')).artifacts;
  assert.equal(inventory.files.length, 30);
  assert.equal((await realpath(archive)).startsWith(`${await realpath(SCHEMATICS_DIR)}${path.sep}`), false);
  const files = (await readdir(pack)).filter(n => n.endsWith('.schem')).sort();
  assert.equal(files.length, 60);
  await verifyInventory(archive, inventory);
  for (const item of inventory.files) {
    assert.equal(await realpath(path.join(archive, item.name)), path.join(archive, item.name));
    const bytes = await readFile(path.join(archive, item.name));
    assert.equal(sha(bytes), item.sha256);
    assert.equal(bytes.length, item.bytes);
    assert.equal(item.data_version, 4189);
    assert.equal(item.sha256, historical[`${inventory.original_directory}/${item.name}`]);
    await assert.rejects(resolveSchematicPath(item.name, archive, { version: '26.1' }), /No compatible known-version/);
    await assert.rejects(resolveSchematicPath(`schematic-archive/pack1_originals/${item.name}`, path.resolve('.'), { version: '26.1' }), /No compatible known-version/);
    await assert.rejects(resolveSchematicPath(`../schematic-archive/pack1_originals/${item.name}`, SCHEMATICS_DIR, { version: '26.1' }), /traversal/);
    for (const version of ['1.21.4', '26.1']) {
      const name = item.name.replace(/\.schem$/, `.mc${version}.schem`);
      assert(files.includes(name));
      const file = path.join(pack, name), digest = sha(await readFile(file));
      const pinned = historical[`schematics/schems/pack1/${name}`];
      if (pinned) assert.equal(digest, pinned, name);
      else {
        const provenance = await schematicProvenance(file);
        assert.equal(provenance.validationStatus, 'STRICT_VALIDATED', name);
        const metadata = JSON.parse(await readFile(`${file}.provenance.json`));
        assert.equal(metadata.sha256, digest, name);
      }
    }
  }
});
