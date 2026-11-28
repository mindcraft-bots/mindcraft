import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { discoverSchematicTests } from '../../run_schematic_tests.mjs';

test('actual pack1 test files are discovered exactly once by the suite runner', () => {
  const suite = fileURLToPath(new URL('../', import.meta.url));
  const pack = path.join(suite, 'pack1');
  const discovered = discoverSchematicTests(suite);
  const expected = readdirSync(pack, { withFileTypes:true }).filter(e => e.isFile() && e.name.endsWith('.test.js')).map(e => path.join(pack, e.name));
  assert(expected.includes(path.join(pack, 'bee_repair_history.test.js')));
  assert(expected.includes(path.join(pack, 'wardrobe_archive_encoding.test.js')));
  for (const file of expected) assert.equal(discovered.filter(name => name === file).length, 1, file);
});
