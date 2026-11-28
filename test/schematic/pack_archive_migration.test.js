import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCHEMATICS_DIR, resolveSchematicPath } from '../../src/utils/schematic/paths.js';
import { schematicProvenance } from '../../src/utils/schematic/provenance.js';

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

test('inventory verification detects missing, extra, duplicated and modified fixture files', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'archive-inventory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('synthetic archive');
  const item = { name: 'fixture.schem', bytes: bytes.length, sha256: sha(bytes) };
  await writeFile(path.join(dir, item.name), bytes);
  await verifyInventory(dir, { files: [item] });
  await assert.rejects(verifyInventory(dir, { files: [item, item] }), /duplicate/);
  await writeFile(path.join(dir, 'extra.schem'), 'extra');
  await assert.rejects(verifyInventory(dir, { files: [item] }));
  await rm(path.join(dir, 'extra.schem'));
  await writeFile(path.join(dir, item.name), 'tampered');
  await assert.rejects(verifyInventory(dir, { files: [item] }));
  await rm(path.join(dir, item.name));
  await assert.rejects(verifyInventory(dir, { files: [item] }));
});

// Pack-wide integration: inventory and pinned hashes cover actual shipped content, independently of Git.
