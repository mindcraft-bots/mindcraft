import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cpuCapacity, parseArgs, productionChecks, recommendedJobs, resultStatus, runChecks, snapshot } from '../ci/quality_gate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureScript = path.join(root, 'test/fixtures/quality-gate/case.mjs');
const config = path.join(root, 'test/fixtures/quality-gate/cases.json');
const harness = path.join(root, 'test/fixtures/quality-gate/signal-harness.mjs');

function fixture(t) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-case-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function check(name, dir, group) {
    return { name, command: process.execPath, args: [fixtureScript, config, name, dir], cwd: root, group };
}
async function waitFor(file) {
    for (let i = 0; i < 200 && !existsSync(file); i++) await delay(25);
    assert.ok(existsSync(file), `Timed out waiting for ${file}`);
}

test('explicit CLI selection is strict', () => {
    assert.deepEqual(parseArgs(['fast', '--jobs', '1']), { mode: 'fast', jobs: 1 });
    assert.deepEqual(parseArgs(['--jobs', '2', 'full']), { mode: 'full', jobs: 2 });
    assert.deepEqual(parseArgs(['--jobs', '3']), { mode: 'full', jobs: 3 });
    for (const args of [['fast', 'full'], ['--jobs', '0'], ['--jobs', '4'], ['--jobs', '03'], ['--config', config], ['--jobs', '1', '--jobs', '2']]) assert.throws(() => parseArgs(args));
    const result = spawnSync('sh', ['ci/run_quality_gate.sh', '--config', config], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
    const env = { ...process.env, SCHEMATIC_GENERIC_ISOLATION: '1' };
    delete env.NODE_TEST_CONTEXT;
    const unsafe = spawnSync('sh', ['ci/run_quality_gate.sh', 'fast'], { cwd: root, encoding: 'utf8', env });
    assert.equal(unsafe.status, 2);
    assert.match(unsafe.stderr, /Refusing test-control environment variable: SCHEMATIC_GENERIC_ISOLATION/);
    assert.deepEqual(productionChecks('fast', root, root, root, root, root).map(item => item.name), ['schematics-tests', 'schematics-generic-isolation', 'diff-check', 'patches', 'root-tests']);
    assert.deepEqual(productionChecks('full', root, root, root, root, root).map(item => item.name), ['schematics-live', 'schematics-tests', 'schematics-generic-isolation', 'diff-check', 'patches', 'root-tests']);
    assert.throws(() => productionChecks('other', root, root, root, root));
});

test('legacy Make gate target invokes the full gate', () => {
    const result = spawnSync('make', ['-n', 'quality-gate'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\.\/ci\/run_quality_gate\.sh full/);
});

test('worker recommendations require conservative CPU and memory headroom', () => {
    const gib = 1024 ** 3;
    assert.equal(recommendedJobs(12, 48 * gib, 16 * gib), 3);
    assert.equal(recommendedJobs(11, 48 * gib, 16 * gib), 2);
    assert.equal(recommendedJobs(12, 48 * gib - 1, 16 * gib), 2);
    assert.equal(recommendedJobs(12, 48 * gib, 16 * gib - 1), 2);
    assert.equal(recommendedJobs(2, 6 * gib, 0), 2);
    assert.equal(recommendedJobs(1, 64 * gib, 32 * gib), 1);
    assert.equal(recommendedJobs(12, 6 * gib - 1, 32 * gib), 1);
});

test('CPU capacity honors explicit v1 and v2 hierarchy scenarios and affinity', () => {
    const scenarios = JSON.parse(readFileSync(path.join(root, 'test/fixtures/quality-gate/cpu-capacity.json'), 'utf8'));
    for (const scenario of scenarios) {
        const read = file => {
            if (!Object.hasOwn(scenario.files, file)) throw new Error(`Missing fixture: ${file}`);
            return scenario.files[file];
        };
        assert.equal(cpuCapacity({ platform: 'linux', affinity: scenario.affinity, read }), scenario.expected, scenario.name);
    }
    assert.equal(cpuCapacity({ platform: 'darwin', affinity: 12, read: () => '' }), 1);
    assert.equal(cpuCapacity({ platform: 'linux', affinity: NaN, read: () => '' }), 1);
});

test('npm script-shell bypass cannot make either fixed gate selection pass', { timeout: 30000 }, t => {
    const dir = fixture(t), repo = path.join(dir, 'repo');
    mkdirSync(path.join(repo, 'ci'), { recursive: true }); mkdirSync(path.join(repo, 'test'));
    copyFileSync(path.join(root, 'ci/quality_gate.mjs'), path.join(repo, 'ci/quality_gate.mjs'));
    copyFileSync(path.join(root, 'ci/run_quality_gate.sh'), path.join(repo, 'ci/run_quality_gate.sh'));
    writeFileSync(path.join(repo, 'ci/run_schematics.sh'), 'exit 0\n');
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:schematic': 'node test/run_schematic_tests.mjs' } }));
    writeFileSync(path.join(repo, 'test/run_schematic_tests.mjs'), 'console.log(`selection executed: ${process.argv[2]}`); process.exitCode = 23;\n');
    writeFileSync(path.join(repo, 'test/dummy.test.js'), '');
    mkdirSync(path.join(repo, 'scripts'));
    writeFileSync(path.join(repo, 'scripts/verify_patch.js'), '');
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
    const baseEnv = { ...process.env }; delete baseEnv.NODE_TEST_CONTEXT; delete baseEnv.NODE_OPTIONS;
    for (const [mode, key] of [['fast', 'npm_config_script_shell'], ['full', 'NPM_CONFIG_SCRIPT_SHELL']]) {
        const env = { ...baseEnv, [key]: '/bin/echo' };
        const bypass = spawnSync('npm', ['run', 'test:schematic', '--', '--other'], { cwd: repo, env, encoding: 'utf8' });
        assert.equal(bypass.status, 0, bypass.stderr);
        assert.doesNotMatch(bypass.stdout, /selection executed:/);
        const gate = spawnSync('sh', ['ci/run_quality_gate.sh', mode, '--jobs', '2'], { cwd: repo, env, encoding: 'utf8', timeout: 20000 });
        assert.equal(gate.status, 1, `${gate.stdout}\n${gate.stderr}`);
        assert.match(gate.stdout, /FAIL: schematics-tests \([^\n]*exit 23/);
        assert.match(gate.stdout, /FAIL: schematics-generic-isolation \([^\n]*exit 23/);
        assert.doesNotMatch(gate.stdout, /(?:Full quality gate|Fast checks) PASSED/);
        const logs = /Logs: (.+)/.exec(gate.stdout)?.[1];
        assert.ok(logs);
        t.after(() => rmSync(logs, { recursive: true, force: true }));
        assert.match(readFileSync(path.join(logs, 'schematics-tests.log'), 'utf8'), /selection executed: --other/);
        assert.match(readFileSync(path.join(logs, 'schematics-generic-isolation.log'), 'utf8'), /selection executed: --generic-isolation/);
    }
    const guarded = spawnSync('sh', ['ci/run_quality_gate.sh', 'fast'], { cwd: repo, env: { ...baseEnv, NODE_OPTIONS: '--no-warnings' }, encoding: 'utf8' });
    assert.equal(guarded.status, 2);
    assert.match(guarded.stderr, /Refusing test-control environment variable: NODE_OPTIONS/);
});

test('concurrent fixtures mutate only their own copies', { timeout: 15000 }, async t => {
    const dir = fixture(t), original = path.join(dir, 'original'), a = path.join(dir, 'a'), b = path.join(dir, 'b');
    mkdirSync(original); writeFileSync(path.join(original, 'asset'), 'original');
    cpSync(original, a, { recursive: true }); cpSync(original, b, { recursive: true });
    const first = { ...check('isolate-a', dir), cwd: a };
    const second = { ...check('isolate-b', dir), cwd: b };
    const run = await runChecks([first, second], { jobs: 2, logs: dir });
    assert.equal(resultStatus(run), 0);
    assert.equal(readFileSync(path.join(original, 'asset'), 'utf8'), 'original');
    assert.equal(readFileSync(path.join(a, 'asset'), 'utf8'), 'isolate-a');
    assert.equal(readFileSync(path.join(b, 'asset'), 'utf8'), 'isolate-b');
});

test('workers overlap only independent checks and continue after failure', { timeout: 15000 }, async t => {
    const dir = fixture(t), starts = [], results = [];
    const checks = [check('barrier-a', dir), check('barrier-b', dir), check('failure', dir, 'shared'), check('after', dir, 'shared')];
    const run = await runChecks(checks, { jobs: 2, logs: dir, onStart: name => starts.push(name), onResult: item => results.push(item) });
    assert.deepEqual(run.results.map(item => item.code), [0, 0, 9, 0]);
    assert.equal(resultStatus(run), 1);
    assert.equal(resultStatus({ results: [{ code: 0 }] }), 0);
    assert.ok(starts.includes('after'));
    assert.ok(results.findIndex(item => item.name === 'failure') < results.findIndex(item => item.name === 'after'));
    assert.equal(statSync(path.join(dir, 'failure.log')).mode & 0o777, 0o600);
});

test('three workers overlap independent checks while grouped failures do not stop pending checks', { timeout: 15000 }, async t => {
    const dir = fixture(t), starts = [], results = [];
    const checks = ['triple-a', 'triple-b', 'triple-c'].map(name => check(name, dir));
    checks.push(check('failure', dir, 'shared'), check('after', dir, 'shared'));
    const run = await runChecks(checks, { jobs: 3, logs: dir, onStart: name => starts.push(name), onResult: item => results.push(item) });
    assert.deepEqual(starts.slice(0, 3), ['triple-a', 'triple-b', 'triple-c']);
    assert.deepEqual(run.results.map(item => item.code), [0, 0, 0, 9, 0]);
    assert.equal(resultStatus(run), 1);
    assert.ok(results.findIndex(item => item.name === 'failure') < results.findIndex(item => item.name === 'after'));
});

test('a log creation failure does not abandon other workers', { timeout: 15000 }, async t => {
    const dir = fixture(t);
    writeFileSync(path.join(dir, 'failure.log'), 'occupied');
    const run = await runChecks([check('barrier-a', dir), check('failure', dir), check('barrier-b', dir), check('after', dir)], { jobs: 2, logs: dir });
    assert.deepEqual(run.results.map(item => item.code), [0, 1, 0, 0]);
    assert.match(run.results[1].error, /EEXIST/);
    assert.equal(resultStatus(run), 1);
});

for (const mode of ['empty', 'live-descendant']) test(`leader exits with ${mode}: only an anchored supervisor signals its own group`, { timeout: 10000, skip: process.platform !== 'linux' }, async t => {
    const dir = fixture(t), calls = [], originalKill = process.kill;
    const script = path.join(root, 'test/fixtures/quality-gate/leader-exit.mjs');
    let run;
    // Suppress and record every scheduler signal, including the old stale-PGID
    // path; never pass a numeric target from this test to the OS.
    process.kill = (...args) => { calls.push(args); return true; };
    try {
        run = await runChecks([{ name: 'leader-exit', command: process.execPath, args: [script, mode, dir], cwd: root }], { jobs: 1, logs: dir });
    } finally { process.kill = originalKill; }
    assert.deepEqual(calls, []);
    assert.equal(resultStatus(run), 0, JSON.stringify(run));
    const { pid, group } = JSON.parse(readFileSync(path.join(dir, 'leader'), 'utf8'));
    assert.notEqual(pid, group);
    const log = readFileSync(path.join(dir, 'leader-exit.log'), 'utf8');
    assert.match(log, new RegExp(`Signalling owned group ${group} with SIGKILL`));
    if (mode === 'live-descendant') {
        const descendant = Number(readFileSync(path.join(dir, 'descendant'), 'utf8'));
        for (let i = 0; i < 200; i++) {
            const statFile = `/proc/${descendant}/stat`;
            if (!existsSync(statFile) || readFileSync(statFile, 'utf8').split(' ')[2] === 'Z') return;
            await delay(10);
        }
        assert.fail('descendant survived group cleanup');
    }
});

for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]]) for (const mode of ['wait-empty', 'wait-descendant']) test(`${signal} after ${mode} never signals a stored group ID`, { timeout: 10000, skip: process.platform !== 'linux' }, async t => {
    const dir = fixture(t), calls = [], originalKill = process.kill;
    const script = path.join(root, 'test/fixtures/quality-gate/leader-exit.mjs');
    process.kill = (...args) => { calls.push(args); return true; };
    try {
        const pending = runChecks([{ name: 'interrupted-leader', command: process.execPath, args: [script, mode, dir], cwd: root }], { jobs: 1, logs: dir });
        await waitFor(path.join(dir, 'ready'));
        process.emit(signal);
        const run = await pending;
        assert.equal(resultStatus(run), status);
        assert.deepEqual(calls, []);
        assert.equal(readFileSync(path.join(dir, 'signal'), 'utf8'), signal);
        const { group } = JSON.parse(readFileSync(path.join(dir, 'leader'), 'utf8'));
        const log = readFileSync(path.join(dir, 'interrupted-leader.log'), 'utf8');
        assert.match(log, new RegExp(`Signalling owned group ${group} with ${signal}`));
        assert.match(log, new RegExp(`Signalling owned group ${group} with SIGKILL`));
        if (mode === 'wait-descendant') {
            const descendant = Number(readFileSync(path.join(dir, 'descendant'), 'utf8'));
            for (let i = 0; i < 200; i++) {
                const statFile = `/proc/${descendant}/stat`;
                if (!existsSync(statFile) || readFileSync(statFile, 'utf8').split(' ')[2] === 'Z') return;
                await delay(10);
            }
            assert.fail('descendant survived interrupted cleanup');
        }
    } finally { process.kill = originalKill; }
});

test('live runner surfaces cleanup failure', t => {
    const dir = fixture(t);
    const fake = path.join(root, 'test/fixtures/quality-gate/cleanup-failure');
    const result = spawnSync('sh', ['ci/run_schematics.sh'], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, TMPDIR: dir } });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /up --build/);
    assert.match(result.stdout, /down --rmi local -v --remove-orphans/);
    assert.match(result.stderr, /Cleanup failed for Compose project/);
});

