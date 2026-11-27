#!/usr/bin/env python3
"""Try a node-gyp override in a new isolated copy of the current checkout."""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from run_isolatedci import Failed, clean_environment, snapshot_environment


ROOT = Path(__file__).resolve().parent.parent


def snapshot(destination, env):
    subprocess.run(['node', 'ci/snapshot_checkout.mjs', str(destination)], cwd=ROOT,
                   env=snapshot_environment(env), stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, check=True)


def run(command, cwd, env, log, allowed=(0,)):
    print(f'Running {command[0]}: {log}', flush=True)
    with log.open('x', encoding='utf-8') as output:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=output,
                                stderr=subprocess.STDOUT, check=False)
    if result.returncode not in allowed:
        raise RuntimeError(f'{command[0]} exited {result.returncode}; see {log}')
    return result.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace-parent', required=True, type=Path,
                        help='existing directory outside the checkout')
    parser.add_argument('--node-gyp', required=True, help='exact version, e.g. 12.3.0')
    args = parser.parse_args()
    if not re.fullmatch(r'\d+\.\d+\.\d+', args.node_gyp):
        parser.error('--node-gyp must be an exact numeric version')
    parent = args.workspace_parent.resolve(strict=True)
    if not parent.is_dir() or parent.is_relative_to(ROOT):
        parser.error('--workspace-parent must be a directory outside the checkout')
    work = Path(tempfile.mkdtemp(prefix='mindcraft-node-gyp-', dir=parent))
    print(f'Private experiment workspace: {work}', flush=True)
    try:
        checkout = work / 'checkout'
        checkout.mkdir()
        (work / 'home').mkdir(mode=0o700)
        (work / 'tmp').mkdir(mode=0o700)
        env = clean_environment(work)
        snapshot(checkout, env)
        shutil.copyfile(checkout / 'ci/npm-lock.json', checkout / 'package-lock.json')
        manifest = checkout / 'package.json'
        package = json.loads(manifest.read_text(encoding='utf-8'))
        package['overrides']['gl']['node-gyp'] = args.node_gyp
        manifest.write_text(json.dumps(package, indent=2) + '\n', encoding='utf-8')
        for name in ('user', 'global'):
            config = work / f'{name}.npmrc'
            config.touch(mode=0o600, exist_ok=False)
            env[f'NPM_CONFIG_{name.upper()}CONFIG'] = str(config)
        env['NPM_CONFIG_CACHE'] = str(work / 'npm-cache')
        env['CI'] = 'true'
        run(['npm', 'install', '--package-lock-only', '--ignore-scripts'], checkout, env, work / 'candidate-lock.log')
        run(['npm', 'ci'], checkout, env, work / 'candidate-npm-ci.log')
        run(['npm', 'rebuild', 'gl', 'canvas', '--build-from-source', '--foreground-scripts'], checkout, env, work / 'candidate-native-build.log')
        run(['npm', 'ls', '--all', 'gl', 'canvas', 'node-gyp', 'tar'], checkout, env, work / 'candidate-dependencies.log')
        run(['node', '-e', "console.log('canvas',typeof require('canvas').createCanvas,'gl',typeof require('gl'))"], checkout, env, work / 'candidate-runtime.log')
        audit_file = work / 'candidate-audit.json'
        with audit_file.open('x', encoding='utf-8') as output, (work / 'candidate-audit.stderr').open('x', encoding='utf-8') as errors:
            audit = subprocess.run(['npm', 'audit', '--json'], cwd=checkout, env=env,
                                   stdout=output, stderr=errors, check=False)
        data = json.loads(audit_file.read_text(encoding='utf-8'))
        counts = data['metadata']['vulnerabilities']
        if (not isinstance(counts, dict) or not isinstance(counts.get('total'), int)
                or audit.returncode not in (0, 1)
                or (audit.returncode == 1) != (counts['total'] > 0)):
            raise RuntimeError(f'audit tool failure or inconsistent result (exit {audit.returncode})')
        print(f'Audit exit {audit.returncode}; affected packages: {json.dumps(counts, sort_keys=True)}')
        return 0
    except (OSError, ValueError, KeyError, subprocess.SubprocessError, RuntimeError, Failed) as error:
        print(f'Experiment failed: {error}; evidence retained at {work}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
