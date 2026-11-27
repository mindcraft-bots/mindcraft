#!/usr/bin/env python3
"""Exercise the real wrapper signal scope and a stubborn descendant."""
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

mode, directory, script = sys.argv[1:]
directory = Path(directory)
if mode in ('wrapper', 'wrapper-compose', 'wrapper-nested', 'wrapper-nested-stuck',
            'wrapper-boundary', 'wrapper-orphan', 'wrapper-dead-supervisor', 'wrapper-stuck-supervisor'):
    spec = importlib.util.spec_from_file_location('isolated', script)
    ci = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ci)
    if not mode.startswith('wrapper-nested'):
        ci.GRACE_SECONDS = 0.5
    if mode in ('wrapper-dead-supervisor', 'wrapper-stuck-supervisor'):
        (directory / 'expire').touch()
        original_popen = subprocess.Popen
        supervisor = []
        def capture(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            supervisor.append(process)
            return process
        ci.subprocess.Popen = capture
    if mode in ('wrapper-boundary', 'wrapper-dead-supervisor', 'wrapper-stuck-supervisor'):
        def at_result(_message):
            if mode == 'wrapper-dead-supervisor':
                supervisor[0].kill()  # This direct child has not been reaped.
                while os.waitid(os.P_PID, supervisor[0].pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
                    time.sleep(0.01)
            elif mode == 'wrapper-stuck-supervisor':
                (directory / 'supervisor-pid').write_text(str(supervisor[0].pid))
                deadline = time.monotonic() + 5
                while not (directory / 'armed').exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                if not (directory / 'armed').exists():
                    raise RuntimeError('pidfd was not armed')
                supervisor[0].send_signal(signal.SIGSTOP)
            (directory / 'reaped').touch()
            if mode == 'wrapper-stuck-supervisor':
                return
            deadline = time.monotonic() + 5
            while not (directory / 'release').exists() and time.monotonic() < deadline:
                time.sleep(0.01)
        ci.supervisor_result = at_result
    if mode in ('wrapper-boundary', 'wrapper-orphan', 'wrapper-dead-supervisor', 'wrapper-stuck-supervisor'):
        def forbidden(*_args):
            (directory / 'parent-killpg').touch()
            raise AssertionError('parent must never signal a process group')
        os.killpg = forbidden
    start = time.monotonic()
    status = 0
    try:
        if mode.startswith('wrapper-nested'):
            env = dict(os.environ, TMPDIR=str(directory), PATH=str(directory) + os.pathsep + os.environ['PATH'],
                       FIXTURE_CLEANUP='stuck' if mode.endswith('stuck') else 'slow')
            command = ['node', str(Path(__file__).with_name('nested-gate.mjs')), str(directory)]
            cwd = Path(script).parent.parent
        elif mode == 'wrapper-compose':
            env = dict(os.environ, TMPDIR=str(directory), PATH=str(directory) + os.pathsep + os.environ['PATH'])
            command = ['sh', 'ci/run_schematics.sh']
            cwd = Path(script).parent.parent
        elif mode in ('wrapper-boundary', 'wrapper-orphan', 'wrapper-dead-supervisor', 'wrapper-stuck-supervisor'):
            env = os.environ
            command = [sys.executable, __file__, 'exiting-leader', str(directory), script]
            cwd = directory
        else:
            env = os.environ
            command = [sys.executable, __file__, 'compose', str(directory), script]
            cwd = directory
        ci.run(command, cwd, env, directory / 'child.log')
    except ci.Failed as error:
        status = error.status
    print(f'wall_elapsed_sec={time.monotonic() - start:.2f}\nWORKFLOW_EXIT={status}', flush=True)
    sys.exit(status)
elif mode == 'exiting-leader':
    subprocess.Popen([sys.executable, __file__, 'observed-descendant', str(directory), script])
    while not (directory / 'descendant-ready').exists():
        time.sleep(0.01)
    sys.exit(37)
elif mode == 'observed-descendant':
    def observe(signum, _frame):
        (directory / 'descendant-signal').write_text(signal.Signals(signum).name)
    signal.signal(signal.SIGINT, observe)
    signal.signal(signal.SIGTERM, observe)
    (directory / 'descendant-ready').write_text(str(os.getpid()))
    deadline = time.monotonic() + 3 if (directory / 'expire').exists() else None
    while True:
        if deadline is not None and time.monotonic() >= deadline:
            sys.exit(0)
        time.sleep(1)
elif mode == 'compose':
    def cleanup(signum, _frame):
        (directory / 'cleanup').write_text(signal.Signals(signum).name)
        # Simulate a Compose down operation completing before the deadline.
        time.sleep(0.1)
        (directory / 'cleanup-done').touch()
        sys.exit(0)
    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)
    subprocess.Popen([sys.executable, __file__, 'descendant', str(directory), script])
    while not (directory / 'descendant-ready').exists():
        time.sleep(0.01)
    (directory / 'ready').write_text(str(os.getpid()))
    while True:
        time.sleep(1)
elif mode == 'descendant':
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    (directory / 'descendant-ready').write_text(str(os.getpid()))
    while True:
        time.sleep(1)