test('snapshot preserves changed and untracked files, excludes ignored data and rejects symlinks', t => {
    const dir = fixture(t), source = path.join(dir, 'source'), dest = path.join(dir, 'dest');
    mkdirSync(source); mkdirSync(dest);
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: source }).status, 0);
    writeFileSync(path.join(source, '.gitignore'), 'secret\npackage-lock.json\n');
    writeFileSync(path.join(source, 'tracked'), 'changed');
    assert.equal(spawnSync('git', ['add', '.gitignore', 'tracked'], { cwd: source }).status, 0);
    writeFileSync(path.join(source, 'tracked'), 'working tree');
    writeFileSync(path.join(source, 'new'), 'untracked');
    chmodSync(path.join(source, 'new'), 0o755);
    writeFileSync(path.join(source, 'secret'), 'private');
    writeFileSync(path.join(source, 'package-lock.json'), 'local lock');
    snapshot(source, dest);
    assert.equal(readFileSync(path.join(dest, 'tracked'), 'utf8'), 'working tree');
    assert.equal(readFileSync(path.join(dest, 'new'), 'utf8'), 'untracked');
    assert.equal(statSync(path.join(dest, 'new')).mode & 0o777, 0o755);
    assert.equal(existsSync(path.join(dest, 'secret')), false);
    assert.equal(readFileSync(path.join(dest, 'package-lock.json'), 'utf8'), 'local lock');
    symlinkSync('tracked', path.join(source, 'link'));
    assert.throws(() => snapshot(source, dest), /symlink/);
    rmSync(path.join(source, 'link'));
    rmSync(path.join(source, 'package-lock.json'));
    symlinkSync('tracked', path.join(source, 'package-lock.json'));
    assert.throws(() => snapshot(source, dest), /package-lock.json must be a regular file/);
});

