import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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
    assert.match(result.stdout, /Verified mineflayer 4\.39\.0 digging patch/);
    assert.match(result.stdout, /Verified Minecraft 1\.21\.6 unsigned chat checksums/);
});

test('postinstall verifier rejects signed or missing 1.21.6 chat checksums', (t) => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mindcraft-protocol-check-'));
    t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
    const packageDir = join(tempRoot, 'node_modules/minecraft-data');
    mkdirSync(packageDir, { recursive: true });
    const env = { ...process.env, NODE_PATH: join(projectRoot, 'node_modules') };
    for (const [packet, fields] of [
        ['packet_chat_command_signed', [{ name: 'checksum', type: 'i8' }]],
        ['packet_chat_message', []],
    ]) {
        const types = {
            packet_chat_command_signed: ['container', [{ name: 'checksum', type: 'u8' }]],
            packet_chat_message: ['container', [{ name: 'checksum', type: 'u8' }]],
        };
        types[packet] = ['container', fields];
        const data = { version: { minecraftVersion: '1.21.6' }, protocol: { play: { toServer: { types } } } };
        writeFileSync(join(packageDir, 'index.js'), `module.exports = () => (${JSON.stringify(data)});\n`);
        const result = runNode([verifier], { cwd: tempRoot, env });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, new RegExp(`${packet} checksum must be unsigned u8`));
    }
});

test('Minecraft 1.21.6 chat packets round-trip the full unsigned checksum range', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const protocol = require('minecraft-protocol');
    const options = { state: 'play', version: '1.21.6' };
    const serializer = protocol.createSerializer({ ...options, isServer: false });
    const parser = protocol.createDeserializer({ ...options, isServer: true });
    for (const checksum of [0, 127, 128, 255]) {
        const common = { timestamp: 0n, salt: 0n, acknowledged: Buffer.alloc(3), checksum };
        const packets = [
            ['chat_message', { ...common, message: 'hello', signature: null, offset: 0 }],
            ['chat_command_signed', { ...common, command: 'test', argumentSignatures: [], messageCount: 0 }],
        ];
        for (const [name, params] of packets) {
            const buffer = serializer.createPacketBuffer({ name, params });
            const decoded = parser.parsePacketBuffer(buffer).data;
            assert.equal(decoded.name, name);
            assert.equal(decoded.params.checksum, checksum);
        }
    }
});

test('postinstall verifier rejects an unpatched Mineflayer even with the schematic patch present', (t) => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'mindcraft-mineflayer-unpatched-'));
    t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
    const packageDir = join(tempRoot, 'node_modules/mineflayer');
    mkdirSync(join(packageDir, 'lib/plugins'), { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), '{"name":"mineflayer","version":"4.39.0"}');
    writeFileSync(join(packageDir, 'lib/plugins/digging.js'), '// unpatched\n');
    const env = { ...process.env, NODE_PATH: join(projectRoot, 'node_modules'), CI: 'true' };
    const result = runNode([verifier], { cwd: tempRoot, env });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Verified mineflayer-schem/);
    assert.match(result.stderr, /patched digging implementation does not match/);
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
    assert.match(installCheck.stderr, /Patch verification failed:.*cancellation-safety/s);

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
