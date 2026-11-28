import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('isolated CI action, timing, environment and failure fixtures', () => {
    const result = spawnSync('python3', ['-B', 'test/isolated_ci_tests.py', '-v'], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