test('snapshot entrypoint retains the source index and refuses nonempty or in-tree destinations', t => {
    const dir = fixture(t), source = path.join(dir, 'source'), dest = path.join(dir, 'dest');
    mkdirSync(source); mkdirSync(dest);
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: source }).status, 0);
    writeFileSync(path.join(source, 'tracked'), 'staged');
    assert.equal(spawnSync('git', ['add', 'tracked'], { cwd: source }).status, 0);
    writeFileSync(path.join(source, 'tracked'), 'unstaged');
    writeFileSync(path.join(source, 'untracked'), 'new');
    const index = readFileSync(path.join(source, '.git/index'));
    const script = path.join(root, 'ci/snapshot_checkout.mjs');
    const run = target => spawnSync(process.execPath, [script, target], { cwd: source, encoding: 'utf8' });
    assert.equal(run(dest).status, 0);
    assert.deepEqual(readFileSync(path.join(source, '.git/index')), index);
    assert.equal(readFileSync(path.join(dest, 'tracked'), 'utf8'), 'unstaged');
    assert.equal(readFileSync(path.join(dest, 'untracked'), 'utf8'), 'new');
    assert.notEqual(run(dest).status, 0);
    mkdirSync(path.join(source, 'nested'));
    assert.notEqual(run(path.join(source, 'nested')).status, 0);
});

