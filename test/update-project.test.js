import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const updater = path.join(projectRoot, 'scripts', 'update.sh');

function command(commandName, args, cwd, extraEnv = {}) {
    const result = spawnSync(commandName, args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_ALLOW_PROTOCOL: 'file',
            LC_ALL: 'C',
            GIT_TERMINAL_PROMPT: '0',
            ...extraEnv,
        },
    });
    if (result.error) throw result.error;
    return result;
}

function git(repo, ...args) {
    const result = command('git', args, repo);
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

function write(repo, name, content) {
    const destination = path.join(repo, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
}

function fixture(t, { spaced = false } = {}) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mindcraft-update-test-'));
    const bare = path.join(root, 'remote.git');
    const maintainer = path.join(root, 'maintainer');
    const checkout = path.join(root, spaced ? 'destination checkout with spaces' : 'destination');
    mkdirSync(maintainer);
    git(root, 'init', '--bare', '--initial-branch=main', bare);
    git(maintainer, 'init', '--initial-branch=main');
    git(maintainer, 'config', 'user.name', 'Update test');
    git(maintainer, 'config', 'user.email', 'update-test@example.invalid');
    write(maintainer, 'tracked.txt', 'base\n');
    git(maintainer, 'add', 'tracked.txt');
    git(maintainer, 'commit', '-m', 'base');
    git(maintainer, 'remote', 'add', 'origin', bare);
    git(maintainer, 'push', '-u', 'origin', 'main');
    git(root, 'clone', '--branch', 'main', bare, checkout);
    git(checkout, 'config', 'user.name', 'Update test');
    git(checkout, 'config', 'user.email', 'update-test@example.invalid');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return { root, bare, maintainer, checkout };
}

function commit(repo, name, content, message) {
    write(repo, name, content);
    git(repo, 'add', '--', name);
    git(repo, 'commit', '-m', message);
    return git(repo, 'rev-parse', 'HEAD');
}

function advanceRemote(fx, name = 'upstream.txt', content = 'remote change\n') {
    const oid = commit(fx.maintainer, name, content, 'advance upstream');
    git(fx.maintainer, 'push', 'origin', 'main');
    return oid;
}

function update(fx, mode = '--apply', args = [], cwd = fx.root) {
    return command('sh', [updater, mode, '--repo', fx.checkout, ...args], cwd);
}

test('clean behind checkout fast-forwards exactly to fetched upstream', (t) => {
    const fx = fixture(t);
    const expected = advanceRemote(fx);
    const result = update(fx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated branch main by fast-forward/);
    assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), expected);
    assert.equal(git(fx.checkout, 'show', '-s', '--format=%P', 'HEAD').split(' ').length, 1, 'update must remain a one-parent fast-forward');
    assert.equal(git(fx.checkout, 'status', '--porcelain'), '');
});

test('equal checkout reports current without creating a merge commit', (t) => {
    const fx = fixture(t);
    const before = git(fx.checkout, 'rev-parse', 'HEAD');
    const result = update(fx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Already current/);
    assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), before);
});

test('local ahead checkout is blocked and unchanged', (t) => {
    const fx = fixture(t);
    commit(fx.checkout, 'local.txt', 'local\n', 'local ahead');
    const before = git(fx.checkout, 'rev-parse', 'HEAD');
    const result = update(fx);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ahead/);
    assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), before);
});

test('diverged checkout is blocked without creating a merge/reset', (t) => {
    const fx = fixture(t);
    commit(fx.checkout, 'local.txt', 'local\n', 'local change');
    advanceRemote(fx);
    const before = git(fx.checkout, 'rev-parse', 'HEAD');
    const result = update(fx);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /diverged/);
    assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), before);
    assert.equal(git(fx.checkout, 'status', '--porcelain'), '');
});

