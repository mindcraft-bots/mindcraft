import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const [config, name, dir] = process.argv.slice(2);
const item = JSON.parse(readFileSync(config, 'utf8'))[name];
if (!item) throw new Error('Unknown fixture case');
if (item.action === 'barrier' || item.action === 'isolate') {
    if (item.action === 'isolate') writeFileSync(path.join(process.cwd(), 'asset'), name);
    writeFileSync(path.join(dir, name), 'ready');
    const peers = item.peers || [item.peer];
    const ready = () => peers.every(peer => existsSync(path.join(dir, peer)));
    for (let i = 0; i < 200 && !ready(); i++) await delay(25);
    if (!ready()) throw new Error('Barrier timeout');
    if (item.action === 'isolate' && readFileSync(path.join(process.cwd(), 'asset'), 'utf8') !== name) throw new Error('Fixture copies interfered');
} else if (item.action === 'exit') {
    process.exitCode = item.code;
} else if (item.action === 'parent') {
    spawn(process.execPath, [fileURLToPath(import.meta.url), config, 'descendant', dir], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
} else if (item.action === 'descendant') {
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { writeFileSync(path.join(dir, 'descendant-stopped'), 'done'); process.exit(0); });
    writeFileSync(path.join(dir, 'descendant-ready'), 'ready');
    setInterval(() => {}, 1000);
} else throw new Error('Unknown fixture action');
