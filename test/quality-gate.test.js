import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'mindcraft-gate-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'ci'));
    mkdirSync(join(dir, 'bin'));
    for (const name of ['run_quality_gate.sh', 'run_schematics.sh']) copyFileSync(join(root, 'ci', name), join(dir, 'ci', name));
    const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, TMPDIR: dir, CALLS: join(dir, 'calls') };
    const command = (name, body) => writeFileSync(join(dir, 'bin', name), `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> "$CALLS"\n${body}\n`, { mode: 0o755 });
    return { dir, env, command };
}

test('full gate continues to live CI and fails when patch verification fails', t => {
    const { dir, env, command } = fixture(t);
    command('git', 'exit 0');
    command('node', 'case "$1" in scripts/verify_patch.js) exit 9;; esac\nexit 0');
    command('npm', 'exit 0');
    command('task', 'exit 0');
    const result = spawnSync('sh', [join(dir, 'ci/run_quality_gate.sh'), 'full'], { env, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /FAIL: patches \(exit 9\)/);
    assert.match(readFileSync(env.CALLS, 'utf8'), /task test:schematics/);
    assert.match(result.stdout, /Private logs:/);
});

test('fast gate clearly omits live CI', t => {
    const { dir, env, command } = fixture(t);
    for (const name of ['git', 'node', 'npm', 'task']) command(name, 'exit 0');
    const result = spawnSync('sh', [join(dir, 'ci/run_quality_gate.sh'), 'fast'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not the mandatory full gate/);
    assert.doesNotMatch(readFileSync(env.CALLS, 'utf8'), /task test:schematics/);
});

test('live runner reports cleanup failure instead of masking it', t => {
    const { dir, env, command } = fixture(t);
    command('docker', 'case " $* " in *" down "*) exit 8;; esac\nexit 0');
    const result = spawnSync('sh', [join(dir, 'ci/run_schematics.sh')], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cleanup failed for Compose project/);
    const calls = readFileSync(env.CALLS, 'utf8');
    assert.match(calls, / up --build /);
    assert.match(calls, / down -v --remove-orphans/);
});
