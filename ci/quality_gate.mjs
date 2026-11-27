import { spawn, spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, statSync, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync, readFileSync, rmSync, symlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setImmediate as yieldImmediate } from 'node:timers';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: ci/run_quality_gate.sh [fast|full] [--jobs 1|2|3]';

export function parseArgs(args) {
    let mode = 'full', jobs, seenMode = false;
    for (let i = 0; i < args.length; i++) {
        if ((args[i] === 'fast' || args[i] === 'full') && !seenMode) {
            mode = args[i]; seenMode = true;
        } else if (args[i] === '--jobs' && jobs === undefined && /^[123]$/.test(args[i + 1] || '')) {
            jobs = Number(args[++i]);
        } else throw new Error(usage);
    }
    return { mode, jobs: jobs ?? defaultJobs() };
}

export function recommendedJobs(cpus, memory, free) {
    if (cpus >= 12 && memory >= 48 * 1024 ** 3 && free >= 16 * 1024 ** 3) return 3;
    return cpus >= 2 && memory >= 6 * 1024 ** 3 ? 2 : 1;
}

// Linux availableParallelism uses sched_getaffinity, which includes the effective
// cpuset. Quotas are independent of affinity and must be bounded at every level.
// The reader and affinity are explicit arguments for fixtures, never CLI/env input.
export function cpuCapacity({ platform, affinity, read }) {
    if (!Number.isSafeInteger(affinity) || affinity < 1 || platform !== 'linux') return 1;
    try {
        const memberships = read('/proc/self/cgroup').trim().split('\n').map(line => {
            const match = /^(\d+):([^:]*):(\/[^\n]*)$/.exec(line);
            if (!match) throw new Error('Invalid cgroup membership');
            const parts = match[3].split('/').slice(1);
            if (parts.some(part => part === '.' || part === '..' || (!part && parts.length > 1))) throw new Error('Invalid cgroup path');
            return { controllers: match[2].split(','), group: match[3] };
        });
        const v1 = memberships.filter(item => item.controllers.includes('cpu'));
        const v2 = memberships.filter(item => item.controllers.length === 1 && item.controllers[0] === '');
        const version = v1.length ? 1 : 2;
        const selected = version === 1 ? v1 : v2;
        if (selected.length !== 1) throw new Error('Ambiguous CPU cgroup');
        const mounts = read('/proc/self/mountinfo').trim().split('\n').flatMap(line => {
            const [left, right] = line.split(' - ');
            if (!left || !right) throw new Error('Invalid mountinfo');
            const before = left.split(' '), after = right.split(' ');
            if (before.length < 6 || after.length < 3) throw new Error('Invalid mountinfo');
            if (after[0] !== (version === 1 ? 'cgroup' : 'cgroup2')) return [];
            if (version === 1 && !after[2].split(',').includes('cpu')) return [];
            const unescape = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
            return [{ root: unescape(before[3]), mount: unescape(before[4]) }];
        });
        // A subtree mount can hide more restrictive ancestors. Multiple mounts
        // are ambiguous, so do not infer an optimistic limit from either one.
        if (mounts.length !== 1 || mounts[0].root !== '/' || !path.isAbsolute(mounts[0].mount)) throw new Error('Incomplete CPU hierarchy');
        const mount = path.resolve(mounts[0].mount);
        let dir = path.resolve(path.join(mount, selected[0].group));
        if (dir !== mount && !dir.startsWith(`${mount}/`)) throw new Error('Invalid cgroup mount path');
        let cpus = affinity;
        const positive = value => {
            if (!/^[1-9]\d*$/.test(value)) throw new Error('Invalid quota value');
            const number = Number(value);
            if (!Number.isSafeInteger(number)) throw new Error('Invalid quota value');
            return number;
        };
        for (;;) {
            let quota, period;
            if (version === 2) {
                const values = read(path.join(dir, 'cpu.max')).trim().split(/\s+/);
                if (values.length !== 2) throw new Error('Invalid cpu.max');
                [quota, period] = values;
            } else {
                quota = read(path.join(dir, 'cpu.cfs_quota_us')).trim();
                period = read(path.join(dir, 'cpu.cfs_period_us')).trim();
            }
            const interval = positive(period);
            if (quota !== (version === 2 ? 'max' : '-1')) cpus = Math.min(cpus, Math.max(1, Math.floor(positive(quota) / interval)));
            if (dir === mount) break;
            dir = path.dirname(dir);
        }
        return cpus;
    } catch {
        // Missing, malformed, inaccessible or obscured bounds must not select
        // parallel workers on the strength of host CPU count alone.
        return 1;
    }
}

