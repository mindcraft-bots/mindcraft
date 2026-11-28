import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

for (const [label, host] of [['absent', null], ['present', 'unix:///var/run/docker.sock']]) {
  test(`synthetic immutable pack cache invariants with inherited DOCKER_HOST ${label}`, () => {
    const env = { ...process.env };
    if (host === null) delete env.DOCKER_HOST;
    else env.DOCKER_HOST = host;
    const result = spawnSync('python3', ['-B', 'test/schematic/pack_cache_tests.py'], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
