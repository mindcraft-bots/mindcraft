import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const [mode, dir] = process.argv.slice(2);
if (mode === 'descendant') {
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {});
    writeFileSync(path.join(dir, 'descendant'), String(process.pid));
    // Safety bound even if a regression stops cleaning up the fixture.
    await delay(5000);
} else {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const group = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
    writeFileSync(path.join(dir, 'leader'), JSON.stringify({ pid: process.pid, group }));
    if (mode === 'live-descendant' || mode === 'wait-descendant') {
        const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'descendant', dir], { stdio: 'ignore' });
        child.unref();
        while (!existsSync(path.join(dir, 'descendant'))) await delay(10);
    }
    if (mode.startsWith('wait-')) {
        await new Promise(resolve => {
            const timer = setTimeout(resolve, 5000);
            const finish = signal => { clearTimeout(timer); writeFileSync(path.join(dir, 'signal'), signal); resolve(); };
            process.once('SIGINT', () => finish('SIGINT'));
            process.once('SIGTERM', () => finish('SIGTERM'));
            writeFileSync(path.join(dir, 'ready'), 'ready');
        });
    }
}
