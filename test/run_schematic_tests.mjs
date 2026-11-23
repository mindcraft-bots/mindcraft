import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function discoverSchematicTests(root) {
    const files = [];
    function visit(directory) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const name = path.join(directory, entry.name);
            // Do not follow symlinks: they can alias tests or form directory cycles.
            if (entry.isDirectory()) visit(name);
            else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(name);
        }
    }
    visit(path.resolve(root));
    return files.sort();
}

export function runSchematicTests(root = path.join(projectRoot, 'test', 'schematic')) {
    if (process.env.NODE_TEST_CONTEXT) {
        throw new Error('Cannot run the schematic suite recursively from a Node test');
    }
    const files = discoverSchematicTests(root);
    if (files.length === 0) throw new Error(`No schematic tests found under ${root}`);

    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
            cwd: projectRoot,
            stdio: 'inherit',
        });
        let receivedSignal;
        const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
            receivedSignal ||= signal;
            child.kill(signal);
        }]));
        for (const [signal, handler] of handlers) process.on(signal, handler);
        const cleanup = () => {
            for (const [signal, handler] of handlers) process.removeListener(signal, handler);
        };
        child.once('error', error => {
            cleanup();
            reject(error);
        });
        child.once('close', (code, signal) => {
            cleanup();
            resolve({ code, signal: receivedSignal || signal });
        });
    });
}

async function main() {
    try {
        const { code, signal } = await runSchematicTests();
        if (signal) {
            // Preserve signal termination for callers; use the conventional code as a fallback.
            process.exitCode = 128 + (constants.signals[signal] || 1);
            process.kill(process.pid, signal);
        } else {
            process.exitCode = code ?? 1;
        }
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    await main();
}
