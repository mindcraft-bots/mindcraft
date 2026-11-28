import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/start_bots.sh');

test('launcher uses the existing unified service from the project root and propagates failure', t => {
    const dir = mkdtempSync(join(tmpdir(), 'mindcraft-launcher-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const output = join(dir, 'args');
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\npwd > "$CAPTURE"\nprintf "%s\\n" "$@" >> "$CAPTURE"\nexit 23\n', { mode: 0o755 });
    const result = spawnSync(script, [], { cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CAPTURE: output } });
    assert.equal(result.status, 23);
    assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n'), [root, 'compose', 'up', '--force-recreate', 'bots']);
    assert.match(readFileSync(join(root, 'docker-compose.yml'), 'utf8'), /^ {2}bots:/m);
});

test('help does not run Docker and invalid arguments fail', () => {
    assert.equal(spawnSync(script, ['--help'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync(script, ['--invalid'], { encoding: 'utf8' }).status, 2);
});
