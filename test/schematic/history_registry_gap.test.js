import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DATA_ROOT, loadRelease } from '../../schematics/tooling/history_registry.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (path) => JSON.parse(readFileSync(path));
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));

// Build the very same synthetic three-release gap fixture used by the generator tests.
test('generated gap profiles are authenticated and deltas cannot claim an inconsistent predecessor', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'history-gap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const python = `
import importlib.util, pathlib, sys
p = pathlib.Path('schematics/tooling/block_history/test_history.py').resolve()
spec = importlib.util.spec_from_file_location('history_fixture', p)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
f = m.FixtureTests(); f.setUp()
try:
    if len(sys.argv) < 3:
        r = f.lock['releases'][1]; r['kind'] = 'unavailable'; r['reason'] = 'report missing'
    for name, data in m.g.build(f.lock, f.cache).items():
        path = pathlib.Path(sys.argv[1]) / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
finally:
    f.doCleanups()
`;
  const built = spawnSync('python3', ['-c', python, dir], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const pristine = join(dir, 'pristine');
  // Keep generated files separate so each forgery starts with identical authentic bytes.
  const original = mkdtempSync(join(tmpdir(), 'history-gap-original-'));
  t.after(() => rmSync(original, { recursive: true, force: true }));
  cpSync(dir, original, { recursive: true });
  let sequence = 0;
  const fixture = () => { const path = `${pristine}-${sequence++}`; cpSync(original, path, { recursive: true }); return path; };
  const indexHash = (root) => digest(readFileSync(join(root, 'index.json')));
  const edit = (root, mutate) => {
    const indexPath = join(root, 'index.json'), index = readJson(indexPath);
    const prior = index.releases[1], current = index.releases[2];
    const priorPath = join(root, prior.config), currentPath = join(root, current.config);
    const priorConfig = readJson(priorPath), config = readJson(currentPath);
    const deltaPath = join(root, config.delta.path), delta = JSON.parse(gunzipSync(readFileSync(deltaPath)));
    mutate({ index, prior, current, priorConfig, config, delta });
    writeFileSync(deltaPath, gzipSync(JSON.stringify(delta)));
    config.delta.sha256 = digest(readFileSync(deltaPath));
    writeJson(currentPath, config); current.sha256 = digest(readFileSync(currentPath));
    writeJson(priorPath, priorConfig); prior.sha256 = digest(readFileSync(priorPath));
    writeJson(indexPath, index);
    return indexHash(root);
  };
  const valid = fixture();
  const result = loadRelease('1.31', valid, indexHash(valid));
  assert.equal(result.delta.kind, 'after_gap'); assert.equal(result.delta.from, null);
  assert.deepEqual(result.delta.baseline, Object.keys(result.blocks));
  assert.throws(() => loadRelease('1.30.1', valid, indexHash(valid)), /unavailable coverage/);
  assert.equal(loadRelease('1.30', valid, indexHash(valid)).delta.kind, 'baseline');

  for (const [label, mutate] of [
    ['gap with predecessor', ({ delta }) => { delta.from = '1.30.1'; }],
    ['gap missing predecessor field', ({ delta }) => { delete delta.from; }],
    ['gap labeled adjacent', ({ delta }) => { delta.kind = 'adjacent'; delta.from = '1.30.1'; }],
    ['gap labeled baseline', ({ delta }) => { delta.kind = 'baseline'; }],
    ['gap claims additions', ({ delta }) => { delta.added = ['minecraft:stone']; }],
    ['gap claims removals', ({ delta }) => { delta.removed = ['minecraft:stone']; }],
    ['gap claims schema changes', ({ delta }) => { delta.changed = { 'minecraft:stone': {} }; }],
    ['gap claims indeterminate comparisons', ({ delta }) => { delta.schema_indeterminate = ['minecraft:stone']; }],
    ['gap baseline omits a block', ({ delta }) => { delta.baseline.pop(); }],
    ['gap baseline duplicates a block', ({ delta }) => { delta.baseline[0] = delta.baseline[1]; }],
    ['gap reuses prior registry', ({ config }) => { config.same_registry_as_previous = true; }],
    ['unavailable release identity', ({ priorConfig }) => { priorConfig.release = '1.30'; }],
    ['unavailable provenance', ({ priorConfig }) => { priorConfig.generator_sha256 = '0'.repeat(64); }],
    ['unavailable edition', ({ priorConfig }) => { priorConfig.edition = 'bedrock'; }],
    ['unavailable schema', ({ priorConfig }) => { priorConfig.schema = 2; }],
    ['unavailable data version', ({ priorConfig }) => { priorConfig.data_version = 2; }],
    ['unavailable index data version', ({ prior }) => { prior.data_version = 2; }],
    ['unavailable reason', ({ priorConfig }) => { priorConfig.reason = ''; }],
    ['unavailable registry', ({ priorConfig }) => { priorConfig.registry = {}; }],
    ['contradictory coverage', ({ prior }) => { prior.coverage = 'partial'; }],
    ['duplicate predecessor identity', ({ index, prior }) => { index.releases.unshift({ ...prior }); }],
  ]) {
    const root = fixture(), pin = edit(root, mutate);
    assert.throws(() => loadRelease('1.31', root, pin), undefined, label);
  }
  const badHash = fixture(), index = readJson(join(badHash, 'index.json'));
  writeFileSync(join(badHash, index.releases[1].config), '{}');
  assert.throws(() => loadRelease('1.31', badHash, indexHash(badHash)), /SHA-256 mismatch/);
  const badBaseline = fixture(), baselineIndexPath = join(badBaseline, 'index.json');
  const baselineIndex = readJson(baselineIndexPath), first = baselineIndex.releases[0];
  const firstPath = join(badBaseline, first.config), firstConfig = readJson(firstPath);
  const firstDeltaPath = join(badBaseline, firstConfig.delta.path);
  const firstDelta = JSON.parse(gunzipSync(readFileSync(firstDeltaPath)));
  firstDelta.from = '1.29';
  writeFileSync(firstDeltaPath, gzipSync(JSON.stringify(firstDelta)));
  firstConfig.delta.sha256 = digest(readFileSync(firstDeltaPath));
  writeJson(firstPath, firstConfig); first.sha256 = digest(readFileSync(firstPath));
  writeJson(baselineIndexPath, baselineIndex);
  assert.throws(() => loadRelease('1.30', badBaseline, indexHash(badBaseline)), /delta identity/);

  const noGap = join(dir, 'no-gap');
  const builtAdjacent = spawnSync('python3', ['-c', python, noGap, 'no-gap'], { encoding: 'utf8' });
  assert.equal(builtAdjacent.status, 0, builtAdjacent.stderr);
  assert.equal(loadRelease('1.31', noGap, indexHash(noGap)).delta.from, '1.30.1');
  for (const mutate of [
    ({ delta }) => { delta.from = null; },
    ({ delta }) => { delta.from = '1.30'; },
    ({ delta }) => { delta.kind = 'after_gap'; delta.from = null; },
  ]) {
    const root = join(dir, `no-gap-${sequence++}`); cpSync(noGap, root, { recursive: true });
    assert.throws(() => loadRelease('1.31', root, edit(root, mutate)), /delta identity/);
  }

});

test('all 51 pinned release profiles still load', () => {
  const index = readJson(join(DATA_ROOT, 'index.json'));
  assert.equal(index.releases.length, 51);
  for (const entry of index.releases) assert.equal(loadRelease(entry.release).version, entry.release);
});