for (const [label, prepare] of [
    ['staged tracked change', (fx) => { write(fx.checkout, 'tracked.txt', 'staged\n'); git(fx.checkout, 'add', 'tracked.txt'); }],
    ['unstaged tracked change', (fx) => write(fx.checkout, 'tracked.txt', 'unstaged\n')],
    ['ordinary untracked file', (fx) => write(fx.checkout, 'untracked.txt', 'keep me\n')],
]) {
    test(`dirty ${label} blocks update without changing user content`, (t) => {
        const fx = fixture(t);
        advanceRemote(fx);
        prepare(fx);
        const before = git(fx.checkout, 'rev-parse', 'HEAD');
        const localContent = label === 'ordinary untracked file'
            ? readFileSync(path.join(fx.checkout, 'untracked.txt'), 'utf8')
            : readFileSync(path.join(fx.checkout, 'tracked.txt'), 'utf8');
        const result = update(fx);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /not clean/);
        assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), before);
        assert.equal(readFileSync(path.join(fx.checkout, label === 'ordinary untracked file' ? 'untracked.txt' : 'tracked.txt'), 'utf8'), localContent);
    });
}

test('ignored runtime data survives an unrelated fast-forward', (t) => {
    const fx = fixture(t);
    write(fx.maintainer, '.gitignore', 'runtime/\n');
    git(fx.maintainer, 'add', '.gitignore');
    git(fx.maintainer, 'commit', '-m', 'ignore runtime data');
    git(fx.maintainer, 'push', 'origin', 'main');
    git(fx.checkout, 'pull', '--ff-only');
    write(fx.checkout, 'runtime/history.json', 'local runtime state\n');
    advanceRemote(fx);
    const result = update(fx);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path.join(fx.checkout, 'runtime/history.json'), 'utf8'), 'local runtime state\n');
});

test('ignored incoming-file collision is refused and preserves local bytes', (t) => {
    const fx = fixture(t);
    write(fx.maintainer, '.gitignore', 'runtime/\n');
    git(fx.maintainer, 'add', '.gitignore');
    git(fx.maintainer, 'commit', '-m', 'ignore runtime data');
    git(fx.maintainer, 'push', 'origin', 'main');
    git(fx.checkout, 'pull', '--ff-only');
    write(fx.checkout, 'runtime/collision.dat', 'do not overwrite\n');
    write(fx.maintainer, 'runtime/collision.dat', 'upstream content\n');
    git(fx.maintainer, 'add', '-f', 'runtime/collision.dat');
    git(fx.maintainer, 'commit', '-m', 'track ignored path');
    git(fx.maintainer, 'push', 'origin', 'main');
    const before = git(fx.checkout, 'rev-parse', 'HEAD');
    const result = update(fx);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fast-forward failed/);
    assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), before);
    assert.equal(readFileSync(path.join(fx.checkout, 'runtime/collision.dat'), 'utf8'), 'do not overwrite\n');
});

test('detached HEAD and missing upstream are both refused', (t) => {
    const detached = fixture(t);
    git(detached.checkout, 'checkout', '--detach', 'HEAD');
    const detachedResult = update(detached);
    assert.notEqual(detachedResult.status, 0);
    assert.match(detachedResult.stderr, /detached/);

    const noUpstream = fixture(t);
    git(noUpstream.checkout, 'branch', '--unset-upstream');
    const missingResult = update(noUpstream, '--check');
    assert.notEqual(missingResult.status, 0);
    assert.match(missingResult.stderr, /no configured upstream/);
});

test('offline --check uses cached upstream, does not fetch or update, and works from another CWD', (t) => {
    const fx = fixture(t, { spaced: true });
    advanceRemote(fx);
    git(fx.checkout, 'fetch', 'origin', 'main');
    const cached = git(fx.checkout, 'rev-parse', 'refs/remotes/origin/main');
    commit(fx.maintainer, 'later.txt', 'later\n', 'advance after cached ref');
    git(fx.maintainer, 'push', 'origin', 'main');
    git(fx.checkout, 'remote', 'set-url', 'origin', 'https://user:check-secret@127.0.0.1:1/repo.git');
    const before = git(fx.checkout, 'rev-parse', 'HEAD');
    const result = update(fx, '--check', [], os.tmpdir());
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Offline check: branch main vs cached upstream origin\/main: behind/);
    assert.match(result.stdout, /No network or repository changes/);
    assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), before);
    assert.equal(git(fx.checkout, 'rev-parse', 'refs/remotes/origin/main'), cached);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /check-secret/);
});

