import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('isolated_ci', ROOT / 'scripts/run_isolatedci.py')
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class WorkflowTests(unittest.TestCase):
    def test_reaped_child_boundary_and_normal_orphan_cleanup(self):
        harness = ROOT / 'test/fixtures/isolated-ci/signal-harness.py'
        script = ROOT / 'scripts/run_isolatedci.py'
        for mode, signum in (('wrapper-boundary', signal.SIGTERM),
                             ('wrapper-boundary', signal.SIGINT), ('wrapper-orphan', None),
                             ('wrapper-dead-supervisor', signal.SIGTERM)):
            with self.subTest(mode=mode, signal=signum), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                                             start_new_session=True)
                wrapper = subprocess.Popen([sys.executable, '-B', str(harness), mode, tmp, str(script)],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    if signum:
                        deadline = time.monotonic() + 5
                        while not (directory / 'reaped').exists() and time.monotonic() < deadline:
                            self.assertIsNone(wrapper.poll())
                            time.sleep(0.01)
                        self.assertTrue((directory / 'reaped').exists())
                        self.assertIn('Child reaped, result=37', (directory / 'child.log').read_text())
                        wrapper.send_signal(signum)
                        wrapper.send_signal(signum)
                        (directory / 'release').touch()
                    out, err = wrapper.communicate(timeout=5)
                    self.assertEqual(wrapper.returncode, 128 + signum if signum else 37, out + err)
                    self.assertFalse((directory / 'parent-killpg').exists())
                    self.assertIsNone(unrelated.poll())
                    log = (directory / 'child.log').read_text()
                    if mode == 'wrapper-dead-supervisor':
                        self.assertFalse((directory / 'descendant-signal').exists())
                        self.assertIn('Supervisor exited unexpectedly', err)
                    elif signum:
                        self.assertEqual((directory / 'descendant-signal').read_text(), signal.Signals(signum).name)
                        self.assertIn('Cleanup grace ended; killing owned group', log)
                    else:
                        self.assertIn('Normal completion; killing remaining owned group members', log)
                    pid = int((directory / 'descendant-ready').read_text())
                    for _ in range(400):
                        try:
                            state = Path(f'/proc/{pid}/stat').read_text().split()[2]
                        except FileNotFoundError:
                            break
                        if state == 'Z':
                            break
                        time.sleep(0.01)
                    else:
                        self.fail('owned descendant survived group cleanup')
                finally:
                    if wrapper.poll() is None:
                        wrapper.send_signal(signal.SIGTERM)
                        (directory / 'release').touch()
                        wrapper.wait(timeout=5)
                    unrelated.terminate()
                    unrelated.wait()

    def test_normal_exit_codes_and_empty_group_are_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            started = time.monotonic()
            with mock.patch.object(os, 'killpg', side_effect=AssertionError('parent signalled a group')):
                ci.run([sys.executable, '-c', 'pass'], directory, os.environ, directory / 'success.log')
                for code in (37, -signal.SIGTERM):
                    program = (f'import os,signal; os.kill(os.getpid(), {signal.SIGTERM})'
                               if code < 0 else f'raise SystemExit({code})')
                    with self.assertRaises(ci.Failed) as failure:
                        ci.run([sys.executable, '-c', program], directory, os.environ, directory / f'{code}.log')
                    self.assertEqual(failure.exception.status, 128 - code if code < 0 else code)
                with self.assertRaises(ci.Failed) as failure:
                    ci.run(['/nonexistent-isolated-ci-command'], directory, os.environ, directory / 'missing.log')
                self.assertIn('could not start', str(failure.exception))
            self.assertLess(time.monotonic() - started, 5)

    def test_refuses_sigchld_auto_reaping(self):
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(signal, 'getsignal', return_value=signal.SIG_IGN):
            with self.assertRaisesRegex(ci.Failed, 'default SIGCHLD'):
                ci.run([sys.executable, '-c', 'pass'], Path(tmp), os.environ, Path(tmp) / 'log')

    def test_supervisor_refuses_to_signal_an_unowned_group(self):
        result = subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/run_isolatedci.py'),
                                 '--supervise', '0', '1', '0.1', sys.executable, '-c', 'pass'],
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('must be its own session and process-group leader', result.stderr)

    @unittest.skipUnless(hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'requires Linux pidfds')
    def test_unresponsive_supervisor_is_bounded_without_group_signal(self):
        harness = ROOT / 'test/fixtures/isolated-ci/signal-harness.py'
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                                         start_new_session=True)
            wrapper = subprocess.Popen([sys.executable, '-B', str(harness), 'wrapper-stuck-supervisor',
                                        tmp, str(ROOT / 'scripts/run_isolatedci.py')],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            started = time.monotonic()
            pidfd = None
            try:
                pid_file = directory / 'supervisor-pid'
                while (not pid_file.exists() or not pid_file.read_text()) and time.monotonic() - started < 4:
                    self.assertIsNone(wrapper.poll())
                    time.sleep(0.01)
                self.assertTrue(pid_file.exists() and pid_file.read_text())
                pidfd = os.pidfd_open(int(pid_file.read_text()))
                (directory / 'armed').touch()
                out, err = wrapper.communicate(timeout=9)
                self.assertEqual(wrapper.returncode, 1, out + err)
                self.assertIn('Supervisor unresponsive', err)
                self.assertGreaterEqual(time.monotonic() - started, 5)
                self.assertLess(time.monotonic() - started, 9)
                self.assertFalse((directory / 'parent-killpg').exists())
                self.assertFalse((directory / 'descendant-signal').exists())
                self.assertIsNone(unrelated.poll())
            finally:
                if pidfd is not None:
                    try:
                        signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    os.close(pidfd)
                if wrapper.poll() is None:
                    wrapper.kill()
                    wrapper.wait()
                unrelated.terminate()
                unrelated.wait()

    def test_real_wrapper_honors_caller_ignore_policy_and_cleans_npm_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo, home, parent, tools = (base / name for name in ('repo', 'home', 'work', 'tools'))
            for directory in (repo, home, parent, tools, repo / 'ci', repo / 'scripts'):
                directory.mkdir()
            for name in ('ci/quality_gate.mjs', 'ci/snapshot_checkout.mjs', 'scripts/run_isolatedci.py'):
                shutil.copy2(ROOT / name, repo / name)
            (repo / 'ci/npm-lock.json').write_text('{}')
            (repo / '.gitignore').write_text('repo-secret\npackage-lock.json\ntracked secret\n')
            for name in ('repo-secret', 'info-secret', 'global secret', 'package-lock.json'):
                (repo / name).write_text('fixture-secret-must-not-copy')
            (repo / 'visible file').write_text('untracked')
            (repo / 'tracked secret').write_text('staged')
            global_ignore = base / 'global ignore'
            global_ignore.write_text('global secret\n')
            config = home / '.gitconfig'
            config.write_text('[core]\n\texcludesFile = "' + str(global_ignore) + '"\n')
            env = dict(os.environ, HOME=str(home), GIT_CONFIG_GLOBAL=str(config), GIT_CONFIG_NOSYSTEM='1',
                       FIXTURE_CREDENTIAL='fixture-credential', HTTP_PROXY='http://user:password@invalid',
                       PATH=str(tools) + os.pathsep + os.environ.get('PATH', os.defpath))
            def git(*args):
                return subprocess.run(['git', *args], cwd=repo, env=env, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            git('init', '-q')
            (repo / '.git/info/exclude').write_text('info-secret\n')
            git('add', '-f', 'tracked secret')
            (repo / 'tracked secret').write_text('unstaged')
            before = (repo / '.git/index').read_bytes()
            npm = tools / 'npm'
            shutil.copyfile(ROOT / 'test/fixtures/isolated-ci/fake-npm', npm)
            npm.chmod(0o700)
            result = subprocess.run([sys.executable, '-B', str(repo / 'scripts/run_isolatedci.py'), 'install',
                                     '--workspace-parent', str(parent)], cwd=repo, env=env, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            workspace = next(parent.iterdir())
            checkout = workspace / 'checkout'
            recorded = json.loads((checkout / 'npm-result.json').read_text())
            self.assertEqual(recorded, {'ignored_present': [], 'visible': 'untracked', 'tracked': 'unstaged',
                                        'credential_present': False, 'git_config_clean': True, 'private_home': True,
                                        'npm_config_empty': True, 'lock_is_ci': True})
            for file in checkout.rglob('*'):
                if file.is_file() and '.git' not in file.relative_to(checkout).parts:
                    self.assertNotIn(b'fixture-secret-must-not-copy', file.read_bytes())
            self.assertEqual((repo / '.git/index').read_bytes(), before)
            self.assertEqual(config.read_text(), '[core]\n\texcludesFile = "' + str(global_ignore) + '"\n')
            local_ignore = base / 'local ignore'
            local_ignore.write_text('global secret\nlocal-secret\n')
            (repo / 'local-secret').write_text('fixture-secret-must-not-copy')
            git('config', '--local', 'core.excludesFile', str(local_ignore))
            local_run = subprocess.run([sys.executable, '-B', str(repo / 'scripts/run_isolatedci.py'), 'install',
                                        '--workspace-parent', str(parent)], cwd=repo, env=env, text=True,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
            self.assertEqual(local_run.returncode, 0, local_run.stdout + local_run.stderr)
            local_workspace = next(p for p in parent.iterdir() if p != workspace)
            self.assertFalse((local_workspace / 'checkout/local-secret').exists())
            git('config', '--local', '--unset', 'core.excludesFile')
            # A configured but unavailable ignore file must fail before npm.
            global_ignore.unlink()
            failed = subprocess.run([sys.executable, '-B', str(repo / 'scripts/run_isolatedci.py'), 'install',
                                     '--workspace-parent', str(parent)], cwd=repo, env=env, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
            self.assertNotEqual(failed.returncode, 0)
            latest = next(p for p in parent.iterdir() if p not in (workspace, local_workspace))
            self.assertFalse((latest / 'npm-ci.log').exists())
            self.assertIn('Cannot read Git ignore policy', (latest / 'snapshot.log').read_text())

    def test_signals_forward_cleanup_and_escalate_without_touching_unrelated_processes(self):
        harness = ROOT / 'test/fixtures/isolated-ci/signal-harness.py'
        script = ROOT / 'scripts/run_isolatedci.py'
        for signum in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=signum), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
                wrapper = subprocess.Popen([sys.executable, '-B', str(harness), 'wrapper', tmp, str(script)],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    for _ in range(300):
                        if (directory / 'ready').exists():
                            break
                        if wrapper.poll() is not None:
                            self.fail('wrapper exited before fixture started')
                        time.sleep(0.01)
                    self.assertTrue((directory / 'ready').exists())
                    descendant = int((directory / 'descendant-ready').read_text())
                    wrapper.send_signal(signum)
                    wrapper.send_signal(signum)  # reentrant delivery must not skip cleanup
                    out, err = wrapper.communicate(timeout=5)
                    self.assertEqual(wrapper.returncode, 128 + signum, out + err)
                    self.assertIn(f'WORKFLOW_EXIT={128 + signum}', out)
                    self.assertIn('wall_elapsed_sec=', out)
                    self.assertEqual((directory / 'cleanup').read_text(), signal.Signals(signum).name)
                    self.assertTrue((directory / 'cleanup-done').exists())
                    self.assertIsNone(unrelated.poll())
                    for _ in range(100):
                        stat = Path(f'/proc/{descendant}/stat')
                        if not stat.exists() or stat.read_text().split()[2] == 'Z':
                            break
                        time.sleep(0.01)
                    else:
                        self.fail('descendant survived escalation')
                finally:
                    if wrapper.poll() is None:
                        wrapper.kill()
                        wrapper.wait()
                    unrelated.terminate()
                    unrelated.wait()

    def test_signal_runs_real_compose_cleanup_trap_and_records_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            docker = directory / 'docker'
            shutil.copyfile(ROOT / 'test/fixtures/isolated-ci/fake-docker', docker)
            docker.chmod(0o700)
            wrapper = subprocess.Popen([sys.executable, '-B', str(ROOT / 'test/fixtures/isolated-ci/signal-harness.py'),
                                        'wrapper-compose', tmp, str(ROOT / 'scripts/run_isolatedci.py')],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                for _ in range(300):
                    if (directory / 'compose-ready').exists():
                        break
                    if wrapper.poll() is not None:
                        self.fail('Compose fixture exited before signal')
                    time.sleep(0.01)
                self.assertTrue((directory / 'compose-ready').exists())
                wrapper.send_signal(signal.SIGTERM)
                out, err = wrapper.communicate(timeout=5)
                self.assertEqual(wrapper.returncode, 143, out + err)
                self.assertTrue((directory / 'compose-down').exists())
                self.assertIn('Cleanup failed for Compose project', (directory / 'child.log').read_text())
            finally:
                if wrapper.poll() is None:
                    wrapper.kill()
                    wrapper.wait()

    def test_nested_gate_allows_slow_compose_and_bounds_stuck_cleanup(self):
        self.assertGreaterEqual(ci.GRACE_SECONDS, 25)
        harness = ROOT / 'test/fixtures/isolated-ci/signal-harness.py'
        for signum, stuck in ((signal.SIGTERM, False), (signal.SIGINT, False), (signal.SIGTERM, True)):
            with self.subTest(signal=signum, stuck=stuck), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                docker = directory / 'docker'
                shutil.copyfile(ROOT / 'test/fixtures/isolated-ci/nested-docker', docker)
                docker.chmod(0o700)
                unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
                wrapper = subprocess.Popen([sys.executable, '-B', str(harness),
                                            'wrapper-nested-stuck' if stuck else 'wrapper-nested',
                                            tmp, str(ROOT / 'scripts/run_isolatedci.py')],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                def await_file(name):
                    for _ in range(500):
                        if (directory / name).exists():
                            return
                        if wrapper.poll() is not None:
                            self.fail(f'wrapper exited before {name}')
                        time.sleep(0.01)
                    self.fail(f'timed out waiting for {name}')
                try:
                    await_file('up-ready')
                    started = time.monotonic()
                    wrapper.send_signal(signum)
                    await_file('down-start')
                    wrapper.send_signal(signum)  # Repeated delivery must not abort cleanup.
                    out, err = wrapper.communicate(timeout=33)
                    elapsed = time.monotonic() - started
                    self.assertEqual(wrapper.returncode, 128 + signum, out + err)
                    self.assertIn(f'WORKFLOW_EXIT={128 + signum}', out)
                    self.assertIn('wall_elapsed_sec=', out)
                    nested_log = (directory / 'child.log').read_text()
                    self.assertIn(f'NESTED_EXIT={128 + signum}', nested_log)
                    nested_seconds = float(next(line.split('=', 1)[1] for line in nested_log.splitlines()
                                                if line.startswith('NESTED_CLEANUP_SECONDS=')))
                    self.assertEqual((directory / 'up-signal').read_text(), signal.Signals(signum).name)
                    self.assertIsNone(unrelated.poll())
                    self.assertGreaterEqual(elapsed, ci.GRACE_SECONDS)
                    self.assertLess(elapsed, 33)
                    if stuck:
                        self.assertGreaterEqual(nested_seconds, 15)
                        self.assertLess(nested_seconds, 22)
                        self.assertFalse((directory / 'down-done').exists())
                        pid = int((directory / 'down-start').read_text())
                        stat = Path(f'/proc/{pid}/stat')
                        self.assertTrue(not stat.exists() or stat.read_text().split()[2] == 'Z')
                    else:
                        self.assertGreater(nested_seconds, 6.2)
                        self.assertLess(nested_seconds, 12)
                        self.assertEqual((directory / 'down-done').read_text(), (directory / 'up-ready').read_text())
                finally:
                    if wrapper.poll() is None:
                        # Ask the owned wrapper to clean up; never signal a
                        # numeric group inferred from a racy procfs inspection.
                        wrapper.send_signal(signal.SIGTERM)
                        try:
                            wrapper.wait(timeout=30)
                        except subprocess.TimeoutExpired:
                            wrapper.kill()
                            wrapper.wait()
                    unrelated.terminate()
                    unrelated.wait()

    def test_real_wrapper_reports_sigterm_status_and_timing(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            repo, parent, home, tools = (base / name for name in ('repo', 'work', 'home', 'bin'))
            for directory in (repo, parent, home, tools, repo / 'ci', repo / 'scripts'):
                directory.mkdir()
            for name in ('ci/quality_gate.mjs', 'ci/snapshot_checkout.mjs', 'scripts/run_isolatedci.py'):
                shutil.copyfile(ROOT / name, repo / name)
            (repo / 'ci/npm-lock.json').write_text('{}')
            npm = tools / 'npm'
            shutil.copyfile(ROOT / 'test/fixtures/isolated-ci/blocking-npm', npm)
            npm.chmod(0o700)
            env = dict(os.environ, HOME=str(home), GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                       PATH=str(tools) + os.pathsep + os.environ.get('PATH', os.defpath))
            subprocess.run(['git', 'init', '-q', str(repo)], env=env, check=True)
            wrapper = subprocess.Popen([sys.executable, '-B', str(repo / 'scripts/run_isolatedci.py'),
                                        'install', '--workspace-parent', str(parent)], cwd=repo, env=env,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                for _ in range(500):
                    workspaces = list(parent.iterdir())
                    if workspaces and (workspaces[0] / 'tmp/npm-ready').exists():
                        break
                    if wrapper.poll() is not None:
                        self.fail('wrapper exited before npm fixture started')
                    time.sleep(0.01)
                self.assertTrue(workspaces and (workspaces[0] / 'tmp/npm-ready').exists())
                wrapper.send_signal(signal.SIGTERM)
                out, err = wrapper.communicate(timeout=35)
                self.assertEqual(wrapper.returncode, 143, out + err)
                self.assertIn('WORKFLOW_EXIT=143', out)
                self.assertIn('wall_elapsed_sec=', out)
                self.assertEqual((workspaces[0] / 'tmp/npm-cleanup').read_text(), 'SIGTERM')
            finally:
                if wrapper.poll() is None:
                    wrapper.kill()
                    wrapper.wait()

    def test_environment_isolation(self):
        with mock.patch.dict(os.environ, {'PATH': '/bin', 'NPM_CONFIG_SCRIPT_SHELL': '/evil',
                                        'PIP_CONFIG_FILE': '/evil', 'DOCKER_CONTEXT': 'remote', 'COMPOSE_PROFILES': 'evil',
                                        'GIT_INDEX_FILE': '/evil', 'PYTHONPATH': '/evil',
                                        'NODE_OPTIONS': '--require=evil', 'OPENAI_API_KEY': 'secret'}, clear=True):
            env = ci.clean_environment(Path('/private'))
        for name in ('NPM_CONFIG_SCRIPT_SHELL', 'PIP_CONFIG_FILE', 'DOCKER_CONTEXT', 'COMPOSE_PROFILES',
                     'GIT_INDEX_FILE', 'PYTHONPATH', 'NODE_OPTIONS', 'OPENAI_API_KEY'):
            self.assertNotIn(name, env)
        self.assertEqual(env['DOCKER_HOST'], 'unix:///var/run/docker.sock')
        self.assertEqual(env['NPM_CONFIG_CACHE'], '/private/npm-cache')

    def test_experiment_uses_clean_environment_for_every_npm_operation(self):
        with mock.patch.dict(sys.modules, {'run_isolatedci': ci}):
            spec = importlib.util.spec_from_file_location('experiment', ROOT / 'scripts/experiment_nodegyp.py')
            experiment = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(experiment)
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.dict(os.environ, {'EXPERIMENT_TOKEN': 'secret', 'AWS_SECRET_ACCESS_KEY': 'secret',
                                         'HTTP_PROXY': 'http://user:password@invalid', 'NPM_CONFIG_TOKEN': 'secret'}, clear=False), \
             mock.patch.object(sys, 'argv', ['experiment_nodegyp.py', '--workspace-parent', tmp, '--node-gyp', '12.3.0']):
            calls = []
            def snapshot(destination, env):
                (destination / 'ci').mkdir()
                (destination / 'ci/npm-lock.json').write_text('{}')
                (destination / 'package.json').write_text('{"overrides":{"gl":{}}}')
                self.assertNotIn('EXPERIMENT_TOKEN', env)
            def run(command, _cwd, env, _log, allowed=(0,)):
                calls.append(command[1])
                for name in ('EXPERIMENT_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'HTTP_PROXY', 'NPM_CONFIG_TOKEN'):
                    self.assertNotIn(name, env)
                self.assertEqual(env['GIT_CONFIG_GLOBAL'], os.devnull)
                self.assertTrue(env['HOME'].endswith('/home'))
                self.assertEqual(Path(env['NPM_CONFIG_USERCONFIG']).read_text(), '')
            def audit(_command, **kwargs):
                self.assertNotIn('EXPERIMENT_TOKEN', kwargs['env'])
                kwargs['stdout'].write('{"metadata":{"vulnerabilities":{"total":0}}}')
                return subprocess.CompletedProcess([], 0)
            with mock.patch.object(experiment, 'snapshot', side_effect=snapshot), \
                 mock.patch.object(experiment, 'run', side_effect=run), \
                 mock.patch.object(experiment.subprocess, 'run', side_effect=audit), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(experiment.main(), 0)
            self.assertEqual(calls, ['install', 'ci', 'rebuild', 'ls', '-e'])

    def test_failure_exit_and_private_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / 'failure.log'
            with self.assertRaises(ci.Failed) as failed:
                ci.run([sys.executable, '-c', 'print("fixture"); raise SystemExit(23)'], tmp, os.environ, log)
            self.assertEqual(failed.exception.status, 23)
            self.assertIn('fixture', log.read_text())
            with self.assertRaises(FileExistsError):
                ci.run([sys.executable, '-c', 'pass'], tmp, os.environ, log)

    def test_action_parity_and_monotonic_status(self):
        fixtures = json.loads((ROOT / 'test/fixtures/isolated-ci/actions.json').read_text())
        for action, expected in fixtures.items():
            with self.subTest(action=action), tempfile.TemporaryDirectory() as tmp:
                calls = []
                def run(command, cwd, env, log):
                    executable = Path(command[0]).name
                    label = 'python' if executable.startswith('python') else executable
                    if command[:2] == ['sh', 'ci/run_schematics.sh']:
                        label = 'sh:live'
                    elif command[:2] == ['sh', 'ci/run_quality_gate.sh']:
                        self.assertEqual(command[2:], ['full', '--jobs', '2'])
                        label = 'sh:full'
                    elif 'test/schematic/pack_cache_tests.py' in command:
                        label = 'python:cache'
                    elif 'test/schematic/build_pack.test.js' in command:
                        label = 'node:cache'
                    calls.append(label)
                    if command[0] == 'node' and 'ci/snapshot_checkout.mjs' in command:
                        directory = Path(command[-1]) / 'ci'
                        directory.mkdir()
                        (directory / 'npm-lock.json').write_text('{}')
                def compose(*_args):
                    calls.append('compose-setup')
                output = io.StringIO()
                with mock.patch.object(sys, 'argv', ['run_isolatedci.py', action, '--workspace-parent', tmp]), \
                     mock.patch.object(ci, 'run', side_effect=run), mock.patch.object(ci, 'setup_compose', side_effect=compose), \
                     mock.patch.object(ci.time, 'monotonic', side_effect=[10, 12.5]), contextlib.redirect_stdout(output):
                    self.assertEqual(ci.main(), 0)
                self.assertEqual(calls, expected)
                self.assertIn('wall_elapsed_sec=2.50\nWORKFLOW_EXIT=0', output.getvalue())

    def test_setup_failure_propagates_with_timing(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(sys, 'argv', ['run_isolatedci.py', 'full', '--workspace-parent', tmp]), \
             mock.patch.object(ci, 'run', side_effect=ci.Failed('fixture', 23)), \
             mock.patch.object(ci.time, 'monotonic', side_effect=[100, 101.25]), \
             contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(ci.main(), 23)
            self.assertIn('wall_elapsed_sec=1.25\nWORKFLOW_EXIT=23', out.getvalue())

    def test_compose_checksum_failure_and_platform_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(ci.platform, 'system', return_value='Darwin'):
                with self.assertRaisesRegex(ci.Failed, 'Linux x86_64'):
                    ci.setup_compose(Path(tmp), {}, Path(tmp))
            with mock.patch.object(ci.platform, 'system', return_value='Linux'), \
                 mock.patch.object(ci.platform, 'machine', return_value='x86_64'), \
                 mock.patch.object(ci.urllib.request, 'urlopen', return_value=io.BytesIO(b'wrong')), \
                 mock.patch.object(ci, 'run') as run:
                with self.assertRaisesRegex(ci.Failed, 'SHA-256 mismatch'):
                    ci.setup_compose(Path(tmp), {}, Path(tmp))
                run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
