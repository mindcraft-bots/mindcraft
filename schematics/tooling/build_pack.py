#!/usr/bin/env python3
"""List packs or compile an isolated pack; container reuse is explicit opt-in."""
import argparse
from contextlib import contextmanager
import ctypes
import fcntl
import hashlib
import json
import os
import platform
from pathlib import Path
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
PACK = re.compile(r"pack[1-9][0-9]*\Z")
VERSION = re.compile(r"[0-9]+(?:\.[0-9]+)+\Z")
TOOLS = ("compile_pack.py", "compile_blueprint.py", "convert_history.mjs",
         "history_registry.mjs", "block_history.v1.json", "build_pack.py")
CONTAINER_POLICY = 1
DOCKER_HOST = 'unix:///var/run/docker.sock'


def safe_dir(path, create=False):
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    mode = path.lstat().st_mode
    if not stat.S_ISDIR(mode) or path.is_symlink():
        raise ValueError(f"not a real directory: {path}")
    return path


def file_bytes(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ValueError(f"not a regular file: {path}")
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read()
        after = os.fstat(fd)
        if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError(f"file changed during snapshot: {path}")
        return data
    finally:
        os.close(fd)


def files_below(path):
    safe_dir(path)
    result = []
    for entry in sorted(path.iterdir()):
        mode = entry.lstat().st_mode
        if stat.S_ISDIR(mode):
            result.extend(files_below(entry))
        elif stat.S_ISREG(mode):
            result.append(entry)
        else:
            raise ValueError(f"unsafe input: {entry}")
    return result


def input_files(pack, root=None):
    if root is None:
        root = ROOT
    schematics = safe_dir(root / 'schematics')
    source = safe_dir(safe_dir(schematics / 'blueprints') / pack)
    tooling = safe_dir(schematics / 'tooling')
    sources = sorted(source.glob('*.json'))
    if not sources:
        raise ValueError(f'no blueprints in {pack}')
    files = sources + [tooling / name for name in TOOLS]
    files += files_below(safe_dir(safe_dir(tooling / 'block_history') / 'generated'))
    return files


def inventory(files, root):
    return {str(path.relative_to(root)): hashlib.sha256(file_bytes(path)).hexdigest() for path in files}


def private_directory(path):
    info = path.lstat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError(f'cache directory must be private and owned by the current user: {path}')


def docker(*args):
    # Ignore all Docker configuration and proxy variables, and never contact a
    # registry during a normal build. The socket must be the local default.
    result = subprocess.run(['docker', '--host', DOCKER_HOST, *args],
                            env={'PATH': os.defpath, 'HOME': '/nonexistent',
                                 'DOCKER_CONFIG': '/nonexistent'},
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)
    if result.returncode:
        raise ValueError(f'Docker failed ({result.returncode}): {result.stderr.strip()}')
    return result.stdout


def container_runtime(image):
    if any(os.environ.get(name) for name in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')):
        raise ValueError('Docker overrides are not allowed for the local cache backend')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image or ''):
        raise ValueError('container image must be an inspected full sha256 image ID')
    if os.getuid() == 0:
        raise ValueError('container cache requires an unprivileged user')
    sock = Path('/var/run/docker.sock')
    if not stat.S_ISSOCK(sock.stat().st_mode):
        raise ValueError('local Docker socket unavailable')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.connect(str(sock))
        pid, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    if pid <= 0 or uid != 0 or Path(f'/proc/{pid}/comm').read_text().strip() != 'dockerd':
        raise ValueError('Docker socket is not served by an identifiable local root daemon')
    info = json.loads(docker('info', '--format', '{{json .}}'))
    image_info = json.loads(docker('image', 'inspect', image))[0]
    machine = platform.machine()
    architectures = {'x86_64': 'amd64', 'aarch64': 'arm64'}
    arch = architectures.get(machine)
    if (not arch or info.get('Name') != platform.node() or
            info.get('KernelVersion') != platform.release() or
            info.get('OSType') != 'linux' or info.get('Architecture') != machine or
            image_info.get('Id') != image or image_info.get('Os') != 'linux' or
            image_info.get('Architecture') != arch or
            (image_info.get('Config', {}).get('Labels') or {}).get('org.mindcraft.schematic-compiler') != '1'):
        raise ValueError('unidentifiable, remote, emulated or unapproved Docker runtime/image')
    cpu = Path('/proc/cpuinfo').read_text(encoding='utf8')
    fields = ('vendor_id', 'cpu family', 'model', 'stepping', 'microcode', 'flags',
              'CPU implementer', 'CPU architecture', 'CPU variant', 'CPU part', 'CPU revision', 'Features')
    identities = sorted({line.strip() for line in cpu.splitlines() if ':' in line and line.split(':', 1)[0].strip() in fields})
    found = {line.split(':', 1)[0].strip() for line in identities}
    required = ({'vendor_id', 'cpu family', 'model', 'stepping', 'flags'} if arch == 'amd64'
                else {'CPU implementer', 'CPU architecture', 'CPU part', 'CPU revision', 'Features'})
    if not required.issubset(found):
        raise ValueError('CPU identity unavailable')
    if any('hypervisor' in line.split() for line in identities):
        raise ValueError('virtualized CPU is not an approved native runtime')
    return {'policy': CONTAINER_POLICY, 'image': image, 'architecture': arch,
            'kernel': platform.release(), 'kernelVersion': platform.version(),
            'cpu': identities, 'daemon': info['ID'], 'dockerVersion': info['ServerVersion'],
            'runtime': info['DefaultRuntime'], 'security': info['SecurityOptions'],
            'uid': os.getuid(), 'gid': os.getgid()}


def json_strict(data):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid JSON constant')))


def tree_inventory(root):
    """Record all files and directories, rejecting links and special files."""
    result = {}
    def visit(directory):
        safe_dir(directory)
        for path in sorted(directory.iterdir()):
            name = str(path.relative_to(root))
            mode = path.lstat().st_mode
            if stat.S_ISDIR(mode):
                result[name] = 'directory'
                visit(path)
            elif stat.S_ISREG(mode):
                result[name] = hashlib.sha256(file_bytes(path)).hexdigest()
            else:
                raise ValueError(f'unsafe cache entry: {path}')
    visit(root)
    return result


def verify_candidate(candidate, key, policy, runtime, digests, sources):
    safe_dir(candidate)
    manifest = json_strict(file_bytes(candidate / 'manifest.json'))
    if (not isinstance(manifest, dict) or set(manifest) != {'schema', 'key', 'policy', 'runtime', 'inputs', 'tree', 'compilerExit'} or
            manifest['schema'] != 2 or type(manifest['schema']) is not int or manifest['key'] != key or
            json.dumps(manifest['policy'], sort_keys=True) != json.dumps(policy, sort_keys=True) or
            json.dumps(manifest['runtime'], sort_keys=True) != json.dumps(runtime, sort_keys=True) or manifest['inputs'] != digests or
            type(manifest['compilerExit']) is not int or manifest['compilerExit'] != 0 or
            not isinstance(manifest['tree'], dict)):
        raise ValueError('invalid cache receipt')
    actual = tree_inventory(candidate)
    del actual['manifest.json']
    if actual != manifest['tree']:
        raise ValueError('cache inventory mismatch')
    snapshot = candidate / 'snapshot'
    if inventory(input_files(policy['pack'], snapshot), snapshot) != digests:
        raise ValueError('cache input mismatch')
    expected_files = {'build.log'} | {'snapshot/' + path for path in digests}
    output = snapshot / 'schematics' / 'schems' / policy['pack']
    verify_outputs(output, policy['pack'], policy['targetVersion'], policy['allowUnverified'], sources, digests)
    expected_files |= {'snapshot/' + str(path.relative_to(snapshot)) for path in files_below(output)}
    expected_dirs = set()
    for name in expected_files:
        parent = Path(name).parent
        while str(parent) != '.':
            expected_dirs.add(str(parent))
            parent = parent.parent
    if set(actual) != expected_files | expected_dirs:
        raise ValueError('unexpected cache files or directories')


def freeze_tree(root):
    for path in files_below(root):
        path.chmod(0o400)
    for directory, _, _ in os.walk(root, topdown=False, followlinks=False):
        Path(directory).chmod(0o500)


@contextmanager
def private_stage(parent):
    stage = Path(tempfile.mkdtemp(prefix='.stage-', dir=parent))
    identity = stage.lstat()
    try:
        yield stage
    except BaseException:
        try:
            current = stage.lstat()
            if stat.S_ISDIR(current.st_mode) and os.path.samestat(identity, current):
                for directory, _, _ in os.walk(stage):
                    Path(directory).chmod(0o700)
                shutil.rmtree(stage)
        except FileNotFoundError:
            pass
        raise


def rename_noreplace(source, destination):
    # Linux renameat2 is needed for atomic directory publication without replacement.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    if rename is None:
        raise OSError('atomic non-replacing directory rename is unavailable')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(destination))