for (const [signal, status] of [['SIGTERM', 143], ['SIGINT', 130]]) for (const jobs of [1, 3]) test(`${signal} reaches all ${jobs} workers' descendants and prevents pending checks`, { timeout: 15000, skip: process.platform === 'win32' }, async t => {
    const dir = fixture(t);
    const workers = Array.from({ length: jobs }, (_, i) => jobs === 1 ? dir : path.join(dir, `worker-${i}`));
    if (jobs > 1) for (const worker of workers) mkdirSync(worker);
    const child = spawn(process.execPath, [harness, dir, String(jobs)], { stdio: 'ignore' });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    for (const worker of workers) await waitFor(path.join(worker, 'descendant-ready'));
    child.kill(signal);
    assert.deepEqual(await closed, { code: status, signal: null });
    for (const worker of workers) await waitFor(path.join(worker, 'descendant-stopped'));
    assert.equal(existsSync(path.join(dir, 'after.log')), false);
});

test('termination during workspace setup removes the private workspace', { timeout: 15000, skip: process.platform === 'win32' }, async t => {
    const dir = fixture(t), repo = path.join(dir, 'repo'), tmp = path.join(dir, 'tmp');
    mkdirSync(path.join(repo, 'ci'), { recursive: true }); mkdirSync(path.join(repo, 'test')); mkdirSync(tmp);
    copyFileSync(path.join(root, 'ci/run_quality_gate.sh'), path.join(repo, 'ci/run_quality_gate.sh'));
    copyFileSync(path.join(root, 'ci/quality_gate.mjs'), path.join(repo, 'ci/quality_gate.mjs'));
    for (let i = 0; i < 500; i++) writeFileSync(path.join(repo, 'test', `data-${i}`), 'fixture');
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
    const env = { ...process.env, TMPDIR: tmp }; delete env.NODE_TEST_CONTEXT;
    const child = spawn('sh', ['ci/run_quality_gate.sh', 'fast'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let output = '', signalled = false;
    child.stdout.on('data', data => { output += data; if (!signalled && output.includes('Private logs:')) { signalled = true; child.kill('SIGTERM'); } });
    const closed = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(signalled, true);
    assert.deepEqual(closed, { code: 143, signal: null });
    assert.equal(readdirSync(tmp).some(name => name.startsWith('mindcraft-quality-work-')), false);
});
