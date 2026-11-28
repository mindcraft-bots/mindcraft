import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const collector = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/collect_diagnostics.py');
const mock = `#!/bin/sh
printf '%s\n' "$*" >> "$MOCK_CALLS"
 if [ "$1" = context ]; then printf '"%s"\n' "\${MOCK_CONTEXT_HOST:-unix:///var/run/docker.sock}"; exit 0; fi
if [ "$1" = inspect ]; then
    [ "$2" = --format ] || exit 90
    if [ -n "$MOCK_REAL_DOCKER" ]; then exec "$MOCK_REAL_DOCKER" "$@"; fi
    case "$MOCK_MODE:$4" in inspect-fail:alice1) echo 'sensitive-docker-error' >&2; exit 1;; esac
    if [ "$4" = charlie1 ] && [ -n "$MOCK_SOURCE_2" ]; then MOCK_SOURCE=$MOCK_SOURCE_2; export MOCK_SOURCE; fi
    printf 'container_id=%s\nimage_id=sha256:123\nmount source="%s" destination="/app/bots" rw=true\n' "$4" "$MOCK_SOURCE"
    if [ "$MOCK_MODE" != no-mount ]; then
        python3 -c 'import json,os; print("MINDCRAFT_MOUNT\\t" + "\\t".join(map(json.dumps, [os.environ.get("MOCK_TYPE", "bind"), os.environ["MOCK_SOURCE"], os.environ.get("MOCK_DEST", "/app/bots")])))'
    fi
    if [ "$MOCK_MODE" = nested-mount ]; then printf 'MINDCRAFT_MOUNT\t"bind"\t"/other"\t"/app/bots/other"\n'; fi
    exit 0
fi
[ "$1" = compose ] && [ "$2" = --project-directory ] && [ "$3" = "$MOCK_PROJECT" ] || exit 91
shift 3
case "$1" in
    config)
        [ "$2" = --services ] || exit 92
        [ "$MOCK_MODE" != config-fail ] || { echo 'sensitive-docker-error' >&2; exit 1; }
        printf 'bot-alice\n'
        [ "$MOCK_MODE" = missing-service ] || printf 'bot-andy\n'
        [ "$MOCK_MODE" != extra-services ] || printf 'bot-charlie\nviaproxy\n'
        ;;
    ps)
        [ "$2" = --all ] && [ "$3" = --quiet ] || exit 93
        case "$MOCK_MODE:$4" in
            ps-fail:bot-alice) echo 'sensitive-docker-error' >&2; exit 1;;
            no-container:bot-alice) exit 0;;
        esac
        case "$4" in bot-alice) printf 'alice1\nalice2\n';; bot-andy) printf 'andy1\n';; bot-charlie) printf 'charlie1\n';; viaproxy) exit 0;; *) exit 94;; esac
        ;;
    logs)
        [ "$2" = --no-color ] && [ "$3" = --timestamps ] && [ "$4" = --tail=all ] || exit 95
        [ "$MOCK_MODE" != empty-logs ] || exit 0
        printf '2026-01-01T00:00:00Z %s first\n2026-01-01T00:00:01Z %s last\n' "$5" "$5"
        [ "$MOCK_MODE:$5" != log-fail:bot-alice ] || { echo 'sensitive-docker-error' >&2; exit 1; }
        ;;
    *) exit 96;;
esac
`;

function fixture(t) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-diagnostics-test-'));
    const project = path.join(root, 'compose project');
    const bin = path.join(root, 'bin');
    const calls = path.join(root, 'calls');
    const source = path.join(root, 'external bot data');
    mkdirSync(project);
    mkdirSync(bin);
    mkdirSync(source);
    writeFileSync(path.join(bin, 'docker'), mock);
    chmodSync(path.join(bin, 'docker'), 0o755);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return { root, project, bin, calls, source };
}

function run(fx, mode = 'success', args = ['--project-directory', fx.project], cwd = fx.root, extraEnv = {}, python = false) {
    const script = fx.collector ?? collector;
    const result = spawnSync(python ? 'python3' : script, python ? [script, ...args] : args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, DOCKER_HOST: '', DOCKER_CONTEXT: '', PATH: `${fx.bin}:${process.env.PATH}`, MOCK_CALLS: fx.calls, MOCK_PROJECT: fx.project, MOCK_SOURCE: fx.source, MOCK_MODE: mode, ...extraEnv },
    });
    if (result.error) throw result.error;
    const output = result.stdout.match(/^Output directory: (.+)$/m)?.[1] ?? null;
    return { ...result, output };
}