def verify_outputs(output, pack, version, unverified, sources, inputs):
    label = '.nonvalidated' if unverified else ''
    report_name = f'conversion.mc{version}{label}.json'
    expected = {report_name}
    for source in sources:
        name = f'{source.stem}.mc{version}{label}.schem'
        expected.update((name, name + '.provenance.json', name + '.provenance.sha256'))
    if {str(p.relative_to(output)) for p in files_below(output)} != expected:
        raise ValueError('unexpected compiler output inventory')
    report_bytes = file_bytes(output / report_name)
    report = json_strict(report_bytes)
    validation = 'NONVALIDATED' if unverified else 'STRICT_VALIDATED'
    if (not isinstance(report, dict) or set(report) != {'schemaVersion', 'pack', 'targetVersion', 'validation', 'entries'} or
            type(report.get('schemaVersion')) is not int or report.get('schemaVersion') != 2 or report.get('pack') != pack or
            report.get('targetVersion') != version or report.get('validation') != validation or
            not isinstance(report['entries'], list) or
            sorted(entry['blueprint'] for entry in report['entries']) != sorted(p.name for p in sources)):
        raise ValueError('invalid pack conversion report')
    index = json_strict(file_bytes(sources[0].parents[3] / 'schematics/tooling/block_history/generated/index.json'))
    releases = [item for item in index['releases'] if item['release'] == version]
    if len(releases) != 1 or type(releases[0]['data_version']) is not int or releases[0]['data_version'] <= 0:
        raise ValueError('invalid target release index')
    target_data_version = releases[0]['data_version']
    report_hash = hashlib.sha256(report_bytes).hexdigest()
    for source in sources:
        name = f'{source.stem}.mc{version}{label}.schem'
        metadata_bytes = file_bytes(output / (name + '.provenance.json'))
        metadata = json_strict(metadata_bytes)
        source_name = f'schematics/blueprints/{pack}/{source.name}'
        entry = next(entry for entry in report['entries'] if entry['blueprint'] == source.name)
        blueprint = json_strict(file_bytes(source))
        dimensions = [blueprint[key] for key in ('width_x', 'height_y', 'length_z')]
        volume = dimensions[0] * dimensions[1] * dimensions[2]
        artifact = file_bytes(output / name)
        counts = ('non_air', 'air', 'palette_entries', 'block_data_bytes', 'bytes', 'spot_checks')
        entry_fields = {'blueprint', 'schematic', 'sourceVersion', 'sourceDataVersion', 'targetVersion', 'targetDataVersion',
                        'validation', 'changes', 'dimensions', 'volume', 'non_air', 'air', 'palette_entries',
                        'block_data_bytes', 'sha256', 'bytes', 'spot_checks'}
        metadata_fields = {'schemaVersion', 'artifact', 'sha256', 'validation', 'blueprint', 'blueprintSha256',
                           'targetVersion', 'convertTo', 'packReport', 'packReportSha256'}
        if (not isinstance(metadata, dict) or set(metadata) != metadata_fields or set(entry) != entry_fields or
                file_bytes(output / (name + '.provenance.sha256')) != (hashlib.sha256(metadata_bytes).hexdigest() + '\n').encode('ascii') or
                entry.get('schematic') != name or entry.get('sha256') != hashlib.sha256(artifact).hexdigest() or
                entry.get('validation') != validation or entry.get('targetVersion') != version or
                type(entry.get('targetDataVersion')) is not int or entry.get('targetDataVersion') != target_data_version or
                entry.get('sourceVersion') != blueprint['minecraft_version'] or type(entry.get('sourceDataVersion')) is not int or entry.get('sourceDataVersion') != blueprint['data_version'] or
                entry.get('dimensions') != dimensions or not isinstance(entry.get('dimensions'), list) or
                any(type(value) is not int for value in entry['dimensions']) or type(entry.get('volume')) is not int or entry.get('volume') != volume or
                any(type(entry.get(key)) is not int or entry[key] < 0 for key in counts) or
                entry['non_air'] + entry['air'] != volume or entry['bytes'] != len(artifact) or
                entry['spot_checks'] != len(blueprint['spot_checks']) or not isinstance(entry.get('changes'), list) or
                metadata.get('schemaVersion') != 1 or type(metadata.get('schemaVersion')) is not int or metadata.get('targetVersion') is not None or
                metadata.get('artifact') != name or metadata.get('blueprint') != source_name or
                metadata.get('blueprintSha256') != inputs[source_name] or
                metadata.get('sha256') != hashlib.sha256(artifact).hexdigest() or
                metadata.get('packReport') != report_name or metadata.get('packReportSha256') != report_hash or
                metadata.get('validation') != validation or metadata.get('convertTo') != version):
            raise ValueError(f'invalid provenance: {name}')