test('default target is the checkout containing the script, not the caller CWD', (t) => {
    const fx = fixture(t);
    const localScript = path.join(fx.checkout, 'scripts', 'update.sh');
    mkdirSync(path.dirname(localScript), { recursive: true });
    writeFileSync(localScript, readFileSync(updater));
    chmodSync(localScript, 0o755);
    git(fx.checkout, 'add', 'scripts/update.sh');
    git(fx.checkout, 'commit', '-m', 'add updater');
    git(fx.checkout, 'push', 'origin', 'main');
    git(fx.checkout, 'fetch', 'origin', 'main');
    const result = command(localScript, ['--check'], os.tmpdir());
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Offline check: branch main vs cached upstream origin\/main: equal/);
});

test('failed fetch suppresses credential-bearing remote URL diagnostics', (t) => {
    const fx = fixture(t);
    // A credential-shaped nonexistent local path tests redaction without HTTP.
    git(fx.checkout, 'remote', 'set-url', 'origin', path.join(fx.root, 'user:fetch-secret', 'missing.git'));
    const before = git(fx.checkout, 'rev-parse', 'HEAD');
    const result = update(fx);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fetch failed/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /fetch-secret/);
    assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), before);
});

test('shallow checkout is refused before update', (t) => {
    const fx = fixture(t);
    const depthResult = command('git', ['fetch', '--depth=1', 'origin', 'main'], fx.checkout);
    assert.equal(depthResult.status, 0, depthResult.stderr);
    assert.equal(git(fx.checkout, 'rev-parse', '--is-shallow-repository'), 'true');
    const result = update(fx);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /shallow checkout/);
});

test('unexpected invocation never operates on the real checkout', (t) => {
    const fx = fixture(t);
    advanceRemote(fx);
    const before = git(fx.checkout, 'rev-parse', 'HEAD');
    const invalid = command('sh', [updater, '--apply', '--repo', path.join(fx.root, 'missing')], fx.root);
    assert.notEqual(invalid.status, 0);
    assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), before);
});

// Include ignored bytes, symlinks, and index bytes, not just HEAD/status. A failed
// checkout can otherwise leave partial filesystem changes invisible to HEAD.
function snapshot(repo) {
    const files = {};
    function visit(directory, prefix = '') {
        for (const name of readdirSync(directory).sort()) {
            if (!prefix && name === '.git') continue;
            const relative = prefix ? `${prefix}/${name}` : name;
            const absolute = path.join(directory, name);
            const stat = lstatSync(absolute);
            if (stat.isSymbolicLink()) files[relative] = ['link', readlinkSync(absolute)];
            else if (stat.isDirectory()) { files[relative] = ['directory']; visit(absolute, relative); }
            else files[relative] = ['file', readFileSync(absolute).toString('base64'), stat.mode & 0o777];
        }
    }
    visit(repo);
    return {
        head: git(repo, 'rev-parse', 'HEAD'),
        index: readFileSync(git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).toString('base64'),
        files,
    };
}

function ignoreRuntime(fx, pattern = 'runtime*\n') {
    commit(fx.maintainer, '.gitignore', pattern, 'ignore runtime data');
    git(fx.maintainer, 'push', 'origin', 'main');
    git(fx.checkout, 'pull', '--ff-only');
}