test('collects privately in a clean Compose project without a tmp directory', (t) => {
    const fx = fixture(t);
    assert.deepEqual(readdirSync(fx.project), []);
    const previousUmask = process.umask(0);
    let result;
    try { result = run(fx); } finally { process.umask(previousUmask); }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(path.dirname(result.output), path.join(fx.project, 'tmp'));
    assert.match(path.basename(result.output), /^mindcraft-bot-diagnostics\./);
    assert.equal(statSync(path.join(fx.project, 'tmp')).mode & 0o777, 0o700);
    assert.equal(statSync(result.output).mode & 0o777, 0o700);
    assert.ok(readdirSync(result.output).length > 0);
    for (const name of readdirSync(result.output)) assert.equal(statSync(path.join(result.output, name)).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(fx.project), ['tmp']);
});

test('collects all requested logs and selected metadata for every retained container', (t) => {
    const fx = fixture(t);
    const result = run(fx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Output directory:/);
    assert.equal(statSync(result.output).mode & 0o777, 0o700);
    for (const name of readdirSync(result.output)) assert.equal(statSync(path.join(result.output, name)).mode & 0o777, 0o600);
    assert.match(readFileSync(path.join(result.output, 'bot-alice-logs.txt'), 'utf8'), /first\n.*last/);
    assert.match(readFileSync(path.join(result.output, 'bot-andy-logs.txt'), 'utf8'), /bot-andy first/);
    const metadata = readFileSync(path.join(result.output, 'bot-alice-metadata.txt'), 'utf8');
    assert.match(metadata, /container_id=alice1/);
    assert.match(metadata, /container_id=alice2/);
    const calls = readFileSync(fx.calls, 'utf8');
    assert.equal((calls.match(/^inspect --format /gm) || []).length, 3);
    assert.match(calls, /\.Config\.Image/);
    assert.match(calls, /index \. "Mounts"/);
    assert.doesNotMatch(calls, /\.Config\.Env|\b(up|down|start|stop|rm|exec)\b/);
    assert.match(readFileSync(path.join(result.output, 'collection-status.txt'), 'utf8'), /logging driver may limit/);
});

