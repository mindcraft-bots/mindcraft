import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const verifier = join(projectRoot, 'scripts/verify_patch.js');

function runNode(args, { cwd = projectRoot, env = process.env } = {}) {
    return spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8' });
}

test('postinstall verifier accepts the patched installed package', () => {
    const result = runNode([verifier]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Verified mineflayer-schem cancellation-safety patch/);
});

test('patch verifier is directly executable', () => {
    const result = spawnSync(verifier, [], { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.error || result.stderr || result.stdout);
    assert.match(result.stdout, /Verified mineflayer-schem cancellation-safety patch/);
});

test('runtime loader accepts the patched plugin capability', () => {
    const loaderUrl = pathToFileURL(join(projectRoot, 'src/utils/schematic/builder_compat.js')).href;
    const result = runNode([
        '--input-type=module',
        '--eval',
        `import assert from 'node:assert/strict';
         const { loadSchematicBuilder } = await import(${JSON.stringify(loaderUrl)});
         let registrations = 0;
         assert.doesNotThrow(() => loadSchematicBuilder({ loadPlugin() { registrations += 1; } }));
         assert.equal(registrations, 1);`,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('an unpatched package fails install verification and runtime loading before plugin registration', (t) => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mindcraft-schem-unpatched-'));
    t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
    const packageDir = join(tempRoot, 'node_modules/mineflayer-schem');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), '{"name":"mineflayer-schem","main":"index.js"}');
    writeFileSync(join(packageDir, 'index.js'), 'module.exports = { builder() {} };\n');

    const env = {
        ...process.env,
        NODE_PATH: [join(tempRoot, 'node_modules'), join(projectRoot, 'node_modules')].join(delimiter),
    };
    const installCheck = runNode([verifier], { cwd: tempRoot, env });
    assert.notEqual(installCheck.status, 0);
    assert.match(installCheck.stderr, /cancellation-safety patch verification failed/);

    const loaderUrl = pathToFileURL(join(projectRoot, 'src/utils/schematic/builder_compat.js')).href;
    const stubPath = join(packageDir, 'index.js');
    const loaderCheck = runNode([
        '--input-type=module',
        '--eval',
        `import assert from 'node:assert/strict';
         import Module from 'node:module';
         const originalResolveFilename = Module._resolveFilename;
         Module._resolveFilename = function resolveFilename(request, ...args) {
             if (request === 'mineflayer-schem') return ${JSON.stringify(stubPath)};
             return originalResolveFilename.call(this, request, ...args);
         };
         const { loadSchematicBuilder } = await import(${JSON.stringify(loaderUrl)});
         let registrations = 0;
         assert.throws(
             () => loadSchematicBuilder({ loadPlugin() { registrations += 1; } }),
             /cancellation-safety patch is missing or incompatible.*npm install/s,
         );
         assert.equal(registrations, 0);`,
    ], { cwd: tempRoot, env });
    assert.equal(loaderCheck.status, 0, loaderCheck.stderr || loaderCheck.stdout);
});