for (const shape of ['file/file', 'file/directory', 'directory/file', 'directory/symlink', 'symlink/directory', 'tracked-directory/file']) {
    test(`ignored collision ${shape} preserves all files and index on failure`, (t) => {
        const fx = fixture(t);
        ignoreRuntime(fx);
        const [local, incoming] = shape.split('/');
        if (local === 'tracked-directory') {
            write(fx.maintainer, 'runtime/tracked', 'tracked child\n');
            git(fx.maintainer, 'add', '-f', 'runtime/tracked');
            git(fx.maintainer, 'commit', '-m', 'tracked child');
            git(fx.maintainer, 'push', 'origin', 'main');
            git(fx.checkout, 'pull', '--ff-only');
            git(fx.maintainer, 'rm', 'runtime/tracked');
        }
        if (local.endsWith('directory')) write(fx.checkout, 'runtime/precious\n file', 'KEEP\n');
        else if (local === 'symlink') {
            write(fx.root, 'outside/precious', 'OUTSIDE\n');
            symlinkSync(path.join(fx.root, 'outside'), path.join(fx.checkout, 'runtime'));
        } else write(fx.checkout, 'runtime', 'KEEP\n');
        // An unrelated early-sorting change must not be partially checked out.
        commit(fx.maintainer, 'aaa-new', 'new\n', 'early incoming path');
        if (incoming === 'directory') write(fx.maintainer, 'runtime/new', 'incoming\n');
        else if (incoming === 'symlink') symlinkSync('tracked.txt', path.join(fx.maintainer, 'runtime'));
        else write(fx.maintainer, 'runtime', 'incoming\n');
        git(fx.maintainer, 'add', '-f', 'runtime');
        git(fx.maintainer, 'commit', '-m', 'incoming collision');
        git(fx.maintainer, 'push', 'origin', 'main');
        const before = snapshot(fx.checkout);
        const result = update(fx);
        assert.notEqual(result.status, 0, result.stdout);
        assert.deepEqual(snapshot(fx.checkout), before);
        if (local === 'symlink') assert.equal(readFileSync(path.join(fx.root, 'outside/precious'), 'utf8'), 'OUTSIDE\n');
    });
}

for (const name of ['space name.txt', 'line\nbreak.txt', 'quote"slash\\tab\t.txt']) {
    test(`incoming unusual filename ${JSON.stringify(name)} is handled without splitting`, (t) => {
        const fx = fixture(t);
        const expected = advanceRemote(fx, name);
        const result = update(fx);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), expected);
        assert.equal(readFileSync(path.join(fx.checkout, name), 'utf8'), 'remote change\n');
    });
}

for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG']) {
    test(`operation marker ${marker} is detected from unrelated caller directory`, (t) => {
        const fx = fixture(t);
        write(fx.checkout, `.git/${marker}`, `${git(fx.checkout, 'rev-parse', 'HEAD')}\n`);
        const before = snapshot(fx.checkout);
        for (const mode of ['--check', '--apply']) {
            const result = update(fx, mode);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /in progress/);
            assert.deepEqual(snapshot(fx.checkout), before);
        }
    });
}

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    test(`${flag} cannot hide host-specific tracked changes`, (t) => {
        const fx = fixture(t);
        git(fx.checkout, 'update-index', flag, 'tracked.txt');
        write(fx.checkout, 'tracked.txt', 'host-specific KEEP\n');
        const before = snapshot(fx.checkout);
        const result = update(fx);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /assume-unchanged or skip-worktree/);
        assert.deepEqual(snapshot(fx.checkout), before);
    });
}

for (const [label, prepare, message] of [
    ['partial clone', (fx) => git(fx.checkout, 'config', 'extensions.partialClone', 'origin'), /partial\/promisor/],
    ['promisor remote', (fx) => git(fx.checkout, 'config', 'remote.origin.promisor', 'true'), /partial\/promisor/],
    ['sparse checkout', (fx) => git(fx.checkout, 'sparse-checkout', 'set', '--no-cone', 'tracked.txt'), /sparse/],
    ['checkout filter', (fx) => git(fx.checkout, 'config', 'filter.unknown.smudge', 'unknown-hydrator'), /checkout filters/],
]) {
    test(`${label} fails closed in both modes without fetching`, (t) => {
        const fx = fixture(t);
        prepare(fx);
        const before = snapshot(fx.checkout);
        for (const mode of ['--check', '--apply']) {
            const result = update(fx, mode);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, message);
            assert.deepEqual(snapshot(fx.checkout), before);
            assert.equal(existsSync(path.join(fx.checkout, '.git/FETCH_HEAD')), false);
        }
    });
}

test('incoming gitlink and LFS pointer are refused before changing checkout', (t) => {
    for (const kind of ['gitlink', 'LFS']) {
        const fx = fixture(t);
        if (kind === 'gitlink') {
            git(fx.maintainer, 'update-index', '--add', '--cacheinfo', `160000,${git(fx.maintainer, 'rev-parse', 'HEAD')},module`);
            git(fx.maintainer, 'commit', '-m', 'introduce gitlink');
            git(fx.maintainer, 'push', 'origin', 'main');
        } else advanceRemote(fx, 'pointer', 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n');
        const before = snapshot(fx.checkout);
        const result = update(fx);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, kind === 'gitlink' ? /submodules\/gitlinks/ : /Git LFS/);
        assert.deepEqual(snapshot(fx.checkout), before);
    }
});

