#!/usr/bin/env python3
"""Exercise cache logic with an explicit fixture and a deterministic fake runtime."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from pack_cache_fixture import compile_fixture

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('build_pack', ROOT / 'schematics/tooling/build_pack.py')
build_pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_pack)
real_docker = build_pack.docker


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pack-cache-test-')
        self.root = Path(self.temp.name)
        self.source = self.root / 'schematics/blueprints/pack2/one.json'
        self.source.parent.mkdir(parents=True)
        shutil.copyfile(ROOT / 'test/fixtures/pack-cache/one.json', self.source)
        tools = self.root / 'schematics/tooling'
        tools.mkdir(parents=True)
        for name in build_pack.TOOLS:
            shutil.copyfile(ROOT / 'schematics/tooling' / name, tools / name)
        (tools / 'block_history/generated').mkdir(parents=True)
        (tools / 'block_history/generated/index.json').write_text('{"releases":[{"release":"1.21.4","data_version":4189}]}\n')
        self.image = 'sha256:' + 'a' * 64
        self.calls = self.root / 'calls'
        self.original_root = build_pack.ROOT
        build_pack.ROOT = self.root
        self.patches = [patch.object(build_pack, 'container_runtime', side_effect=lambda image: {'image': image, 'policy': 1, 'architecture': 'amd64'}),
                        patch.object(build_pack, 'docker', side_effect=self.fake_docker)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        build_pack.ROOT = self.original_root
        for directory, dirs, files in os.walk(self.root):
            Path(directory).chmod(0o700)
            for name in files:
                path = Path(directory) / name
                if not path.is_symlink():
                    path.chmod(0o600)
        self.temp.cleanup()

    def fake_docker(self, *args):
        self.assertIn('--network=none', args)
        self.assertIn('--read-only', args)
        self.assertIn('--cap-drop=ALL', args)
        self.assertIn('--pull=never', args)
        self.assertIn(self.image, args)
        mount = next(arg for arg in args if arg.startswith('type=bind,src=') and arg.endswith(',dst=/work,readonly'))
        snapshot = Path(mount[len('type=bind,src='):-len(',dst=/work,readonly')])
        with self.calls.open('a') as stream:
            stream.write('compile\n')
        time.sleep(0.1)
        compile_fixture(snapshot, 'pack2', '1.21.4', '--allow-unverified' in args)
        return 'compiled\n'

    def run_build(self, image=None, backend='container', unverified=False):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            build_pack.build('pack2', '1.21.4', unverified, backend, image or self.image)
        return json.loads(out.getvalue())

    def build_path(self, result):
        return self.root / result['build']

    def make_writable(self, build):
        for directory, _, files in os.walk(build):
            Path(directory).chmod(0o700)
            for name in files:
                path = Path(directory) / name
                if not path.is_symlink():
                    path.chmod(0o600)

    def test_cold_hit_edits_reverts_names_runtime_and_no_mutation(self):
        original = self.source.read_bytes()
        first = self.run_build()
        self.assertFalse(first['reuse'])
        self.assertTrue(self.run_build()['reuse'])
        self.assertEqual(self.calls.read_text().count('compile'), 1)
        old = self.source.stat()
        self.source.write_bytes(original + b'\n')
        os.utime(self.source, ns=(old.st_atime_ns, old.st_mtime_ns))
        edited = self.run_build()
        self.assertFalse(edited['reuse'])
        extra = self.source.with_name('two.json')
        extra.write_bytes(original)
        self.assertFalse(self.run_build()['reuse'])
        extra.unlink()
        self.assertEqual(self.run_build()['build'], edited['build'])
        self.source.write_bytes(original)
        self.assertEqual(self.run_build()['build'], first['build'])
        self.image = 'sha256:' + 'b' * 64
        self.assertFalse(self.run_build()['reuse'])
        self.assertTrue(self.run_build()['reuse'])
        self.assertFalse(self.run_build(unverified=True)['reuse'])
        tool = self.root / 'schematics/tooling/history_registry.mjs'
        tool.write_text(tool.read_text() + '\n')
        self.assertFalse(self.run_build()['reuse'])
        index = self.root / 'schematics/tooling/block_history/generated/index.json'
        index.write_text(index.read_text() + '\n')
        self.assertFalse(self.run_build()['reuse'])
        self.assertEqual(self.source.read_bytes(), original)
        self.assertFalse((self.root / 'schematics/schems').exists())

    def test_corruption_is_never_reused_or_overwritten(self):
        for corruption in ('receipt', 'report', 'artifact', 'missing', 'extra', 'symlink', 'hardlink'):
            with self.subTest(corruption=corruption):
                first = self.run_build()
                build = self.build_path(first)
                self.make_writable(build)
                output = build / 'snapshot/schematics/schems/pack2'
                artifact = output / 'one.mc1.21.4.schem'
                if corruption == 'receipt':
                    (build / 'manifest.json').write_text('{')
                elif corruption == 'report':
                    (output / 'conversion.mc1.21.4.json').write_text('{}')
                elif corruption == 'artifact':
                    artifact.write_bytes(b'changed')
                elif corruption == 'missing':
                    artifact.unlink()
                elif corruption == 'extra':
                    (output / 'extra').mkdir()
                elif corruption == 'symlink':
                    artifact.unlink()
                    artifact.symlink_to(self.source)
                else:
                    os.link(artifact, output / 'hardlink')
                rebuilt = self.run_build()
                self.assertFalse(rebuilt['reuse'])
                self.assertNotEqual(first['build'], rebuilt['build'])
                self.assertTrue(build.exists())
                self.assertTrue(self.run_build()['reuse'])

    def test_report_semantics_checked_even_if_inventory_is_rewritten(self):
        first = self.run_build()
        build = self.build_path(first)
        self.make_writable(build)
        output = build / 'snapshot/schematics/schems/pack2'
        report_path = output / 'conversion.mc1.21.4.json'
        report = json.loads(report_path.read_text())
        report['entries'][0]['schematic'] = 'wrong.schem'
        report_path.write_text(json.dumps(report) + '\n')
        metadata_path = output / 'one.mc1.21.4.schem.provenance.json'
        metadata = json.loads(metadata_path.read_text())
        metadata['packReportSha256'] = hashlib.sha256(report_path.read_bytes()).hexdigest()
        metadata_path.write_text(json.dumps(metadata) + '\n')
        (output / 'one.mc1.21.4.schem.provenance.sha256').write_text(hashlib.sha256(metadata_path.read_bytes()).hexdigest() + '\n')
        manifest_path = build / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['tree'] = {name: value for name, value in build_pack.tree_inventory(build).items() if name != 'manifest.json'}
        manifest_path.write_text(json.dumps(manifest))
        self.assertFalse(self.run_build()['reuse'])

    def test_input_links_and_lock_links_are_rejected(self):
        original = self.source.read_bytes()
        other = self.source.with_name('other')
        other.write_bytes(original)
        self.source.unlink()
        self.source.symlink_to(other)
        with self.assertRaises(OSError):
            self.run_build()
        self.source.unlink()
        os.link(other, self.source)
        with self.assertRaises(ValueError):
            self.run_build()
        self.source.unlink()
        self.source.write_bytes(original)
        lock = self.root / '.schematic-builds/pack2/.lock'
        lock.unlink()
        lock.symlink_to(other)
        with self.assertRaises(OSError):
            self.run_build()
        self.assertEqual(other.read_bytes(), original)

    def test_rejects_mutable_image_references_and_remote_overrides(self):
        # Run the actual CLI from the disposable fixture checkout. Never mutate
        # the parent environment, and do not depend on the caller's Docker setup.
        env = os.environ.copy()
        for name in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'):
            env.pop(name, None)
        env['DOCKER_CONFIG'] = str(ROOT / 'test/fixtures/pack-cache/docker-config')
        scenarios = [
            ('mutable image, no override', 'latest', {}, 'container image must be an inspected full sha256 image ID'),
            ('remote host', self.image, {'DOCKER_HOST': 'tcp://example.invalid:2375'}, 'Docker overrides are not allowed for the local cache backend'),
            ('local host override', self.image, {'DOCKER_HOST': 'unix:///var/run/docker.sock'}, 'Docker overrides are not allowed for the local cache backend'),
            ('remote context', self.image, {'DOCKER_CONTEXT': 'remote'}, 'Docker overrides are not allowed for the local cache backend'),
            ('TLS verification override', self.image, {'DOCKER_TLS_VERIFY': '1'}, 'Docker overrides are not allowed for the local cache backend'),
            ('certificate override', self.image, {'DOCKER_CERT_PATH': '/example/certs'}, 'Docker overrides are not allowed for the local cache backend'),
            ('override precedes image validation', 'latest', {'DOCKER_HOST': 'tcp://example.invalid:2375'}, 'Docker overrides are not allowed for the local cache backend'),
        ]
        for label, image, overrides, message in scenarios:
            with self.subTest(scenario=label):
                result = subprocess.run(
                    [sys.executable, '-B', 'schematics/tooling/build_pack.py', 'build', '--pack', 'pack2',
                     '--target-version', '1.21.4', '--backend', 'container', '--image', image],
                    cwd=self.root, env={**env, **overrides}, text=True, capture_output=True, check=False)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(result.stderr.strip(), f'ERROR: {message}')
                self.assertEqual(result.stdout, '')

    def test_docker_command_uses_only_local_socket_and_isolated_config(self):
        result = SimpleNamespace(returncode=0, stdout='ok', stderr='')
        with patch.object(build_pack.subprocess, 'run', return_value=result) as run:
            self.assertEqual(real_docker('info'), 'ok')
        args, kwargs = run.call_args
        self.assertEqual(args[0], ['docker', '--host', 'unix:///var/run/docker.sock', 'info'])
        self.assertEqual(kwargs['env'], {'PATH': os.defpath, 'HOME': '/nonexistent', 'DOCKER_CONFIG': '/nonexistent'})

    def test_failed_container_does_not_fall_back(self):
        with patch.object(build_pack, 'docker', side_effect=ValueError('compiler failed')):
            with self.assertRaisesRegex(ValueError, 'compiler failed'):
                self.run_build()
        self.assertEqual([p.name for p in (self.root / '.schematic-builds/pack2').iterdir()], ['.lock'])

    def test_host_is_always_fresh(self):
        def run(command, **kwargs):
            snapshot = Path(kwargs['cwd'])
            compile_fixture(snapshot, 'pack2', '1.21.4')
            return SimpleNamespace(returncode=0, stdout='compiled\n')
        with patch.object(build_pack.subprocess, 'run', side_effect=run):
            one = self.run_build(backend='host')
            two = self.run_build(backend='host')
        self.assertFalse(one['reuse'])
        self.assertFalse(two['reuse'])
        self.assertNotEqual(one['build'], two['build'])
        self.assertFalse(self.calls.exists())

    def test_concurrent_builds_share_one_compilation(self):
        readers = []
        children = []
        for _ in range(2):
            read, write = os.pipe()
            pid = os.fork()
            if pid == 0:
                os.close(read)
                try:
                    result = self.run_build()
                    os.write(write, json.dumps(result).encode())
                    os._exit(0)
                except BaseException as error:
                    os.write(write, repr(error).encode())
                    os._exit(1)
            os.close(write)
            readers.append(read)
            children.append(pid)
        results = [os.read(fd, 10000).decode() for fd in readers]
        for fd in readers:
            os.close(fd)
        for pid in children:
            self.assertEqual(os.waitpid(pid, 0)[1], 0, results)
        summaries = [json.loads(result) for result in results]
        self.assertEqual(sorted(item['reuse'] for item in summaries), [False, True])
        self.assertEqual(summaries[0]['build'], summaries[1]['build'])
        self.assertEqual(self.calls.read_text().count('compile'), 1)


if __name__ == '__main__':
    unittest.main()