test('renders real Docker inspect templates against bind mounts and named volumes', { timeout: 10000 }, async (t) => {
    const lookup = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' });
    if (lookup.status !== 0) return t.skip('Docker CLI is required for template rendering');
    const docker = lookup.stdout.trim();
    const fx = fixture(t);
    const socket = path.join(fx.root, 'docker.sock');
    const dockerConfig = path.join(fx.root, 'docker-config');
    mkdirSync(dockerConfig);

    // A local fake Engine API supplies realistic inspect JSON; the real Docker
    // CLI, not the fake, parses and executes the collector's Go template.
    const server = spawn(process.execPath, ['-e', `
        const http = require('node:http');
        const fs = require('node:fs');
        const [socket, failFile, source] = process.argv.slice(1);
        http.createServer((req, res) => {
            if (req.url === '/_ping' || req.url.endsWith('/_ping')) {
                res.writeHead(200, { 'API-Version': '1.41' }); res.end('OK'); return;
            }
            const match = req.url.match(/\\/containers\\/([^/]+)\\/json$/);
            if (!match) { res.writeHead(404); res.end('{}'); return; }
            const id = decodeURIComponent(match[1]);
            const data = {
                Id: id, Name: '/' + id, Image: 'sha256:123',
                Config: { Image: 'mindcraft:latest', Env: ['SECRET=do-not-save'] },
                State: fs.existsSync(failFile) && id === 'alice1' ? null : { Status: 'exited' },
                HostConfig: { Password: 'do-not-save' },
                Mounts: [
                    { Type: 'bind', Source: source, Destination: '/app/bots', RW: true },
                    { Type: 'volume', Name: 'bot-data', Source: '/var/lib/docker/volumes/bot-data/_data', Destination: '/data', RW: false },
                    { Type: 'tmpfs', Destination: '/tmp' }
                ]
            };
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
        }).listen(socket, () => console.log('ready'));
    `, socket, path.join(fx.root, 'fail-template'), fx.source], { stdio: ['ignore', 'pipe', 'inherit'] });
    t.after(() => server.kill());
    await once(server.stdout, 'data');
    const env = {
        MOCK_REAL_DOCKER: docker, DOCKER_HOST: `unix://${socket}`, DOCKER_API_VERSION: '1.41',
        DOCKER_CONTEXT: '', DOCKER_TLS_VERIFY: '', DOCKER_CERT_PATH: '', DOCKER_CONFIG: dockerConfig,
    };

    // Docker versions differ: strict missing keys error, while older clients
    // may decode mount entries as structs and supply an empty Name.
    const oldTemplate = spawnSync(docker, ['inspect', '--format', '{{range .Mounts}}{{.Name}}{{end}}', 'alice1'], {
        encoding: 'utf8', env: { ...process.env, ...env },
    });
    if (oldTemplate.status === 0) assert.match(oldTemplate.stdout, /bot-data/);
    else assert.match(oldTemplate.stderr, /map has no entry for key "Name"/);

    const result = run(fx, 'success', undefined, undefined, env);
    assert.equal(result.status, 0, result.stderr);
    for (const service of ['bot-alice', 'bot-andy']) {
        const metadata = readFileSync(path.join(result.output, `${service}-metadata.txt`), 'utf8');
        assert.ok(metadata.includes(`mount type="bind" name="" source="${fx.source}" destination="/app/bots" rw=true`));
        assert.match(metadata, /mount type="volume" name="bot-data" source="\/var\/lib\/docker\/volumes\/bot-data\/_data" destination="\/data" rw=false/);
        assert.match(metadata, /mount type="tmpfs" name="" source="" destination="\/tmp" rw=unknown/);
        assert.doesNotMatch(metadata, /do-not-save|SECRET|HostConfig|%!/);
        assert.match(readFileSync(path.join(result.output, `${service}-logs.txt`), 'utf8'), /first\n.*last/);
    }
    assert.match(readFileSync(path.join(result.output, 'bot-alice-metadata.txt'), 'utf8'), /container_id=alice2/);
    for (const name of readdirSync(result.output)) {
        assert.doesNotMatch(readFileSync(path.join(result.output, name), 'utf8'), /do-not-save|SECRET/);
    }

    // A genuine template execution failure must still be reported as partial,
    // without preventing other containers and logs from being collected.
    writeFileSync(path.join(fx.root, 'fail-template'), '');
    const failed = run(fx, 'success', undefined, undefined, env);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /template parsing error/);
    const status = readFileSync(path.join(failed.output, 'collection-status.txt'), 'utf8');
    assert.match(status, /metadata inspection failed for bot-alice container alice1/);
    assert.match(status, /Collection incomplete/);
    assert.match(readFileSync(path.join(failed.output, 'bot-alice-metadata.txt'), 'utf8'), /container_id=alice2/);
    assert.match(readFileSync(path.join(failed.output, 'bot-andy-logs.txt'), 'utf8'), /bot-andy first/);
    for (const name of readdirSync(failed.output)) {
        assert.doesNotMatch(readFileSync(path.join(failed.output, name), 'utf8'), /do-not-save|SECRET/);
    }
});

for (const [mode, message] of [
    ['no-container', /no retained Compose containers found for bot-alice/],
    ['ps-fail', /could not list retained containers for bot-alice/],
    ['log-fail', /Compose logs failed for bot-alice/],
    ['inspect-fail', /metadata inspection failed for bot-alice container alice1/],
    ['config-fail', /could not list Compose services/],
]) {
    test(`reports ${mode} without saving Docker stderr`, (t) => {
        const fx = fixture(t);
        const result = run(fx, mode);
        assert.equal(result.status, 1);
        const status = readFileSync(path.join(result.output, 'collection-status.txt'), 'utf8');
        assert.match(status, message);
        for (const name of readdirSync(result.output)) {
            assert.doesNotMatch(readFileSync(path.join(result.output, name), 'utf8'), /sensitive-docker-error/);
        }
        if (mode !== 'config-fail' && mode !== 'missing-service') {
            assert.match(readFileSync(path.join(result.output, 'bot-andy-logs.txt'), 'utf8'), /bot-andy first/);
        }
        if (mode === 'log-fail') assert.match(readFileSync(path.join(result.output, 'bot-alice-logs.txt'), 'utf8'), /first/);
    });
}

test('configured services are discovered rather than requiring a fixed bot pair', (t) => {
    const fx = fixture(t);
    const result = run(fx, 'missing-service');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!readdirSync(result.output).includes('bot-andy-logs.txt'));
});