test('missing cached upstream blocks offline check but apply can fetch it', (t) => {
    const fx = fixture(t);
    git(fx.checkout, 'update-ref', '-d', 'refs/remotes/origin/main');
    const before = snapshot(fx.checkout);
    const check = update(fx, '--check');
    assert.notEqual(check.status, 0);
    assert.match(check.stderr, /no locally cached commit/);
    assert.deepEqual(snapshot(fx.checkout), before);
    assert.equal(update(fx).status, 0);
});

test('fetch ignores opportunistic refmaps, pruning, and tag settings', (t) => {
    const fx = fixture(t);
    git(fx.checkout, 'config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/heads/surprise/*');
    git(fx.checkout, 'config', 'remote.origin.prune', 'true');
    git(fx.checkout, 'config', 'remote.origin.pruneTags', 'true');
    git(fx.checkout, 'tag', 'local-only');
    git(fx.maintainer, 'tag', 'remote-only');
    git(fx.maintainer, 'push', 'origin', '--tags');
    advanceRemote(fx);
    const result = update(fx);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(fx.checkout, 'for-each-ref', '--format=%(refname)', 'refs/heads/surprise/'), '');
    assert.equal(git(fx.checkout, 'tag', '--list'), 'local-only');
});

test('rewritten upstream is refused without moving HEAD or cached tracking ref', (t) => {
    const fx = fixture(t);
    advanceRemote(fx);
    git(fx.checkout, 'fetch', 'origin');
    const cached = git(fx.checkout, 'rev-parse', 'refs/remotes/origin/main');
    git(fx.maintainer, 'reset', '--hard', 'HEAD~1');
    commit(fx.maintainer, 'rewrite', 'rewritten\n', 'rewrite');
    git(fx.maintainer, 'push', '--force', 'origin', 'main');
    const before = snapshot(fx.checkout);
    const result = update(fx);
    assert.notEqual(result.status, 0);
    assert.deepEqual(snapshot(fx.checkout), before);
    assert.equal(git(fx.checkout, 'rev-parse', 'refs/remotes/origin/main'), cached);
});

test('offline check does not refresh index bytes or invoke configured hooks/fsmonitor', (t) => {
    const fx = fixture(t);
    const hook = path.join(fx.root, 'side-effect');
    write(fx.root, 'hook', `#!/bin/sh\ntouch '${hook}'\n`);
    chmodSync(path.join(fx.root, 'hook'), 0o755);
    git(fx.checkout, 'config', 'core.fsmonitor', path.join(fx.root, 'hook'));
    const before = snapshot(fx.checkout);
    write(fx.checkout, 'tracked.txt', 'base\n'); // same content, different stat data
    const result = update(fx, '--check');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(hook), false);
    assert.deepEqual(snapshot(fx.checkout), before);
});

test('symlinked parent and linked worktree target resolve to intended checkout', (t) => {
    const fx = fixture(t, { spaced: true });
    const alias = path.join(fx.root, 'alias');
    symlinkSync(fx.root, alias);
    const expected = advanceRemote(fx);
    const result = update({ ...fx, checkout: path.join(alias, path.basename(fx.checkout)) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), expected);
    const linked = path.join(fx.root, 'linked');
    git(fx.checkout, 'worktree', 'add', '-b', 'linked', linked);
    git(linked, 'branch', '--set-upstream-to=origin/main');
    const linkedResult = update({ ...fx, checkout: linked }, '--check');
    assert.equal(linkedResult.status, 0, linkedResult.stderr);
});

test('existing lock is never removed and failed apply releases its own lock', (t) => {
    const fx = fixture(t);
    const lock = path.join(fx.checkout, '.git/mindcraft-project-update.lock');
    mkdirSync(lock);
    assert.notEqual(update(fx).status, 0);
    assert.equal(existsSync(lock), true);
    assert.equal(update(fx, '--check').status, 0);
    assert.equal(existsSync(lock), true);
    rmSync(lock, { recursive: true });
    git(fx.checkout, 'remote', 'set-url', 'origin', path.join(fx.root, 'missing.git'));
    assert.notEqual(update(fx).status, 0);
    assert.equal(existsSync(lock), false);
});

