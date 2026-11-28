import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scripts = join(root, 'scripts');

test('script names, interpreters and executable permissions follow the convention', () => {
    const entries = readdirSync(scripts).filter((name) => /\.(sh|js|py)$/.test(name));
    assert.deepEqual(entries.sort(), [
        'build_bots.sh', 'collect_diagnostics.py', 'experiment_nodegyp.py', 'get_logs.sh', 'run_isolatedci.py', 'start_bots.sh', 'time_schematics.py', 'update_project.sh', 'verify_patch.js',
    ]);
    for (const name of entries) {
        assert.match(name, /^[a-z]+_[a-z]+\.(sh|js|py)$/);
        const path = join(scripts, name);
        assert.ok((statSync(path).mode & 0o111) === 0o111, `${name} must be executable`);
        const shebang = name.endsWith('.sh') ? '#!/bin/sh\n' : name.endsWith('.py') ? '#!/usr/bin/env python3\n' : '#!/usr/bin/env node\n';
        assert.ok(readFileSync(path, 'utf8').startsWith(shebang));
    }
});

test('script entry points provide safe help and Docker helpers preserve their commands', (t) => {
    const temp = mkdtempSync(join(tmpdir(), 'mindcraft-script-test-'));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const log = join(temp, 'docker.log');
    const docker = join(temp, 'docker');
    writeFileSync(docker, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_TEST_LOG"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${temp}:${process.env.PATH}`, DOCKER_TEST_LOG: log };
    const run = (name, args = []) => spawnSync(join(scripts, name), args, { cwd: root, env, encoding: 'utf8' });
    for (const name of ['build_bots.sh', 'collect_diagnostics.py', 'get_logs.sh', 'run_isolatedci.py', 'start_bots.sh', 'update_project.sh']) {
        const result = run(name, ['--help']);
        assert.equal(result.status, 0, result.error || result.stderr);
        assert.match(result.stdout, /usage:/i);
        if (name === 'collect_diagnostics.py') assert.match(result.stdout, /Usage: collect_diagnostics\.py \[--project-directory DIR\]/);
    }
    assert.throws(() => readFileSync(log), { code: 'ENOENT' });
    for (const name of ['build_bots.sh', 'get_logs.sh', 'start_bots.sh']) {
        const result = run(name);
        assert.equal(result.status, 0, result.error || result.stderr);
    }
    assert.equal(readFileSync(log, 'utf8'), [
        'compose build bots',
        'compose ps bots',
        'compose logs --tail=100 bots',
        'compose up --force-recreate bots',
        '',
    ].join('\n'));
});
