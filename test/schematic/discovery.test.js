import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { discoverSchematicTests, selectSchematicTests } from '../run_schematic_tests.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const runner = path.join(projectRoot, 'test/run_schematic_tests.mjs');

test('fixed schematic selections are disjoint and exhaustive', () => {
    const files = discoverSchematicTests(path.join(projectRoot, 'test/schematic'));
    const generic = selectSchematicTests(files, 'generic-isolation');
    const other = selectSchematicTests(files, 'other');
    assert.equal(generic.length, 1);
    assert.deepEqual([...generic, ...other].sort(), files);
    assert.throws(() => selectSchematicTests(other, 'generic-isolation'));
    assert.throws(() => selectSchematicTests(files, 'unknown'));
});

function fixture(t) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'schematic discovery '));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const tests = path.join(root, 'test', 'schematic');
    mkdirSync(tests, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    copyFileSync(runner, path.join(root, 'test', 'run_schematic_tests.mjs'));
    return { root, tests, runner: path.join(root, 'test', 'run_schematic_tests.mjs'), log: path.join(root, 'log') };
}

function writeFixture(fx, name, body = '') {
    const file = path.join(fx.tests, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `const { appendFileSync } = require('node:fs');\nappendFileSync(process.env.DISCOVERY_LOG, ${JSON.stringify(name + '\n')});\nconst test = require('node:test');\ntest('fixture', () => { ${body} });\n`);
}

function fixtureEnv(fx) {
    const env = { ...process.env, DISCOVERY_LOG: fx.log };
    delete env.NODE_TEST_CONTEXT;
    return env;
}

function invoke(fx) {
    return spawnSync(process.execPath, [fx.runner], {
        cwd: os.tmpdir(),
        encoding: 'utf8',
        env: fixtureEnv(fx),
        timeout: 30000,
    });
}

test('discovers and runs sorted nested pack tests once, excluding helpers and symlinks', t => {
    const fx = fixture(t);
    const names = ['pack3/z.test.js', 'pack1/nested/b.test.js', 'pack2/a.test.js', 'pack1/a.test.js', 'top.test.js', 'pack2/space ; literal.test.js'];
    for (const name of names) writeFixture(fx, name);
    writeFixture(fx, 'pack1/helper.js', "throw new Error('helper executed');");
    writeFixture(fx, 'pack3/not.test.js.bak', "throw new Error('helper executed');");
    if (process.platform !== 'win32') {
        symlinkSync(fx.tests, path.join(fx.tests, 'pack1', 'cycle'));
        symlinkSync(path.join(fx.tests, 'top.test.js'), path.join(fx.tests, 'alias.test.js'));
    }
    const expected = names.map(name => path.join(fx.tests, name)).sort();
    assert.deepEqual(discoverSchematicTests(fx.tests), expected);
    assert.deepEqual(discoverSchematicTests(fx.tests), expected);
    const result = invoke(fx);
    assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
    assert.deepEqual(readFileSync(fx.log, 'utf8').trimEnd().split('\n'), expected.map(name => path.relative(fx.tests, name).split(path.sep).join('/')));
    const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['test:schematic'], 'node test/run_schematic_tests.mjs');
});

test('propagates a failing test and rejects an empty discovery', t => {
    const fx = fixture(t);
    const empty = invoke(fx);
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /No schematic tests found/);
    writeFixture(fx, 'pack2/failure.test.js', "throw new Error('expected fixture failure');");
    const failed = invoke(fx);
    assert.equal(failed.status, 1, failed.error || failed.stderr || failed.stdout);
    assert.match(failed.stdout, /expected fixture failure/);
    const nested = spawnSync(process.execPath, [fx.runner], {
        cwd: os.tmpdir(), encoding: 'utf8', env: { ...fixtureEnv(fx), NODE_TEST_CONTEXT: 'child-v8' },
    });
    assert.equal(nested.status, 1);
    assert.match(nested.stderr, /Cannot run the schematic suite recursively/);
});

test('forwards termination and preserves signal status', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
    const fx = fixture(t);
    const file = path.join(fx.tests, 'pack3', 'wait.test.js');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "require('node:fs').writeFileSync(process.env.DISCOVERY_LOG, 'ready');\nrequire('node:test')('wait', () => new Promise(() => {}));\nsetInterval(() => {}, 1000);\n");
    const child = spawn(process.execPath, [fx.runner], {
        cwd: os.tmpdir(), stdio: 'ignore', env: fixtureEnv(fx),
    });
    const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    for (let i = 0; i < 100 && !existsSync(fx.log); i++) await delay(50);
    assert.ok(existsSync(fx.log), 'fixture did not start');
    child.kill('SIGTERM');
    assert.deepEqual(await closed, { code: null, signal: 'SIGTERM' });
});