test('invalid arguments and environment redirection never update a target', (t) => {
    const fx = fixture(t);
    advanceRemote(fx);
    const before = snapshot(fx.checkout);
    for (const args of [[], ['--apply', '--check'], ['--repo'], ['--check', '--repo', ''], ['--check', '--repo', '--apply'], ['--check', '--repo', fx.checkout, '--repo', fx.maintainer], ['https://user:argument-secret@example.invalid']]) {
        const result = command('sh', [updater, ...args], fx.root);
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout + result.stderr, /argument-secret/);
    }
    const redirected = command('sh', [updater, '--apply', '--repo', fx.checkout], fx.root, { GIT_DIR: path.join(fx.maintainer, '.git') });
    assert.notEqual(redirected.status, 0);
    assert.match(redirected.stderr, /environment overrides/);
    assert.deepEqual(snapshot(fx.checkout), before);
});

function wrappedGit(fx, body) {
    const realGit = command('sh', ['-c', 'command -v git'], fx.root).stdout.trim();
    const bin = path.join(fx.root, 'bin');
    write(fx.root, 'bin/git', `#!/bin/sh\n${body}\nexec '${realGit}' "$@"\n`);
    chmodSync(path.join(bin, 'git'), 0o755);
    return { PATH: `${bin}:${process.env.PATH}` };
}

for (const failure of ['ls-files', 'ls-tree', 'grep', 'merge']) {
    test(`Git ${failure} failure is nonzero, redacted, and stops the command chain`, (t) => {
        const fx = fixture(t);
        advanceRemote(fx);
        const env = wrappedGit(fx, `for arg do\n case $arg in ${failure}) printf '%s\\n' 'https://user:diagnostic-secret@example.invalid/repo' >&2; exit 2 ;; esac\ndone`);
        const before = snapshot(fx.checkout);
        const result = command('sh', ['-c', 'sh "$1" --apply --repo "$2" && printf CHAIN_CONTINUED', 'audit', updater, fx.checkout], fx.root, env);
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout + result.stderr, /diagnostic-secret|CHAIN_CONTINUED/);
        assert.deepEqual(snapshot(fx.checkout), before);
        assert.equal(existsSync(path.join(fx.checkout, '.git/mindcraft-project-update.lock')), false);
    });
}

test('simulated fetch diagnostic suppresses credential URL without a network request', (t) => {
    const fx = fixture(t);
    const env = wrappedGit(fx, "for arg do\n case $arg in fetch) echo 'https://user:url-secret@example.invalid/repo' >&2; exit 1 ;; esac\ndone");
    const result = command('sh', [updater, '--apply', '--repo', fx.checkout], fx.root, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fetch failed/);
    assert.doesNotMatch(result.stdout + result.stderr, /url-secret|https:/);
});

for (const signal of [null, 'SIGTERM', 'SIGHUP', 'SIGINT']) {
    test(`concurrent updater is excluded and ${signal || 'normal completion'} releases owned lock`, { timeout: 10000 }, async (t) => {
        const fx = fixture(t);
        const expected = advanceRemote(fx);
        const before = snapshot(fx.checkout);
        const env = wrappedGit(fx, `for arg do\n case $arg in fetch) : > '${fx.root}/entered'; while [ ! -e '${fx.root}/release' ]; do sleep 0.02; done ;; esac\ndone`);
        const child = spawn('sh', [updater, '--apply', '--repo', fx.checkout], {
            cwd: fx.root,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file', ...env },
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        const exited = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code, killedBy) => resolve({ code, killedBy }));
        });
        try {
            for (let i = 0; i < 200 && !existsSync(path.join(fx.root, 'entered')); i++) await delay(10);
            assert.equal(existsSync(path.join(fx.root, 'entered')), true, output);
            const concurrent = update(fx);
            assert.notEqual(concurrent.status, 0);
            assert.match(concurrent.stderr, /another update may be running/);
            assert.deepEqual(snapshot(fx.checkout), before);
            if (signal) child.kill(signal);
        } finally {
            write(fx.root, 'release', 'release\n');
        }
        const result = await exited;
        assert.equal(existsSync(path.join(fx.checkout, '.git/mindcraft-project-update.lock')), false, output);
        if (signal) {
            assert.notEqual(result.code, 0, output);
            assert.deepEqual(snapshot(fx.checkout), before);
        } else {
            assert.equal(result.code, 0, output);
            assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), expected);
        }
    });
}