function defaultJobs() {
    let memory = os.totalmem();
    let free = os.freemem();
    const cpus = cpuCapacity({ platform: process.platform, affinity: os.availableParallelism(), read: file => readFileSync(file, 'utf8') });
    try {
        const limit = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
        if (/^\d+$/.test(limit)) {
            memory = Math.min(memory, Number(limit));
            const hostFree = free;
            free = 0; // Unknown cgroup usage must not select the three-worker default.
            const used = readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim();
            if (/^\d+$/.test(used)) free = Math.min(hostFree, Math.max(0, Number(limit) - Number(used)));
        }
    } catch { /* Not cgroup v2. */ }
    try {
        const limit = Number(readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim());
        if (limit > 0 && limit < os.totalmem()) {
            memory = Math.min(memory, limit);
            const hostFree = free;
            free = 0;
            const used = readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim();
            if (/^\d+$/.test(used)) free = Math.min(hostFree, Math.max(0, limit - Number(used)));
        }
    } catch { /* Not cgroup v1. */ }
    return recommendedJobs(cpus, memory, free);
}

// Only tracked and non-ignored untracked files participate; never traverse checkout symlinks.
export function snapshot(source, destination, { copyIgnoredLock = true } = {}) {
    const git = args => spawnSync('git', args, { cwd: source, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    // Git can silently ignore an unreadable excludes file. Validate the
    // effective configured path separately rather than trusting ls-files alone.
    const config = git(['config', '--includes', '--path', '--get', '-z', 'core.excludesfile']);
    if (config.error || ![0, 1].includes(config.status) || config.stderr.length) throw new Error('Cannot determine Git ignore policy');
    const checkIgnoreFile = (file, required = false) => {
        try {
            if (file !== os.devNull && !statSync(file).isFile()) throw new Error('Not a regular file');
            readFileSync(file);
        } catch (error) {
            if (!required && error.code === 'ENOENT') return;
            throw new Error('Cannot read Git ignore policy');
        }
    };
    if (config.status === 0) {
        const value = config.stdout.toString('utf8');
        if (!value.endsWith('\0') || value.slice(0, -1).includes('\0')) throw new Error('Cannot determine Git ignore policy');
        checkIgnoreFile(path.resolve(source, value.slice(0, -1)), true);
    } else {
        const configHome = process.env.XDG_CONFIG_HOME || (process.env.HOME && path.join(process.env.HOME, '.config'));
        if (!configHome) throw new Error('Cannot determine Git global ignore policy');
        checkIgnoreFile(path.join(configHome, 'git', 'ignore'));
    }
    const info = git(['rev-parse', '--git-path', 'info/exclude']);
    if (info.error || info.status !== 0 || info.stderr.length || !info.stdout.toString('utf8').endsWith('\n')) throw new Error('Cannot determine Git info exclude path');
    checkIgnoreFile(path.resolve(source, info.stdout.toString('utf8').slice(0, -1)));
    const enumerate = () => {
        const listing = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
        if (listing.status !== 0 || listing.error || listing.stderr.length) throw new Error('Cannot enumerate checkout with git ls-files');
        const text = listing.stdout.toString('utf8');
        if (!Buffer.from(text).equals(listing.stdout) || (text && !text.endsWith('\0'))) throw new Error('Cannot safely decode Git paths');
        return [...new Set(text.split('\0').filter(Boolean))].sort();
    };
    const names = enumerate();
    const ignoreDirs = new Set(['']);
    for (const name of names) {
        let dir = path.dirname(name);
        while (dir !== '.') { ignoreDirs.add(dir); dir = path.dirname(dir); }
    }
    for (const dir of ignoreDirs) checkIgnoreFile(path.join(source, dir, '.gitignore'));
    const directories = new Map();
    const copied = [];
    const absent = [];
    for (const name of names) {
        const parts = name.split('/');
        if (parts.some(part => !part || part === '.' || part === '..' || part === '.git' || part === 'node_modules')) throw new Error(`Unsafe checkout path: ${name}`);
        let current = source;
        for (const part of parts) {
            current = path.join(current, part);
            let stat;
            try { stat = lstatSync(current); } catch (error) {
                if (error.code === 'ENOENT') { current = null; break; }
                throw error;
            }
            if (stat.isSymbolicLink()) throw new Error(`Checkout symlink is not supported: ${name}`);
            if (stat.isDirectory()) directories.set(path.relative(source, current), stat.mode & 0o777);
        }
        if (!current) {
            absent.push(path.join(source, name)); // A tracked deletion is part of the current tree.
            continue;
        }
        if (!lstatSync(current).isFile()) throw new Error(`Not a regular file: ${name}`);
        const target = path.join(destination, name);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(current, target);
        chmodSync(target, lstatSync(current).mode & 0o777);
        copied.push([current, target]);
    }
    // Existing host tests inspect the developer's lockfile. Copy it, never modify it
    // or substitute the CI lock when it is absent.
    const lock = path.join(source, 'package-lock.json');
    let stat;
    try { stat = lstatSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (copyIgnoredLock && stat) {
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('package-lock.json must be a regular file');
        copyFileSync(lock, path.join(destination, 'package-lock.json'));
        copied.push([lock, path.join(destination, 'package-lock.json')]);
    } else if (!stat) absent.push(lock);
    if (JSON.stringify(names) !== JSON.stringify(enumerate())) throw new Error('Checkout changed during snapshot');
    for (const original of absent) {
        try {
            lstatSync(original);
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        throw new Error(`Checkout changed during snapshot: ${original}`);
    }
    for (const [original, copy] of copied) {
        const current = lstatSync(original), saved = lstatSync(copy);
        if (!current.isFile() || current.isSymbolicLink() || !readFileSync(original).equals(readFileSync(copy)) ||
            (original !== lock && (current.mode & 0o777) !== (saved.mode & 0o777))) {
            throw new Error(`Checkout changed during snapshot: ${original}`);
        }
    }
    // The enclosing workspace is private; preserving inner modes keeps Docker's
    // content-addressed dependency layers reusable across checkout and snapshots.
    for (const [directory, mode] of [...directories].sort((a, b) => b[0].length - a[0].length)) {
        const target = path.join(destination, directory);
        if (existsSync(target)) chmodSync(target, mode);
    }
}

export function productionChecks(mode, source, offline, rootCopy, live, generic) {
    if (mode !== 'fast' && mode !== 'full') throw new Error('Invalid gate mode');
    const rootTests = readdirSync(path.join(rootCopy, 'test')).filter(name => name.endsWith('.test.js')).sort().map(name => path.join('test', name));
    if (!rootTests.length) throw new Error('No root tests found');
    return [
        ...(mode === 'full' ? [{ name: 'schematics-live', command: 'sh', args: ['ci/run_schematics.sh'], cwd: live }] : []),
        { name: 'schematics-tests', command: process.execPath, args: ['test/run_schematic_tests.mjs', '--other'], cwd: offline },
        { name: 'schematics-generic-isolation', command: process.execPath, args: ['test/run_schematic_tests.mjs', '--generic-isolation'], cwd: generic },
        { name: 'diff-check', command: 'git', args: ['diff', '--check'], cwd: source },
        { name: 'patches', command: process.execPath, args: ['scripts/verify_patch.js'], cwd: rootCopy, group: 'root' },
        { name: 'root-tests', command: process.execPath, args: ['--test', ...rootTests], cwd: rootCopy, group: 'root' },
    ];
}

export function resultStatus(result) {
    if (result.interrupted) return result.interrupted === 'SIGINT' ? 130 : 143;
    return result.error || result.results.some(item => item && (item.code !== 0 || item.signal)) ? 1 : 0;
}

// Executed in a new session. Only this live session/group leader signals its
// own group: its PID cannot be recycled while it is executing the syscall.
// The scheduler never signals a saved numeric PID or PGID.
export function superviseCheck() {
    let started = false, stopping = false, finished = false, childError;
    const log = message => { try { writeSync(2, `[supervisor] ${message}\n`); } catch { /* best effort */ } };
    const killGroup = signal => {
        log(`Signalling owned group ${process.pid} with ${signal}`);
        try { process.kill(-process.pid, signal); }
        catch (error) { log(`Cannot signal owned group: ${error.message}; cleanup may be incomplete`); process.exit(1); }
    };
    const finish = result => {
        if (finished) return;
        finished = true;
        const terminate = () => killGroup('SIGKILL');
        if (process.connected) process.send({ type: 'result', result }, () => terminate());
        else terminate();
    };
    const stop = signal => {
        if (stopping || finished) return;
        stopping = true;
        log(`Forwarding ${signal}; allowing 15 seconds for cleanup`);
        killGroup(signal);
        setTimeout(() => {
            log('Cleanup deadline reached; terminating owned group');
            finish({ code: 1, error: 'Cleanup deadline reached; descendants or resources may remain' });
        }, 15000).unref();
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
    process.on('disconnect', () => stop('SIGTERM'));
    process.on('message', message => {
        if (message.type === 'stop') { stop(message.signal); return; }
        if (message.type !== 'start' || started) return;
        started = true;
        if (stopping) { finish({ code: 1, error: 'Interrupted before check started' }); return; }
        let child;
        try {
            child = spawn(message.command, message.args, { cwd: message.cwd, stdio: ['ignore', 'inherit', 'inherit'] });
        } catch (error) { finish({ code: 1, error: error.message }); return; }
        child.once('error', error => { childError = error.message; log(error.message); });
        child.once('close', (code, signal) => {
            const result = { code: code ?? 1, signal, ...(childError ? { error: childError } : {}) };
            // Allow concurrently signalled descendants to finish their handlers.
            if (stopping) setTimeout(() => finish(result), 250);
            else finish(result);
        });
    });
}

// The injectable check list is for unit tests only; the production CLI constructs a fixed list.
export async function runChecks(checks, { jobs, logs, onStart = () => {}, onResult = () => {} }) {
    let interrupted;
    const pending = checks.map((check, index) => ({ check, index }));
    const groups = new Set(), waiters = new Set();
    const wake = () => { for (const waiter of waiters) waiter(); waiters.clear(); };
    const running = new Set();
    const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
        if (interrupted) return;
        interrupted = signal;
        wake();
        for (const child of running) if (child.connected) child.send({ type: 'stop', signal }, () => {});
    }]));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const results = new Array(checks.length);
    async function worker() {
        while (!interrupted && pending.length) {
            const position = pending.findIndex(({ check }) => !check.group || !groups.has(check.group));
            if (position < 0) { await new Promise(resolve => waiters.add(resolve)); continue; }
            const { check, index } = pending.splice(position, 1)[0], start = performance.now();
            if (check.group) groups.add(check.group);
            let fd, result;
            try {
                onStart(check.name);
                fd = openSync(path.join(logs, `${check.name}.log`), 'wx', 0o600);
                result = await new Promise(resolve => {
                    if (process.platform === 'win32') { resolve({ code: 1, error: 'Safe process-group supervision requires POSIX' }); return; }
                    const script = `import { superviseCheck } from ${JSON.stringify(import.meta.url)}; superviseCheck();`;
                    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { detached: true, stdio: ['ignore', fd, fd, 'ipc'] });
                    let reported, spawnError;
                    running.add(child);
                    child.once('error', error => {
                        spawnError = error.message;
                        try { writeSync(fd, `${error.message}\n`); } catch { /* report below */ }
                    });
                    child.on('message', message => { if (message.type === 'result') reported = message.result; });
                    child.once('close', (_code, signal) => {
                        running.delete(child);
                        resolve(reported && signal === 'SIGKILL' ? reported : {
                            code: 1, error: `${spawnError || 'Supervisor exited unexpectedly'}; descendants or resources may remain`,
                        });
                    });
                    if (child.connected) {
                        child.send({ type: 'start', command: check.command, args: check.args, cwd: check.cwd }, () => {});
                        if (interrupted) child.send({ type: 'stop', signal: interrupted }, () => {});
                    }
                });
            } catch (error) { result = { code: 1, error: error.message }; }
            finally {
                try { if (fd !== undefined) closeSync(fd); }
                catch (error) { result = { code: 1, error: error.message }; }
                if (check.group) groups.delete(check.group);
                wake();
            }
            results[index] = { ...result, name: check.name, seconds: (performance.now() - start) / 1000 };
            try { onResult(results[index]); } catch (error) { results[index] = { ...results[index], code: 1, error: error.message }; }
        }
    }
    let error;
    try {
        const workers = await Promise.allSettled(Array.from({ length: Math.min(jobs, checks.length) }, worker));
        const rejected = workers.find(item => item.status === 'rejected');
        if (rejected) error = rejected.reason?.message || String(rejected.reason);
    }
    finally { for (const [signal, handler] of handlers) process.removeListener(signal, handler); }
    return { results, interrupted, error };
}

