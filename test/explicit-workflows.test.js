import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = 'python3';

test('timed live workflow requires a new log and propagates runner failure', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'mindcraft-timing-test-'));
    try {
        const bin = path.join(tmp, 'bin'); mkdirSync(bin);
        const make = path.join(bin, 'make'); writeFileSync(make, '#!/bin/sh\necho fixture-output\nexit 23\n'); chmodSync(make, 0o755);
        const log = path.join(tmp, 'output.log');
        const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
        const run = () => spawnSync(python, [path.join(root, 'scripts/time_schematics.py'), '--runner', 'make', '--log', log], { env, encoding: 'utf8' });
        const first = run(); assert.equal(first.status, 23); assert.match(first.stdout, /Wall: .*exit: 23/);
        assert.match(readFileSync(log, 'utf8'), /fixture-output/);
        assert.equal(run().status, 2); assert.match(readFileSync(log, 'utf8'), /fixture-output/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('dependency experiment isolates inputs and separates audit findings from errors', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'mindcraft-experiment-test-'));
    try {
        const repo = path.join(tmp, 'repo'); const parent = path.join(tmp, 'runs'); const bin = path.join(tmp, 'bin');
        for (const dir of [repo, parent, bin, path.join(repo, 'scripts'), path.join(repo, 'ci')]) mkdirSync(dir);
        for (const file of ['scripts/experiment_nodegyp.py', 'scripts/run_isolatedci.py', 'ci/snapshot_checkout.mjs', 'ci/quality_gate.mjs']) {
            copyFileSync(path.join(root, file), path.join(repo, file));
        }
        writeFileSync(path.join(repo, 'package.json'), '{"overrides":{"gl":{"node-gyp":"11.5.0"}}}\n');
        writeFileSync(path.join(repo, 'ci/npm-lock.json'), '{}\n');
        writeFileSync(path.join(repo, '.gitignore'), 'secret\nnode_modules/\npackage-lock.json\n');
        writeFileSync(path.join(repo, 'secret'), 'private');
        assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
        assert.equal(spawnSync('git', ['-C', repo, 'add', '.']).status, 0);
        const npm = path.join(bin, 'npm');
        writeFileSync(npm, '#!/bin/sh\nif [ "$1" = audit ]; then cat "$(dirname "$0")/audit"; exit "$(cat "$(dirname "$0")/status")"; fi\nexit 0\n'); chmodSync(npm, 0o755);
        const node = path.join(bin, 'node');
        writeFileSync(node, `#!/bin/sh\nif [ "$1" = -e ]; then exit 0; fi\nexec '${process.execPath}' "$@"\n`); chmodSync(node, 0o755);
        const run = (audit, status) => {
            writeFileSync(path.join(bin, 'audit'), audit); writeFileSync(path.join(bin, 'status'), status);
            return spawnSync(python, [path.join(repo, 'scripts/experiment_nodegyp.py'), '--workspace-parent', parent, '--node-gyp', '12.3.0'], {
                encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
            });
        };
        assert.equal(run('{"metadata":{"vulnerabilities":{"total":2}}}', '1').status, 0);
        assert.equal(run('{"error":"unavailable"}', '1').status, 1);
        const runDir = path.join(parent, readdirSync(parent)[0], 'checkout');
        assert.equal(JSON.parse(readFileSync(path.join(repo, 'package.json'))).overrides.gl['node-gyp'], '11.5.0');
        assert.equal(JSON.parse(readFileSync(path.join(runDir, 'package.json'))).overrides.gl['node-gyp'], '12.3.0');
        assert.throws(() => readFileSync(path.join(runDir, 'secret')));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
});
