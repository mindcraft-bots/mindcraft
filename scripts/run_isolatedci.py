#!/usr/bin/env python3
"""Run checked-in CI workflows in a fresh private snapshot with isolated tools."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
COMPOSE_URL = 'https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-x86_64'
COMPOSE_SHA256 = 'ed1917fb54db184192ea9d0717bcd59e3662ea79db48bff36d3475516c480a6b'
INHERITED_ENV = {'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE'}
# The full gate gives detached check groups 15 seconds to clean up before it
# escalates. Leave another 10 seconds for the gate to reap and finish teardown.
GRACE_SECONDS = 25
_signals = None


class Failed(Exception):
    def __init__(self, message, status=1):
        super().__init__(message)
        self.status = status if 0 < status < 256 else 1


def clean_environment(work):
    env = {key: value for key, value in os.environ.items() if key in INHERITED_ENV}
    env.update(HOME=str(work / 'home'), CI='true', NPM_CONFIG_USERCONFIG=str(work / 'user.npmrc'),
               NPM_CONFIG_GLOBALCONFIG=str(work / 'global.npmrc'), NPM_CONFIG_CACHE=str(work / 'npm-cache'),
               GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, PYTHONNOUSERSITE='1',
               DOCKER_CONFIG=str(work / 'docker'), DOCKER_HOST='unix:///var/run/docker.sock',
               TMPDIR=str(work / 'tmp'))
    return env


def snapshot_environment(clean):
    # Git needs the caller's effective ignore policy only while enumerating the
    # trusted checkout. Never pass these settings to npm or other tools.
    env = dict(clean)
    if 'HOME' not in os.environ:
        raise Failed('Cannot determine caller Git ignore policy without HOME')
    for key, value in os.environ.items():
        if key in {'HOME', 'XDG_CONFIG_HOME', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR',
                   'GIT_INDEX_FILE', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
                   'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'} or \
                key.startswith(('GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_')):
            env[key] = value
    for key in ('GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'):
        if key not in os.environ:
            env.pop(key, None)
    return env


@contextmanager
def signal_scope():
    global _signals
    if _signals is not None:
        yield _signals
        return
    state = {'received': None}
    previous = {}
    def record(signum, _frame):
        if state['received'] is None:
            state['received'] = signum
    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous[signum] = signal.signal(signum, record)
        _signals = state
        yield state
    finally:
        _signals = None
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def interrupted(state):
    if state['received'] is not None:
        raise Failed(f"Interrupted by {signal.Signals(state['received']).name}; cleanup may be incomplete",
                     128 + state['received'])


def supervise(control, reports, grace, command):
    """Session leader: only signal our own group while our identity is live."""
    if os.getsid(0) != os.getpid() or os.getpgrp() != os.getpid():
        raise Failed('Supervisor must be its own session and process-group leader')

    def report(message):
        try:
            os.write(reports, (json.dumps(message) + '\n').encode())
        except BrokenPipeError:
            pass  # The control pipe's EOF triggers cleanup if the parent died.

    def log(message):
        print(f'[outer supervisor] {message}', file=sys.stderr, flush=True)

    # Handlers, rather than SIG_IGN, are reset to defaults by exec in the child.
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda _sig, _frame: None)
    os.set_blocking(control, False)
    try:
        child = subprocess.Popen(command)
        error = None
    except OSError as exc:
        child = None
        error = str(exc)
    stopping = False
    deadline = None
    reported = False
    pending = b''
    disconnected = False
    while True:
        if not reported and (child is None or child.poll() is not None):
            result = None if child is None else child.returncode
            log(f'Child reaped, result={result}; retaining group ownership')
            report({'result': result, 'error': error})
            reported = True
        if stopping and time.monotonic() >= deadline:
            log('Cleanup grace ended; killing owned group')
            report({'final': True})
            os.killpg(os.getpgrp(), signal.SIGKILL)
            os._exit(1)
        ready, _, _ = select.select([] if disconnected else [control], [], [], 0.05)
        if not ready:
            continue
        data = os.read(control, 4096)
        if not data:
            disconnected = True
            data = f'STOP {signal.SIGTERM}\n'.encode()  # Parent vanished; attempt bounded cleanup.
        pending += data
        while b'\n' in pending:
            line, pending = pending.split(b'\n', 1)
            if line.startswith(b'STOP ') and not stopping:
                signum = int(line.split()[1])
                stopping = True
                deadline = time.monotonic() + grace
                log(f'Forwarding {signal.Signals(signum).name}; allowing cleanup')
                os.killpg(os.getpgrp(), signum)
            elif line == b'FINISH' and reported and not stopping:
                log('Normal completion; killing remaining owned group members')
                report({'final': True})
                os.killpg(os.getpgrp(), signal.SIGKILL)
                os._exit(1)


def supervisor_result(_message):
    """Boundary hook for deterministic lifecycle tests."""


def run(command, cwd, env, log):
    print(f'Running {command[0]}: {log}', flush=True)
    with signal_scope() as state, log.open('x', encoding='utf-8') as output:
        interrupted(state)
        # The fallback can signal only an unreaped direct child. Auto-reaping or
        # an external SIGCHLD handler would invalidate that ownership guarantee.
        if signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL:
            raise Failed('Safe supervision requires the default SIGCHLD disposition')
        control_read, control_write = os.pipe()
        report_read, report_write = os.pipe()
        try:
            try:
                child = subprocess.Popen([sys.executable, '-B', str(Path(__file__).resolve()),
                                          '--supervise', str(control_read), str(report_write),
                                          str(GRACE_SECONDS), *command], cwd=cwd, env=env,
                                         stdout=output, stderr=subprocess.STDOUT, start_new_session=True,
                                         pass_fds=(control_read, report_write))
            except OSError as error:
                raise Failed(f'{command[0]} could not start: {error}; see {log}') from error
            os.close(control_read)
            os.close(report_write)
            control_read = report_write = None
            os.set_blocking(report_read, False)
            message = None
            final = False
            sent_stop = False
            sent_finish = False
            deadline = None
            pending = b''
            report_eof = False
            while True:
                if state['received'] is not None and not sent_stop:
                    sent_stop = True
                    deadline = time.monotonic() + GRACE_SECONDS + 5
                    print(f"Forwarding {signal.Signals(state['received']).name} via supervisor; allowing cleanup", file=sys.stderr, flush=True)
                    try:
                        os.write(control_write, f"STOP {state['received']}\n".encode())
                    except BrokenPipeError:
                        pass
                if message is not None and not sent_stop and not sent_finish:
                    sent_finish = True
                    deadline = time.monotonic() + 5
                    try:
                        os.write(control_write, b'FINISH\n')
                    except BrokenPipeError:
                        pass
                ready, _, _ = select.select([] if report_eof else [report_read], [], [], 0.05)
                if ready:
                    data = os.read(report_read, 4096)
                    if not data:
                        report_eof = True
                    pending += data
                    while b'\n' in pending:
                        line, pending = pending.split(b'\n', 1)
                        item = json.loads(line)
                        if 'final' in item:
                            final = True
                        else:
                            message = item
                            supervisor_result(item)
                # WNOWAIT reserves the supervisor PID until the only fallback
                # signal (to this direct child, never its former group) is done.
                if report_eof and os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                    break
                if deadline is not None and time.monotonic() >= deadline:
                    print('Supervisor unresponsive; descendants or resources may remain', file=sys.stderr, flush=True)
                    try:
                        child.kill()
                    except ProcessLookupError:
                        pass
                    break
            try:
                supervisor_status = child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                print('Supervisor did not exit; cleanup incomplete', file=sys.stderr, flush=True)
                interrupted(state)
                raise Failed('Supervisor did not exit; cleanup incomplete')
            if not final or supervisor_status != -signal.SIGKILL:
                print('Supervisor exited unexpectedly; descendants or resources may remain', file=sys.stderr, flush=True)
            interrupted(state)
            if not final or supervisor_status != -signal.SIGKILL or message is None:
                raise Failed(f'Supervisor exited unexpectedly; descendants or resources may remain; see {log}')
            if message['error'] is not None:
                raise Failed(f"{command[0]} could not start: {message['error']}; see {log}")
            result = message['result']
        finally:
            for fd in (control_read, control_write, report_read, report_write):
                if fd is not None:
                    os.close(fd)
    if result:
        status = 128 - result if result < 0 else result
        raise Failed(f'{command[0]} exited {status}; see {log}', status)


def setup_compose(work, env, repo):
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'amd64'):
        raise Failed('Compose installer supports Linux x86_64 only')
    plugin = work / 'docker/cli-plugins/docker-compose'
    plugin.parent.mkdir(parents=True)
    print('Downloading pinned Compose v2.32.4', flush=True)
    try:
        with urllib.request.urlopen(COMPOSE_URL, timeout=60) as response, plugin.open('xb') as output:
            shutil.copyfileobj(response, output)
    except OSError as error:
        raise Failed(f'Compose download failed: {error}') from error
    if hashlib.sha256(plugin.read_bytes()).hexdigest() != COMPOSE_SHA256:
        raise Failed('Compose SHA-256 mismatch; refusing to execute it')
    plugin.chmod(0o700)
    run(['docker', 'compose', 'version'], repo, env, work / 'compose-version.log')
    run(['docker', 'info', '--format', 'daemon={{.Name}} version={{.ServerVersion}}'], repo, env, work / 'docker-info.log')


def main():
    with signal_scope() as state:
        return workflow(state)


def workflow(state):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'live', 'full', 'cache-tests'])
    parser.add_argument('--workspace-parent', type=Path, default=Path(tempfile.gettempdir()),
                        help='existing parent outside the checkout (default: system temporary directory)')
    parser.add_argument('--jobs', type=int, choices=[1, 2, 3], default=2, help='full gate workers (default: 2)')
    args = parser.parse_args()
    try:
        parent = args.workspace_parent.resolve(strict=True)
        if not parent.is_dir() or parent.is_relative_to(ROOT):
            raise Failed('Workspace parent must be an existing directory outside the checkout', 2)
        work = Path(tempfile.mkdtemp(prefix='mindcraft-isolated-ci-', dir=parent))
    except (OSError, Failed) as error:
        print(f'Workspace setup failed: {error}', file=sys.stderr)
        return getattr(error, 'status', 1)
    print(f'Private workspace (retained; may contain sensitive logs): {work}', flush=True)
    started = time.monotonic()
    status = 0
    try:
        if args.action != 'install' and not ((3, 9) <= sys.version_info[:2] <= (3, 11)):
            raise Failed('Python 3.9 through 3.11 is required by the pinned NumPy dependency')
        for name in ('home', 'tmp', 'checkout'):
            (work / name).mkdir(mode=0o700)
        for name in ('user.npmrc', 'global.npmrc'):
            (work / name).touch(mode=0o600, exist_ok=False)
        env = clean_environment(work)
        repo = work / 'checkout'
        run(['node', 'ci/snapshot_checkout.mjs', str(repo)], ROOT, snapshot_environment(env), work / 'snapshot.log')
        run(['git', 'init', '-q'], repo, env, work / 'git-init.log')
        shutil.copyfile(repo / 'ci/npm-lock.json', repo / 'package-lock.json')
        run(['git', 'add', '-f', '-A'], repo, env, work / 'git-index.log')
        run(['npm', 'ci'], repo, env, work / 'npm-ci.log')
        if args.action != 'install':
            run([sys.executable, '-m', 'venv', str(work / 'venv')], repo, env, work / 'venv.log')
            env['PATH'] = str(work / 'venv/bin') + os.pathsep + env.get('PATH', os.defpath)
            run([str(work / 'venv/bin/python'), '-m', 'pip', 'install', 'nbtlib==2.0.4', 'numpy==1.24.2'],
                repo, env, work / 'pip-install.log')
            if args.action in ('live', 'full'):
                setup_compose(work, env, repo)
            if args.action == 'live':
                run(['sh', 'ci/run_schematics.sh'], repo, env, work / 'live.log')
            elif args.action == 'full':
                run(['sh', 'ci/run_quality_gate.sh', 'full', '--jobs', str(args.jobs)], repo, env, work / 'full-gate.log')
            else:
                run(['python3', '-B', 'test/schematic/pack_cache_tests.py', '-v'], repo, env, work / 'cache-python.log')
                run(['node', '--test', 'test/schematic/build_pack.test.js', 'test/schematic/pack_cache.test.js'],
                    repo, env, work / 'cache-node.log')
    except (OSError, Failed) as error:
        status = getattr(error, 'status', 1)
        print(f'FAILED: {error}', file=sys.stderr)
    except KeyboardInterrupt:
        status = 130
        print('Interrupted', file=sys.stderr)
    finally:
        if state['received'] is not None:
            status = 128 + state['received']
            print('Interrupted; external resources or detached descendants may require manual cleanup', file=sys.stderr)
        print(f'wall_elapsed_sec={time.monotonic() - started:.2f}\nWORKFLOW_EXIT={status}\nWORKSPACE={work}', flush=True)
    return status


if __name__ == '__main__':
    if len(sys.argv) >= 6 and sys.argv[1] == '--supervise':
        supervise(int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]), sys.argv[5:])
    else:
        sys.exit(main())