test('uses script parent by default from another cwd and creates separate outputs', (t) => {
    const fx = fixture(t);
    const scripts = path.join(fx.project, 'scripts');
    mkdirSync(scripts);
    fx.collector = path.join(scripts, 'collect_diagnostics.py');
    copyFileSync(collector, fx.collector);
    chmodSync(fx.collector, 0o755);
    const first = run(fx, 'success', [], fx.root);
    const second = run(fx, 'success', [], fx.root);
    const explicitPython = run(fx, 'success', [], fx.root, {}, true);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(explicitPython.status, 0, explicitPython.stderr);
    assert.notEqual(first.output, second.output);
    assert.notEqual(explicitPython.output, first.output);
    assert.equal(path.dirname(first.output), path.join(fx.project, 'tmp'));
    assert.deepEqual(readdirSync(path.join(fx.project, 'tmp')).sort(), [path.basename(first.output), path.basename(second.output), path.basename(explicitPython.output)].sort());
});

test('help and invalid arguments do not need Docker', (t) => {
    const fx = fixture(t);
    const help = run(fx, 'success', ['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: collect_diagnostics\.py \[--project-directory DIR\] \[--output-directory DIR\]/);
    assert.match(help.stdout, /Relative DIR overrides.*invocation working directory/);
    const pythonHelp = spawnSync('python3', [collector, '-h'], { cwd: fx.root, encoding: 'utf8' });
    assert.equal(pythonHelp.status, 0, pythonHelp.error || pythonHelp.stderr);
    assert.equal(pythonHelp.stdout, help.stdout);
    assert.deepEqual(readdirSync(fx.project), []);
    assert.throws(() => readFileSync(fx.calls), { code: 'ENOENT' });
    const bad = run(fx, 'success', ['--project-directory']);
    assert.equal(bad.status, 2);
    for (const args of [['--output-directory'], ['--output-directory', ''], ['--bad', 'x'], ['--project-directory', fx.project, '--project-directory', fx.project]]) {
        assert.equal(run(fx, 'success', args).status, 2);
    }
    const missingProject = run(fx, 'success', ['--project-directory', path.join(fx.root, 'missing')]);
    assert.equal(missingProject.status, 2);
    assert.match(missingProject.stderr, /cannot enter the Compose project directory/);
});

test('resolves relative project and output overrides against the invocation cwd', (t) => {
    const fx = fixture(t);
    const output = path.join(fx.root, 'custom output', 'nested directory');
    const result = run(fx, 'success', ['--output-directory', 'custom output/nested directory', '--project-directory', 'compose project']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(path.dirname(result.output), output);
    assert.equal(statSync(output).mode & 0o777, 0o700);
    assert.equal(statSync(result.output).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(fx.project), []);
    chmodSync(output, 0o755);
    const absolute = run(fx, 'success', ['--project-directory', fx.project, '--output-directory', output]);
    assert.equal(absolute.status, 0, absolute.stderr);
    assert.equal(path.dirname(absolute.output), output);
    assert.equal(statSync(output).mode & 0o777, 0o755);
    assert.equal(statSync(absolute.output).mode & 0o777, 0o700);
    assert.notEqual(result.output, absolute.output);
    const projectOnly = run(fx, 'success', ['--project-directory', 'compose project']);
    assert.equal(projectOnly.status, 0, projectOnly.stderr);
    assert.equal(path.dirname(projectOnly.output), path.join(fx.project, 'tmp'));
});

test('output override works with the default project and rejects unsafe output paths', (t) => {
    const fx = fixture(t);
    mkdirSync(path.join(fx.project, 'scripts'));
    fx.collector = path.join(fx.project, 'scripts', 'collect_diagnostics.py');
    copyFileSync(collector, fx.collector);
    chmodSync(fx.collector, 0o755);
    const output = path.join(fx.root, 'output parent');
    const result = run(fx, 'success', ['--output-directory', output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(path.dirname(result.output), output);
    const file = path.join(fx.root, 'not a directory');
    writeFileSync(file, 'preserve');
    const link = path.join(fx.root, 'linked output');
    symlinkSync(output, link);
    const tmpLink = path.join(fx.project, 'tmp');
    symlinkSync(output, tmpLink);
    for (const args of [['--output-directory', file], ['--output-directory', link], []]) {
        const failed = run(fx, 'success', args);
        assert.equal(failed.status, 2);
        assert.equal(failed.output, null);
        assert.match(failed.stderr, /cannot create a private output directory/);
    }
    assert.equal(readFileSync(file, 'utf8'), 'preserve');
    assert.deepEqual(readdirSync(output), [path.basename(result.output)]);
});

test('rejects an output under a bot source through a symlinked ancestor', (t) => {
    const fx = fixture(t);
    const alias = path.join(fx.root, 'source alias');
    symlinkSync(fx.source, alias);
    const result = run(fx, 'success', ['--project-directory', fx.project, '--output-directory', path.join(alias, 'bundles')]);
    assert.equal(result.status, 1);
    assert.match(readFileSync(path.join(result.output, 'collection-status.txt'), 'utf8'), /output directory is inside bot source/);
});

test('reports a missing Docker CLI before creating output', (t) => {
    const fx = fixture(t);
    const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    assert.equal(python.status, 0, python.error || python.stderr);
    const emptyPath = path.join(fx.root, 'empty-path');
    mkdirSync(emptyPath);
    const result = spawnSync(python.stdout.trim(), [collector, '--project-directory', fx.project], {
        cwd: fx.root, env: { ...process.env, PATH: emptyPath }, encoding: 'utf8',
    });
    assert.equal(result.status, 2, result.error || result.stderr);
    assert.match(result.stderr, /Docker CLI not found/);
    assert.deepEqual(readdirSync(fx.project), []);
});

test('collects selected histories and nested prompt logs across shared and distinct mounts privately', (t) => {
    const fx = fixture(t);
    const other = path.join(fx.root, 'volume data');
    mkdirSync(path.join(fx.source, 'alice name', 'histories'), { recursive: true });
    mkdirSync(path.join(fx.source, 'alice name', 'logs', 'task id', 'nested'), { recursive: true });
    mkdirSync(path.join(fx.source, 'new-bot'), { recursive: true });
    mkdirSync(path.join(other, 'alice name', 'logs'), { recursive: true });
    writeFileSync(path.join(fx.source, 'alice name', 'memory.json'), 'memory');
    writeFileSync(path.join(fx.source, 'alice name', 'histories', 'first.json'), 'history');
    writeFileSync(path.join(fx.source, 'alice name', 'histories', 'ignore.txt'), 'ignore');
    writeFileSync(path.join(fx.source, 'alice name', 'logs', 'task id', 'nested', 'prompt.txt'), 'sensitive prompt');
    writeFileSync(path.join(fx.source, 'alice name', 'logs', 'extra.log'), 'other log');
    writeFileSync(path.join(fx.source, 'alice name', 'keys.json'), 'secret key');
    writeFileSync(path.join(fx.source, 'alice name', 'last_profile.json'), 'profile');
    writeFileSync(path.join(other, 'alice name', 'logs', 'other.txt'), 'other source');
    const result = run(fx, 'extra-services', undefined, undefined, { MOCK_SOURCE_2: other, MOCK_TYPE: 'volume' });
    assert.equal(result.status, 0, result.stderr);
    const first = path.join(result.output, 'bot-data', 'source-001', 'alice name');
    assert.equal(readFileSync(path.join(first, 'memory.json'), 'utf8'), 'memory');
    assert.equal(readFileSync(path.join(first, 'histories', 'first.json'), 'utf8'), 'history');
    assert.equal(readFileSync(path.join(first, 'logs', 'task id', 'nested', 'prompt.txt'), 'utf8'), 'sensitive prompt');
    assert.equal(readFileSync(path.join(first, 'logs', 'extra.log'), 'utf8'), 'other log');
    assert.deepEqual(readdirSync(first).sort(), ['histories', 'logs', 'memory.json']);
    assert.deepEqual(readdirSync(path.join(first, 'histories')), ['first.json']);
    assert.equal(readFileSync(path.join(result.output, 'bot-data', 'source-002', 'alice name', 'logs', 'other.txt'), 'utf8'), 'other source');
    const status = readFileSync(path.join(result.output, 'collection-status.txt'), 'utf8');
    assert.match(status, /SHARED: bot-alice container alice2/);
    assert.match(status, /MISSING OPTIONAL:.*new-bot\/memory.json/);
    assert.match(status, /MISSING OPTIONAL: no retained Compose containers found for viaproxy/);
    assert.match(readFileSync(path.join(result.output, 'bot-charlie-logs.txt'), 'utf8'), /bot-charlie first/);
    assert.match(readFileSync(path.join(result.output, 'viaproxy-logs.txt'), 'utf8'), /viaproxy first/);
    function checkModes(dir) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            assert.equal(statSync(file).mode & 0o777, entry.isDirectory() ? 0o700 : 0o600, file);
            if (entry.isDirectory()) checkModes(file);
        }
    }
    checkModes(result.output);
});

test('uses a parent mount and retained containers for bot data', (t) => {
    const fx = fixture(t);
    mkdirSync(path.join(fx.source, 'bots', 'different-agent'), { recursive: true });
    writeFileSync(path.join(fx.source, 'bots', 'different-agent', 'memory.json'), 'retained');
    const result = run(fx, 'success', undefined, undefined, { MOCK_DEST: '/app', MOCK_TYPE: 'volume' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(result.output, 'bot-data', 'source-001', 'different-agent', 'memory.json'), 'utf8'), 'retained');
    assert.match(readFileSync(fx.calls, 'utf8'), /ps --all --quiet bot-alice/);
});

test('rejects symlinks without reading targets and reports incomplete collection', (t) => {
    const fx = fixture(t);
    const outside = path.join(fx.root, 'outside secret');
    writeFileSync(outside, 'not for sharing');
    mkdirSync(path.join(fx.source, 'alice', 'histories'), { recursive: true });
    mkdirSync(path.join(fx.source, 'alice', 'logs'), { recursive: true });
    symlinkSync(outside, path.join(fx.source, 'alice', 'memory.json'));
    symlinkSync(outside, path.join(fx.source, 'alice', 'histories', 'escape.json'));
    symlinkSync(fx.root, path.join(fx.source, 'alice', 'logs', 'escape'));
    symlinkSync(fx.root, path.join(fx.source, 'other-agent'));
    const result = run(fx);
    assert.equal(result.status, 1);
    const status = readFileSync(path.join(result.output, 'collection-status.txt'), 'utf8');
    assert.match(status, /cannot copy.*memory.json/);
    assert.match(status, /cannot copy.*escape.json/);
    assert.match(status, /skipped symlink or special log entry/);
    assert.match(status, /skipped symlink agent entry/);
    assert.doesNotMatch(status, /not for sharing/);
});

test('distinguishes an unreadable history directory from missing optional files', (t) => {
    if (process.getuid?.() === 0) return t.skip('root bypasses the fixture permissions');
    const fx = fixture(t);
    const history = path.join(fx.source, 'alice', 'histories');
    mkdirSync(history, { recursive: true });
    writeFileSync(path.join(history, 'history.json'), 'private');
    chmodSync(history, 0);
    let result;
    try { result = run(fx); } finally { chmodSync(history, 0o700); }
    assert.equal(result.status, 1);
    const status = readFileSync(path.join(result.output, 'collection-status.txt'), 'utf8');
    assert.match(status, /ERROR: cannot open .*histories.*Permission denied/);
    assert.match(status, /MISSING OPTIONAL:.*memory.json/);
});

test('reports empty retained Compose logs as missing optional output', (t) => {
    const fx = fixture(t);
    const result = run(fx, 'empty-logs');
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(path.join(result.output, 'collection-status.txt'), 'utf8'), /MISSING OPTIONAL: no retained Compose log output for bot-alice/);
});

for (const [mode, env, expected] of [
    ['success', { DOCKER_HOST: 'ssh://remote' }, /Docker daemon is remote/],
    ['success', { DOCKER_CONTEXT: 'remote', MOCK_CONTEXT_HOST: 'ssh://remote' }, /Docker daemon is remote/],
    ['success', { MOCK_SOURCE: '/definitely-not-present-mindcraft-source' }, /cannot access \/app\/bots source/],
    ['success', { MOCK_SOURCE: 'relative-source' }, /invalid daemon mount source/],
    ['no-mount', {}, /no \/app\/bots mount.*container-only bot data is not collected/],
    ['nested-mount', {}, /nested mounts under \/app\/bots.*unsupported/],
]) {
    test(`reports unsupported or inaccessible source: ${mode} ${JSON.stringify(env)}`, (t) => {
        const fx = fixture(t);
        const result = run(fx, mode, undefined, undefined, env);
        assert.equal(result.status, 1);
        assert.match(readFileSync(path.join(result.output, 'collection-status.txt'), 'utf8'), expected);
        assert.match(readFileSync(path.join(result.output, 'bot-andy-logs.txt'), 'utf8'), /bot-andy first/);
    });
}
