import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = name => readFile(path.join(root, name), 'utf8');

test('pack1 documentation points to its real configuration, tests and evidence', async () => {
  for (const name of [
    'schematics/tooling/pack1/symmetry.json',
    'schematics/tooling/validation/pack1/batch_validation.json',
    'schematics/tooling/validation/pack1/symmetry_audit.json',
    'schematics/tooling/validation/pack1/mechanics_audit.json',
    'test/schematic/pack1/symmetry_audit.test.js',
    'test/schematic/pack1/mechanics.test.js',
  ]) await access(path.join(root, name));
  const config = JSON.parse(await read('schematics/tooling/pack1/symmetry.json'));
  assert.equal(config.archive, true);
  assert.deepEqual(config.targets, ['1.21.4', '26.1']);
  const index = await read('schematics/tooling/validation/pack1/README.md');
  assert.match(index, /batch_validation\.json[^\n]*historical snapshots/i);
  const symmetry = await read('schematics/tooling/validation/pack1/symmetry_audit.md');
  assert.match(symmetry, /node schematics\/tooling\/audit_pack_symmetry\.mjs --pack pack1/);
  assert.match(symmetry, /node --test test\/schematic\/pack1\/symmetry_audit\.test\.js/);
  const review = await read('schematics/tooling/validation/pack1/integration_review.md');
  assert.match(review, /historical diagnostic regression test[^\n]*wardrobe_reproducibility\.test\.js[^\n]*no longer present/i);
});

test('guide preserves the historical archive reference without claiming missing assets are present', async () => {
  const guide = await read('schematics/README.md');
  const targets = [...guide.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1])
    .filter(target => /(?:^|\/)pack1(?:_originals)?(?:\/|#|$)/i.test(target));
  assert(targets.some(target => target.includes('pack1_originals/README.md')));
  assert(targets.some(target => target.includes('schems/pack1/index.json')));
  const archiveTarget = targets.find(target => target.includes('pack1_originals/README.md'));
  const archivePath = path.resolve(root, 'schematics', archiveTarget.replace(/:\d+(?:-\d+)?$/, '').split('#', 1)[0]);
  let archiveAvailable = true;
  try {
    await access(archivePath);
  } catch {
    archiveAvailable = false;
    assert.match(guide, /referenced `schematic-archive\/pack1_originals\/` directory is absent from this checkout/i);
  }
  for (const target of targets) {
    const local = target.replace(/:\d+(?:-\d+)?$/, '').split('#', 1)[0];
    if (!archiveAvailable && local.includes('pack1_originals/')) continue;
    await access(path.resolve(root, 'schematics', local));
  }
});

test('command documentation retains the real pack1 selector examples', () => {
  const loader = fileURLToPath(new URL('../commands-loader.js', import.meta.url));
  const index = new URL('../../../src/agent/commands/index.js', import.meta.url).href;
  const script = `import { getCommandDocs, parseCommandMessage } from ${JSON.stringify(index)};
    console.log(JSON.stringify({docs:getCommandDocs({blocked_actions:[]}), indexed:parseCommandMessage('!buildSchematic("pack1:02:01")'), named:parseCommandMessage('!buildSchematic("pack1:02_bee_hot_air_balloon")')}));`;
  const child = spawnSync(process.execPath, ['--experimental-loader', loader, '--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.match(result.docs, /Andy build file id 01 from group 02 of pack1/i);
  assert.match(result.docs, /pack1:02:01/);
  assert.match(result.docs, /schema pack1\/02_bee_hot_air_balloon/i);
  assert.deepEqual(result.indexed.args, ['pack1:02:01', null, null, null, null, null, null]);
  assert.deepEqual(result.named.args, ['pack1:02_bee_hot_air_balloon', null, null, null, null, null, null]);
});
