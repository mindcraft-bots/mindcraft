#!/usr/bin/env python3
"""Reproduce independent reports in temporary directories; never modify the lock.

Supply independently verified Java executables and a private content-addressed
cache. Server execution is bounded, but is not a sandbox; use a suitable host.
"""
import argparse
import hashlib
import io
import json
import subprocess
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

import generate as g

# These are the exact identities embedded in the SHA-1-verified official jars,
# not a generic exception for snapshots or unstably labelled builds.
EARLY_IDENTITIES = {
    '1.14': ('1.14 / 5dac5567e13e46bdb0c1d90aa8d8b3f7', False),
    '1.14.1': ('1.14.1 / a8f78b0d43c74598a199d6d80cda413f', False),
    '1.14.2': ('1.14.2 / f647ba8dc371474797bee24b2b312ff4', True),
}


def validate_identity(identity, version, data_version):
    expected_id, expected_stable = EARLY_IDENTITIES.get(version, (version, True))
    if (identity.get('id') != expected_id or identity.get('name') != version or
            identity.get('stable') is not expected_stable or
            identity.get('world_version') != data_version or
            (version in EARLY_IDENTITIES and identity.get('release_target') != version)):
        raise ValueError('server version identity/DataVersion mismatch')


def cache_bytes(cache, data):
    digest = g.sha(data)
    path = cache / digest
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError('existing cache entry does not match digest ' + digest)
    else:
        path.write_bytes(data)
    return digest


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cache', type=Path, required=True)
    p.add_argument('--java8', type=Path, required=True)
    p.add_argument('--java16', type=Path, required=True)
    p.add_argument('--java17', type=Path, required=True)
    p.add_argument('--java21', type=Path)
    p.add_argument('--java25', type=Path)
    p.add_argument('--versions', nargs='+', required=True)
    p.add_argument('--seconds', type=int, default=900)
    p.add_argument('--per-release-seconds', type=int, default=100)
    p.add_argument('--results', type=Path, required=True)
    a = p.parse_args()
    if a.seconds <= 0 or a.per_release_seconds <= 0:
        p.error('timeouts must be positive')
    cache = a.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    lock = json.loads((g.ROOT / 'sources.lock.json').read_bytes())
    manifest = json.loads(g.read_source(lock['manifest'], cache))
    inventory = {x['id']: x for x in manifest['versions'] if x['type'] == 'release'}
    releases = {r['version']: r for r in lock['releases']}
    deadline = time.monotonic() + a.seconds
    results = {}
    for v in a.versions:
        try:
            if time.monotonic() >= deadline:
                raise TimeoutError('batch deadline reached')
            r = releases[v]
            descriptor = r['mojang_metadata']
            official = inventory[v]
            if descriptor['url'] != official['url'] or descriptor['sha1'] != official['sha1']:
                raise ValueError('manifest metadata descriptor mismatch')
            m = json.loads(g.read_source(descriptor, cache))
            if m['id'] != v or m['type'] != 'release':
                raise ValueError('metadata release mismatch')
            vi = json.loads(g.read_source(r['version_info'], cache))
            if vi['id'] != v or vi['type'] != 'release':
                raise ValueError('summary version identity mismatch')
            server = m['downloads']['server']
            if server['size'] > 100_000_000:
                raise ValueError('server exceeds size limit')
            with urllib.request.urlopen(server['url'], timeout=min(60, max(1, deadline-time.monotonic()))) as response:
                data = response.read(server['size'] + 1)
            if len(data) != server['size'] or hashlib.sha1(data).hexdigest() != server['sha1']:
                raise ValueError('server size or Mojang SHA-1 mismatch')
            server_hash = g.sha(data)
            pinned = r.get('local_report', {}).get('server')
            if pinned and (pinned['url'] != server['url'] or pinned['sha1'] != server['sha1'] or pinned['sha256'] != server_hash):
                raise ValueError('pinned server mismatch')
            with zipfile.ZipFile(io.BytesIO(data)) as jar:
                identity = json.loads(jar.read('version.json'))
            validate_identity(identity, v, vi['data_version'])
            major = m['javaVersion']['majorVersion']
            java = {8: a.java8, 16: a.java16, 17: a.java17, 21: a.java21, 25: a.java25}.get(major)
            if java is None:
                raise ValueError('no Java executable supplied for major %s' % major)
            java = java.resolve()
            with tempfile.TemporaryDirectory(prefix='mindcraft-report-') as tmp:
                tmp = Path(tmp)
                jar_path = tmp / 'server.jar'
                jar_path.write_bytes(data)
                if g.semver(v) >= (1, 18, 0):
                    cmd = [str(java), '-Xmx1G', '-DbundlerMainClass=net.minecraft.data.Main', '-jar', str(jar_path), '--reports']
                else:
                    cmd = [str(java), '-Xmx1G', '-cp', str(jar_path), 'net.minecraft.data.Main', '--reports']
                remaining = min(a.per_release_seconds, deadline - time.monotonic())
                if remaining <= 0:
                    raise TimeoutError('batch deadline reached')
                completed = subprocess.run(cmd, cwd=tmp, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=remaining)
                if completed.returncode:
                    raise RuntimeError('generator exited %d: %s' % (completed.returncode, completed.stdout[-1500:].decode(errors='replace')))
                raw = (tmp / 'generated/reports/blocks.json').read_bytes()
            full = g.from_full(json.loads(raw))
            summary = g.from_summary(json.loads(g.read_source(r['registries'], cache))['block'], json.loads(g.read_source(r['blocks'], cache)))
            if set(full) != set(summary):
                raise ValueError('report identifier mismatch: report-only=%s summary-only=%s' % (sorted(set(full)-set(summary)), sorted(set(summary)-set(full))))
            for name, known in summary.items():
                if known is not None and (known['properties'] != full[name]['properties'] or known['defaults'] != full[name]['defaults']):
                    raise ValueError('report schema mismatch ' + name)
            report_hash = g.sha(raw)
            if r.get('local_report') and r['local_report']['sha256'] != report_hash:
                raise ValueError('pinned report mismatch')
            cache_bytes(cache, raw)
            cache_bytes(cache, data)
            results[v] = {'server': {'url': server['url'], 'sha1': server['sha1'], 'sha256': server_hash},
                          'sha256': report_hash, 'java_major': major, 'data_version': vi['data_version'],
                          'block_count': len(full), 'state_count': sum(len(x['states']) for x in json.loads(raw).values())}
        except Exception as e:
            results[v] = {'error': '%s: %s' % (type(e).__name__, e)}
        a.results.write_bytes(g.pretty(results))
        print(v, json.dumps(results[v], sort_keys=True), flush=True)
    return 1 if any('error' in result for result in results.values()) else 0


if __name__ == '__main__':
    raise SystemExit(main())