test('unborn, bare, local-branch upstream, and deleted remote branch are refused', (t) => {
    const fx = fixture(t);
    const unborn = path.join(fx.root, 'unborn');
    mkdirSync(unborn);
    git(unborn, 'init', '--initial-branch=main');
    for (const target of [unborn, fx.bare]) {
        assert.notEqual(update({ ...fx, checkout: target }).status, 0);
    }
    git(fx.checkout, 'branch', 'local-upstream');
    git(fx.checkout, 'branch', '--set-upstream-to=local-upstream');
    assert.notEqual(update(fx).status, 0);
    git(fx.checkout, 'branch', '--set-upstream-to=origin/main');
    git(fx.bare, 'config', 'receive.denyDeleteCurrent', 'ignore');
    git(fx.maintainer, 'push', 'origin', '--delete', 'main');
    const before = snapshot(fx.checkout);
    const result = update(fx);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fetch failed/);
    assert.deepEqual(snapshot(fx.checkout), before);
});

test('newline checkout path is refused without falling back to sibling checkout', (t) => {
    const fx = fixture(t);
    const newlineTarget = `${fx.checkout}\n`;
    git(fx.root, 'clone', fx.bare, newlineTarget);
    advanceRemote(fx);
    const before = snapshot(fx.checkout);
    const newlineBefore = snapshot(newlineTarget);
    const result = update({ ...fx, checkout: newlineTarget });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /paths containing newlines/);
    assert.deepEqual(snapshot(fx.checkout), before);
    assert.deepEqual(snapshot(newlineTarget), newlineBefore);
});

test('dirty newline-named untracked file and nonignored directory collision preserve all data', (t) => {
    const fx = fixture(t);
    write(fx.checkout, 'runtime/user\n data', 'KEEP\n');
    advanceRemote(fx, 'runtime', 'incoming replacement\n');
    const before = snapshot(fx.checkout);
    const result = update(fx);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not clean/);
    assert.deepEqual(snapshot(fx.checkout), before);
});

for (const behind of [false, true]) {
    test(`edit during fetch blocks ${behind ? 'behind' : 'already-current'} deployment chain and preserves edit`, (t) => {
        const fx = fixture(t);
        if (behind) advanceRemote(fx);
        const beforeHead = git(fx.checkout, 'rev-parse', 'HEAD');
        const env = wrappedGit(fx, `for arg do\n case $arg in fetch) printf 'USER EDIT\\n' > '${fx.checkout}/tracked.txt' ;; esac\ndone`);
        const result = command('sh', ['-c', 'sh "$1" --apply --repo "$2" && printf CHAIN_CONTINUED', 'audit', updater, fx.checkout], fx.root, env);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /not clean/);
        assert.doesNotMatch(result.stdout, /CHAIN_CONTINUED/);
        assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), beforeHead);
        assert.equal(readFileSync(path.join(fx.checkout, 'tracked.txt'), 'utf8'), 'USER EDIT\n');
    });
}

test('explicit custom remote and branch, not origin/main, determine update target', (t) => {
    const fx = fixture(t);
    git(fx.maintainer, 'checkout', '-b', 'release');
    const expected = commit(fx.maintainer, 'release-file', 'release\n', 'release');
    git(fx.maintainer, 'push', 'origin', 'release');
    git(fx.checkout, 'remote', 'rename', 'origin', 'publisher');
    git(fx.checkout, 'fetch', 'publisher', 'release');
    git(fx.checkout, 'branch', '-m', 'deployment');
    git(fx.checkout, 'branch', '--set-upstream-to=publisher/release');
    const result = update(fx);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /branch deployment.*publisher\/release/);
    assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), expected);
});

