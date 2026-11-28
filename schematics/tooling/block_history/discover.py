#!/usr/bin/env python3
"""Discover a new lock from Mojang's manifest and mcmeta tags; review before use."""
import concurrent.futures as cf
import hashlib
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / '.cache'
CACHE.mkdir(parents=True, exist_ok=True)
MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
NPM = 'https://registry.npmjs.org/minecraft-data/-/minecraft-data-3.119.0.tgz'
ARC = {'1.13': '20551aa4e972b0b22a420ed5086782842d722d62',
       '1.13.1': 'f0375a8303f788c8b3a15b944d14ef0faf8fbb98',
       '1.13.2': 'f0375a8303f788c8b3a15b944d14ef0faf8fbb98'}
OFFICIAL = {
    '1.13': ('d0caafb8438ebd206f99930cfaecfa6c9a13dca0','e76f3927904d331c969a2c437d5661ac02f24be86062dd1c607bfd4ebdc550b9','7a893606b910ef24d17cc7350a3f349dab30bf8e073a8afecbc678fe3648f0ed'),
    '1.13.1': ('fe123682e9cb30031eae351764f653500b7396c9','2ea6047e7651c429228340acd7d1e35f4f6c7af42f59f92b0b1cd476561253d1','d386830f6ce9949b1ff893d4588c07dbb5fc23afb8bc2b445ab3b0b5aec68952'),
    '1.13.2': ('3737db93722a9e39eeada7c27e7aca28b144ffa7','ffd3aa2c25c5ba68a706b59f2abdc69ac1748e115ca9d3b47941e197736f088e','d386830f6ce9949b1ff893d4588c07dbb5fc23afb8bc2b445ab3b0b5aec68952')}

def get(url):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent':'mindcraft-block-history/1'}), timeout=60) as r:
                return r.read()
        except Exception:
            if i == 3: raise
            time.sleep(1+i*2)

def store(url, expected_sha1=None):
    data = get(url)
    if expected_sha1 and hashlib.sha1(data).hexdigest() != expected_sha1:
        raise ValueError('Mojang SHA-1 mismatch: ' + url)
    h = hashlib.sha256(data).hexdigest()
    (CACHE / h).write_bytes(data)
    result = {'url':url, 'sha256':h}
    if expected_sha1: result['sha1'] = expected_sha1
    return result

def semver(s): return tuple(map(int, s.split('.'))) + ((0,) if s.count('.') == 1 else ())

def main():
    manifest = store(MANIFEST)
    items = json.loads((CACHE / manifest['sha256']).read_bytes())['versions']
    versions = sorted((x for x in items if x['type']=='release' and re.fullmatch(r'\d+\.\d+(?:\.\d+)?', x['id']) and semver(x['id']) >= (1,13,0)), key=lambda x: semver(x['id']))
    tags = subprocess.check_output(['git','ls-remote','--tags','https://github.com/misode/mcmeta.git'], text=True)
    tags = {b.removeprefix('refs/tags/'):a for a,b in (line.split() for line in tags.splitlines()) if not b.endswith('^{}')}
    npm = store(NPM)
    if npm['sha256'] != '5cc07ec6ec5e386e48c38c73055e785ab0a1b38694a7e5d9724fa631b2de2c71': raise ValueError('unexpected npm tarball')
    def one(item):
        v = item['id']; record = {'version': v, 'mojang_metadata': store(item['url'], item['sha1'])}
        if v in ARC:
            sha1,sha256,report = OFFICIAL[v]; commit=ARC[v]
            src=store('https://raw.githubusercontent.com/Arcensoth/mcdata/'+commit+'/generated/reports/blocks.json')
            if src['sha256'] != report: raise ValueError('official report mismatch '+v)
            record.update(kind='official-full-report', revision=commit, report=src, data_version_source=npm,
                          server={'url':'https://piston-data.mojang.com/v1/objects/'+sha1+'/server.jar','sha1':sha1,'sha256':sha256},
                          official_report_sha256=report)
        elif v+'-summary' in tags:
            commit=tags[v+'-summary']; base='https://raw.githubusercontent.com/misode/mcmeta/'+commit+'/'
            record.update(kind='mcmeta-summary', revision=commit, version_info=store(base+'version.json'), blocks=store(base+'blocks/data.json'), registries=store(base+'registries/data.json'))
        else:
            record.update(kind='unavailable', reason='no exact release source found')
        return record
    with cf.ThreadPoolExecutor(max_workers=12) as pool:
        records=list(pool.map(one,versions))
    lock={'schema':1,'generated_at_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'edition':'java', 'manifest':manifest, 'releases':records}
    (ROOT/'sources.lock.json').write_text(json.dumps(lock,indent=2,ensure_ascii=False)+'\n')
    print('locked',len(records),'releases; cache',CACHE)

if __name__ == '__main__': main()