def build(pack, version, unverified, backend='host', image=None):
    if not PACK.fullmatch(pack):
        raise ValueError('pack must match packN with a positive decimal N')
    if not VERSION.fullmatch(version):
        raise ValueError('target version must be a numeric Minecraft release')
    start = time.monotonic()
    safe_dir(ROOT)
    cache = safe_dir(ROOT / '.schematic-builds', create=True)
    packdir = safe_dir(cache / pack, create=True)
    private_directory(cache)
    private_directory(packdir)
    lockpath = packdir / '.lock'
    fd = os.open(lockpath, os.O_CREAT | os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        lock_info = os.fstat(fd)
        if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_nlink != 1:
            raise ValueError('pack lock is not a regular file')
        fcntl.flock(fd, fcntl.LOCK_EX)
        originals = input_files(pack)
        digests = inventory(originals, ROOT)
        policy = {'pack': pack, 'targetVersion': version, 'allowUnverified': unverified}
        runtime = container_runtime(image) if backend == 'container' else None
        key_data = {'inputs': digests, 'policy': policy}
        if runtime is not None:
            key_data.update(runtime=runtime, schema=2)
        key = hashlib.sha256(json.dumps(key_data, sort_keys=True).encode()).hexdigest()
        sources = [p for p in originals if p.parent == ROOT / 'schematics' / 'blueprints' / pack]
        if runtime is not None:
            for candidate in sorted(packdir.glob(key + '-*')):
                try:
                    verify_candidate(candidate, key, policy, runtime, digests, sources)
                    if inventory(input_files(pack), ROOT) != digests or container_runtime(image) != runtime:
                        raise ValueError('inputs or runtime changed during cache verification')
                except (OSError, ValueError, KeyError, TypeError, UnicodeError, AttributeError, IndexError):
                    continue
                print(json.dumps({'result': 'hit', 'reuse': True, 'pack': pack, 'targetVersion': version,
                                  'blueprints': len(sources), 'build': str(candidate.relative_to(ROOT)),
                                  'seconds': round(time.monotonic() - start, 3)}, sort_keys=True))
                return
        with private_stage(packdir) as stage:
            snapshot = stage / 'snapshot'
            for original in originals:
                relative = original.relative_to(ROOT)
                target = snapshot / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                data = file_bytes(original)
                if hashlib.sha256(data).hexdigest() != digests[str(relative)]:
                    raise ValueError(f'input changed during snapshot: {relative}')
                target.write_bytes(data)
                target.chmod(0o400)
            output = snapshot / 'schematics' / 'schems' / pack
            output.mkdir(parents=True)
            command = [sys.executable, '-B', str(snapshot / 'schematics/tooling/compile_pack.py'), pack, version]
            if unverified:
                command.append('--allow-unverified')
            if runtime is not None:
                if ',' in str(snapshot) or ',' in str(output):
                    raise ValueError('Docker bind mount paths may not contain commas')
                args = ['run', '--rm', '--pull=never', '--network=none', '--read-only',
                        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256',
                        '--user', f'{os.getuid()}:{os.getgid()}', '--platform', 'linux/' + runtime['architecture'],
                        '--mount', f'type=bind,src={snapshot},dst=/work,readonly',
                        '--mount', f'type=bind,src={output},dst=/work/schematics/schems/{pack}',
                        '--workdir', '/work', '--entrypoint', '/usr/bin/env', image,
                        '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8', 'TZ=UTC',
                        'PYTHONHASHSEED=0', 'PYTHONDONTWRITEBYTECODE=1',
                        '/usr/bin/python3', '-B', '/work/schematics/tooling/compile_pack.py', pack, version]
                if unverified:
                    args.append('--allow-unverified')
                log = docker(*args)
            else:
                result = subprocess.run(command, cwd=snapshot, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False)
                log = result.stdout
                if result.returncode:
                    raise ValueError(f'compiler failed ({result.returncode}):\n{log}')
            (stage / 'build.log').write_text(log, encoding='utf8')
            if inventory(input_files(pack), ROOT) != digests:
                raise ValueError('inputs changed during compilation; build not published')
            if inventory(input_files(pack, snapshot), snapshot) != digests:
                raise ValueError('snapshot changed during compilation; build not published')
            verify_outputs(output, pack, version, unverified, sources, digests)
            if runtime is not None:
                if container_runtime(image) != runtime:
                    raise ValueError('runtime changed during compilation; build not published')
                manifest = {'schema': 2, 'key': key, 'policy': policy, 'runtime': runtime,
                            'inputs': digests, 'tree': tree_inventory(stage), 'compilerExit': 0}
                reason = 'no verified cache candidate'
            else:
                artifacts = inventory(files_below(output), snapshot)
                reason = 'effective runtime and dependencies are not hermetically fingerprinted'
                manifest = {'schema': 1, 'key': key, 'policy': policy, 'inputs': digests,
                            'outputs': artifacts, 'reuse': False, 'reason': reason, 'compilerExit': result.returncode}
            (stage / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n', encoding='utf8')
            if runtime is not None:
                verify_candidate(stage, key, policy, runtime, digests, sources)
            if inventory(input_files(pack), ROOT) != digests or inventory(input_files(pack, snapshot), snapshot) != digests:
                raise ValueError('inputs changed during final verification; build not published')
            if runtime is not None:
                freeze_tree(stage)
            # Random staging name is also the unique final suffix. Never replace a destination.
            destination = packdir / (key + '-' + stage.name.removeprefix('.stage-'))
            rename_noreplace(stage, destination)
            print(json.dumps({'result': 'rebuilt', 'reuse': False, 'reason': reason,
                              'pack': pack, 'targetVersion': version, 'blueprints': len(sources),
                              'build': str(destination.relative_to(ROOT)), 'seconds': round(time.monotonic() - start, 3)}, sort_keys=True))
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('list', help='list available blueprint packs')
    compiler = sub.add_parser('build', help='compile in isolation; container reuse is opt-in')
    compiler.add_argument('--pack', required=True, help='packN with positive decimal N')
    compiler.add_argument('--target-version', required=True, help='exact numeric Java release')
    compiler.add_argument('--allow-unverified', action='store_true', help='explicit NONVALIDATED compiler policy')
    compiler.add_argument('--backend', choices=('host', 'container'), default='host')
    compiler.add_argument('--image', help='full inspected immutable compiler image ID (container backend)')
    args = parser.parse_args()
    try:
        if args.command == 'list':
            root = safe_dir(safe_dir(ROOT / 'schematics') / 'blueprints')
            for path in sorted(root.iterdir()):
                if PACK.fullmatch(path.name):
                    safe_dir(path)
                    print(path.name)
        else:
            if args.backend == 'host' and args.image:
                raise ValueError('--image requires --backend container')
            build(args.pack, args.target_version, args.allow_unverified, args.backend, args.image)
        return 0
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