test('multi-valued or option-shaped upstream configuration is rejected before fetch', (t) => {
    for (const [key, value, append] of [
        ['branch.main.merge', 'refs/heads/other', true],
        ['branch.main.remote', 'another', true],
        ['branch.main.remote', '--upload-pack=unexpected', false],
    ]) {
        const fx = fixture(t);
        git(fx.checkout, 'config', ...(append ? ['--add'] : []), key, value);
        const before = snapshot(fx.checkout);
        assert.notEqual(update(fx).status, 0);
        assert.deepEqual(snapshot(fx.checkout), before);
        assert.equal(existsSync(path.join(fx.checkout, '.git/FETCH_HEAD')), false);
    }
});

test('existing gitlink is refused even when submodule status is configured to ignore changes', (t) => {
    const fx = fixture(t);
    git(fx.checkout, 'update-index', '--add', '--cacheinfo', `160000,${git(fx.checkout, 'rev-parse', 'HEAD')},module`);
    git(fx.checkout, 'commit', '-m', 'existing gitlink');
    git(fx.checkout, 'config', 'diff.ignoreSubmodules', 'all');
    const before = snapshot(fx.checkout);
    const result = update(fx, '--check');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /submodules\/gitlinks/);
    assert.deepEqual(snapshot(fx.checkout), before);
});

for (const tool of ['grep', 'awk']) {
    test(`${tool} scanner errors fail closed`, (t) => {
        const fx = fixture(t);
        write(fx.root, `bin/${tool}`, '#!/bin/sh\nexit 2\n');
        chmodSync(path.join(fx.root, `bin/${tool}`), 0o755);
        const before = snapshot(fx.checkout);
        const result = command('sh', [updater, '--apply', '--repo', fx.checkout], fx.root, { PATH: `${fx.root}/bin:${process.env.PATH}` });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /cannot scan/);
        assert.deepEqual(snapshot(fx.checkout), before);
    });
}

test('missing required scanner is diagnosed before invoking Git', (t) => {
    const fx = fixture(t);
    mkdirSync(path.join(fx.root, 'bin'));
    for (const name of ['git', 'dirname', 'cat', 'mkdir', 'rmdir', 'grep']) {
        write(fx.root, `bin/${name}`, `#!/bin/sh\n: > '${fx.root}/unexpected-command'\nexit 1\n`);
        chmodSync(path.join(fx.root, `bin/${name}`), 0o755);
    }
    const result = command('/bin/sh', [updater, '--apply', '--repo', fx.checkout], fx.root, { PATH: `${fx.root}/bin` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required command is unavailable/);
    assert.equal(existsSync(path.join(fx.root, 'unexpected-command')), false);
});

test('default-target self update runs the current reviewed script from unrelated cwd', (t) => {
    const fx = fixture(t);
    write(fx.maintainer, 'scripts/update.sh', readFileSync(updater));
    chmodSync(path.join(fx.maintainer, 'scripts/update.sh'), 0o755);
    git(fx.maintainer, 'add', 'scripts/update.sh');
    git(fx.maintainer, 'commit', '-m', 'bootstrap updater');
    git(fx.maintainer, 'push', 'origin', 'main');
    git(fx.checkout, 'pull', '--ff-only');
    const expected = advanceRemote(fx, 'scripts/update.sh', `${readFileSync(updater, 'utf8')}\n# reviewed next version\n`);
    const result = command(path.join(fx.checkout, 'scripts/update.sh'), ['--apply'], fx.root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(fx.checkout, 'rev-parse', 'HEAD'), expected);
    assert.match(readFileSync(path.join(fx.checkout, 'scripts/update.sh'), 'utf8'), /reviewed next version/);
});

test('LFS signature mentions in source are allowed but CRLF pointer lines are blocked', (t) => {
    const fx = fixture(t);
    advanceRemote(fx, 'source.txt', 'const signature = "version https://git-lfs.github.com/spec/v1";\n');
    assert.equal(update(fx).status, 0);
    advanceRemote(fx, 'pointer', 'version https://git-lfs.github.com/spec/v1\r\noid sha256:abc\r\nsize 1\r\n');
    const before = snapshot(fx.checkout);
    const result = update(fx);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Git LFS/);
    assert.deepEqual(snapshot(fx.checkout), before);
});