async function main() {
    let options;
    try { options = parseArgs(process.argv.slice(2)); }
    catch (error) { console.error(error.message); process.exitCode = 2; return; }
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_TEST_CONTEXT', 'SCHEMATIC_GENERIC_ISOLATION', 'BEE_APPROVAL_COPY', 'MINDCRAFT_SETTINGS_TEST_LOADER', 'MINDCRAFT_TEST_STARTUP_TRUST', 'MINDCRAFT_DESTRUCTIVE_INGRESS_FIXTURE', 'MINDCRAFT_SCHEMATIC_FIXTURE_ROOT', 'MINDCRAFT_REAL_SCHEMATIC_PATHS', 'HISTORY_TEST_PYTHON']) {
        if (process.env[name] !== undefined) {
            console.error(`Refusing test-control environment variable: ${name}`);
            process.exitCode = 2; return;
        }
    }
    process.umask(0o077);
    let logs, workspace, setupSignal;
    const setupHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => { setupSignal ||= signal; }]));
    for (const [signal, handler] of setupHandlers) process.on(signal, handler);
    const yieldSetup = async () => {
        await new Promise(resolve => yieldImmediate(resolve));
        if (setupSignal) throw new Error(`Interrupted by ${setupSignal}`);
    };
    const start = performance.now();
    try {
        logs = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-quality-gate-'));
        workspace = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-quality-work-'));
        console.log(`Private logs: ${logs}\nWorkers: ${options.jobs} (schematic files and live cases remain serial)`);
        if (options.jobs === 3) console.log('Resource warning: three checks can overlap Docker, nested tests and many Node processes; ensure CPU and memory headroom, especially with concurrent gates. Use --jobs 1 or 2 if constrained.');
        await yieldSetup();
        const base = path.join(workspace, 'base'); mkdirSync(base);
        snapshot(root, base);
        await yieldSetup();
        const offline = path.join(workspace, 'offline'), generic = path.join(workspace, 'generic'), rootCopy = path.join(workspace, 'root'), live = path.join(workspace, 'live');
        cpSync(base, offline, { recursive: true }); cpSync(base, generic, { recursive: true }); cpSync(base, rootCopy, { recursive: true });
        if (options.mode === 'full') cpSync(base, live, { recursive: true });
        await yieldSetup();
        const modules = path.join(root, 'node_modules');
        if (existsSync(modules)) for (const copy of [offline, generic, rootCopy]) symlinkSync(modules, path.join(copy, 'node_modules'), 'dir');
        const checks = productionChecks(options.mode, root, offline, rootCopy, live, generic);
        const report = result => console.log(`${result.code === 0 && !result.signal ? 'PASS' : 'FAIL'}: ${result.name} (${result.seconds.toFixed(2)}s${result.code ? `, exit ${result.code}` : ''}${result.signal ? `, ${result.signal}` : ''}${result.error ? `, ${result.error}` : ''})`);
        const pending = runChecks(checks, { jobs: options.jobs, logs, onStart: name => console.log(`START: ${name}`), onResult: report });
        const result = await pending;
        if (result.error) console.error(`Scheduler error: ${result.error}`);
        const status = resultStatus(result), failed = status !== 0;
        if (result.interrupted) {
            console.error(`Interrupted by ${result.interrupted}; logs: ${logs}`);
            process.exitCode = status;
        } else {
            console.log(`Total: ${((performance.now() - start) / 1000).toFixed(2)}s\nLogs: ${logs}`);
            if (options.mode === 'fast') console.log('FAST ONLY: live schematic CI was not run; this is not the mandatory full gate.');
            console.log(failed ? 'Quality gate FAILED.' : options.mode === 'full' ? 'Full quality gate PASSED.' : 'Fast checks PASSED (full gate still required).');
            process.exitCode = status;
        }
    } catch (error) {
        await new Promise(resolve => yieldImmediate(resolve));
        console.error(`${setupSignal ? `Interrupted by ${setupSignal}` : `Quality gate setup failed: ${error.message}`}\nLogs: ${logs || 'not created'}`);
        process.exitCode = setupSignal ? (setupSignal === 'SIGINT' ? 130 : 143) : 1;
    } finally {
        if (workspace) rmSync(workspace, { recursive: true, force: true });
        for (const [signal, handler] of setupHandlers) process.removeListener(signal, handler);
    }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
