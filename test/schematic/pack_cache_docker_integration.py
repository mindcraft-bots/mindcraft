#!/usr/bin/env python3
"""Opt-in real pack1 Docker benchmark; uses only disposable copies."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ('build_pack.py', 'compile_pack.py', 'compile_blueprint.py',
         'convert_history.mjs', 'history_registry.mjs', 'block_history.v1.json')


def checkout(path):
    tools = path / 'schematics/tooling'
    tools.mkdir(parents=True)
    for name in TOOLS:
        shutil.copyfile(ROOT / 'schematics/tooling' / name, tools / name)
    shutil.copytree(ROOT / 'schematics/tooling/block_history', tools / 'block_history')
    shutil.copytree(ROOT / 'schematics/blueprints/pack1', path / 'schematics/blueprints/pack1')


def build(path, image):
    result = subprocess.run(['python3', 'schematics/tooling/build_pack.py', 'build', '--pack', 'pack1',
                             '--target-version', '1.21.4', '--backend', 'container', '--image', image],
                            cwd=path, text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def outputs(path, result):
    output = path / result['build'] / 'snapshot/schematics/schems/pack1'
    return {p.name: p.read_bytes() for p in output.iterdir()}


def timestamp(ns):
    return datetime.datetime.fromtimestamp(ns / 1e9, datetime.timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='full local compiler image ID')
    image = parser.parse_args().image
    with tempfile.TemporaryDirectory(prefix='mindcraft-docker-pack-') as temporary:
        try:
            root = Path(temporary)
            one, two = root / 'one', root / 'two'
            checkout(one)
            checkout(two)
            before = time.time_ns()
            cold = build(one, image)
            between = time.time_ns()
            warm = build(one, image)
            after = time.time_ns()
            assert not cold['reuse'] and warm['reuse'] and cold['build'] == warm['build']
            # Docker's local event stream independently records container creation;
            # check that cold created one and warm created none for this image.
            events = subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', 'events',
                                     '--since', timestamp(before - 1_000_000_000), '--until', timestamp(after),
                                     '--filter', 'type=container', '--filter', 'event=create',
                                     '--format', '{{json .}}'], capture_output=True, text=True, check=True)
            relevant = [json.loads(line) for line in events.stdout.splitlines()]
            relevant = [e for e in relevant if e['Actor']['Attributes'].get('image') == image]
            cold_count = sum(before <= e['timeNano'] < between for e in relevant)
            warm_count = sum(between <= e['timeNano'] <= after for e in relevant)
            assert cold_count == 1 and warm_count == 0, (cold_count, warm_count)
            independent = build(two, image)
            assert not independent['reuse'] and outputs(one, cold) == outputs(two, independent)
            source = sorted((one / 'schematics/blueprints/pack1').glob('*.json'))[0]
            st = source.stat()
            with source.open('ab') as stream:
                stream.write(b'\n')
            os.utime(source, ns=(st.st_atime_ns, st.st_mtime_ns))
            changed = build(one, image)
            assert not changed['reuse']
            original_binaries = {k: v for k, v in outputs(one, cold).items() if k.endswith('.schem')}
            changed_binaries = {k: v for k, v in outputs(one, changed).items() if k.endswith('.schem')}
            assert original_binaries == changed_binaries
            print(json.dumps({'coldSeconds': cold['seconds'], 'warmSeconds': warm['seconds'],
                              'invalidationSeconds': changed['seconds'],
                              'independentColdSeconds': independent['seconds'],
                              'coldContainerCreates': cold_count, 'warmContainerCreates': warm_count,
                              'equivalentOutputFiles': len(outputs(one, cold)),
                              'equivalentBinariesAfterWhitespaceEdit': len(original_binaries)}, sort_keys=True))
        finally:
            for directory, _, files in os.walk(temporary):
                Path(directory).chmod(0o700)
                for name in files:
                    path = Path(directory) / name
                    if not path.is_symlink():
                        path.chmod(0o600)


if __name__ == '__main__':
    main()
