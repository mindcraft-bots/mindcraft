import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMATICS_DIR } from '../../../src/utils/schematic/paths.js';
import { schematicProvenance } from '../../../src/utils/schematic/provenance.js';

const pack = path.join(SCHEMATICS_DIR, 'schems/pack1');
const blueprints = path.join(SCHEMATICS_DIR, 'blueprints/pack1');
const sha = data => createHash('sha256').update(data).digest('hex');

test('manifest families have exactly two current variants with verified provenance', async () => {
  const manifest = JSON.parse(await readFile(path.join(pack, 'index.json')));
  const families = Object.values(manifest.groups).flatMap(group => Object.values(group));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(families.length, 30);
  assert.equal(new Set(families).size, 30);
  assert(families.every(name => path.basename(name) === name && name.endsWith('.schem')));
  const stems = families.map(name => name.slice(0, -6));
  assert.deepEqual((await readdir(blueprints)).filter(n => n.endsWith('.json')).sort(), stems.map(n => `${n}.json`).sort());
  const expected = stems.flatMap(stem => ['1.21.4', '26.1'].map(v => `${stem}.mc${v}.schem`)).sort();
  assert.deepEqual((await readdir(pack)).filter(n => n.endsWith('.schem')).sort(), expected);
  const historical = JSON.parse(await readFile('schematics/tooling/historical_artifacts.v1.json')).artifacts;
  const bee = '02_bee_hot_air_balloon';
  let pinned = 0, strict = 0;
  for (const name of expected) {
    const file = path.join(pack, name), digest = sha(await readFile(file));
    const provenance = await schematicProvenance(file);
    if (name.startsWith(`${bee}.mc`)) {
      strict++;
      assert.equal(provenance.validationStatus, 'STRICT_VALIDATED', name);
      assert.equal(provenance.sha256, digest);
      const meta = JSON.parse(await readFile(`${file}.provenance.json`));
      const version = name.slice(`${bee}.mc`.length, -6);
      assert.equal(meta.artifact, name);
      assert.equal(meta.validation, 'STRICT_VALIDATED');
      assert.equal(meta.convertTo, version);
      assert.equal(meta.blueprint, `schematics/blueprints/pack1/${bee}.json`);
      assert.equal(meta.blueprintSha256, sha(await readFile(path.join(blueprints, `${bee}.json`))));
      assert.equal(meta.sha256, digest);
      assert.equal((await readFile(`${file}.provenance.sha256`, 'utf8')).trim(), sha(await readFile(`${file}.provenance.json`)));
    } else {
      pinned++;
      assert.equal(digest, historical[`schematics/schems/pack1/${name}`], name);
      assert.equal(provenance.validationStatus, 'HISTORICAL_UNKNOWN', name);
    }
  }
  assert.equal(pinned, 58);
  assert.equal(strict, 2);
});
