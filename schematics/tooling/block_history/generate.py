#!/usr/bin/env python3
"""Generate release profiles from a reviewed, hash-pinned source lock."""
import argparse
import gzip
import hashlib
import io
import itertools
import json
import re
import tarfile
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCHEMA = 1
REVISION = 'block-history-generator/1'
# Independently observed server-report counts, not estimates for other releases.
ATTESTED_COUNTS = {'1.13':593, '1.13.1':598, '1.13.2':598,
                   '1.20.2':1003, '1.21.2':1084, '1.21.7':1105, '26.3':1286}
# Separately checked jar/report attestations from PROVENANCE.md. Jars are not
# consumed during a normal offline build.
FULL_ATTESTATIONS = {
    '1.13': ('e76f3927904d331c969a2c437d5661ac02f24be86062dd1c607bfd4ebdc550b9', '7a893606b910ef24d17cc7350a3f349dab30bf8e073a8afecbc678fe3648f0ed'),
    '1.13.1': ('2ea6047e7651c429228340acd7d1e35f4f6c7af42f59f92b0b1cd476561253d1', 'd386830f6ce9949b1ff893d4588c07dbb5fc23afb8bc2b445ab3b0b5aec68952'),
    '1.13.2': ('ffd3aa2c25c5ba68a706b59f2abdc69ac1748e115ca9d3b47941e197736f088e', 'd386830f6ce9949b1ff893d4588c07dbb5fc23afb8bc2b445ab3b0b5aec68952'),
}
# Locally generated reports are not redistributed or fetched as URLs. Each
# release needs its own independent jar/report attestation; never inherit one.
LOCAL_REPORT_ATTESTATIONS = {
    '1.20.2': ('1daee4838569ad46e41f0a6f459684c500c7f2685356a40cfb7e838d6e78eae8', 'b136604125b5f0200c476d8fc48ff1efd2920a120b1e7c693b0f0a120d21f852'),
    '1.14': ('671e3d334dd601c520bf1aeb96e49038145172bef16bc6c418e969fd8bf8ff6c', '06a0501dd51921ff1f99275285405d9e1645fdf9578aec6f79954c9ff151e4e5'),
    '1.14.1': ('f822f0b730b7e1f05fca84248a6873400bac4ca449ff6762a55cab3d68b1f03e', '06a0501dd51921ff1f99275285405d9e1645fdf9578aec6f79954c9ff151e4e5'),
    '1.14.2': ('b47fd85155ae77c2bc59e62a215310c4dce87c7dfdf7588385973fa20ff4655b', '06a0501dd51921ff1f99275285405d9e1645fdf9578aec6f79954c9ff151e4e5'),
    '1.14.3': ('942256f0bfec40f2331b1b0c55d7a683b86ee40e51fa500a2aa76cf1f1041b38', '06a0501dd51921ff1f99275285405d9e1645fdf9578aec6f79954c9ff151e4e5'),
    '1.14.4': ('5ecdedab3a6e129321a444490d0a467c25ea702a24a99cebe3b6aed41f8f5729', '06a0501dd51921ff1f99275285405d9e1645fdf9578aec6f79954c9ff151e4e5'),
    '1.15': ('e0fe1749263b5ec211b358b598b46e787645bffa8411414f0c812a92bdc70c84', '636129d6a1e2a8066a3dc96acfa0227af40c4ee13ea69e1fa81a90d75b232871'),
    '1.15.1': ('a0c062686bee5a92d60802ca74d198548481802193a70dda6d5fe7ecb7207993', '636129d6a1e2a8066a3dc96acfa0227af40c4ee13ea69e1fa81a90d75b232871'),
    '1.15.2': ('80cf86dc2004ec6a2dc0183d1c75a9af3ba0669f7c332e4247afb1d76fb67e8a', '636129d6a1e2a8066a3dc96acfa0227af40c4ee13ea69e1fa81a90d75b232871'),
    '1.16': ('7d2d2d127b90baf2bd8fc61092cbff42bea1bdfae30a2838f45edb31294979b9', '52bdcdfd178b3990ae120daa75697ea9a06e4243e4e137623c9a141dc7a7b50b'),
    '1.16.1': ('2782d547724bc3ffc0ef6e97b2790e75c1df89241f9d4645b58c706f5e6c935b', '52bdcdfd178b3990ae120daa75697ea9a06e4243e4e137623c9a141dc7a7b50b'),
    '1.16.2': ('2902ed3ff84e4f810a2c0620c6b6df9c3ef8488b272c61274d5eac2433876f39', '03ca0823dc7257851c7e946f5929c7d8334d106d671d5d9438a188048df24cbc'),
    '1.16.3': ('32e450e74c081aec06dcfbadfa5ba9aa1c7f370bd869e658caec0c3004f7ad5b', '03ca0823dc7257851c7e946f5929c7d8334d106d671d5d9438a188048df24cbc'),
    '1.16.4': ('444d30d903a1ef489b6737bb9d021494faf23434ca8568fd72ce2e3d40b32506', '03ca0823dc7257851c7e946f5929c7d8334d106d671d5d9438a188048df24cbc'),
    '1.16.5': ('58f329c7d2696526f948470aa6fd0b45545039b64cb75015e64c12194b373da6', '03ca0823dc7257851c7e946f5929c7d8334d106d671d5d9438a188048df24cbc'),
    '1.17': ('7b390d8d9f6b5649b226d82686aec7f11bd9aa4430bb5cac9072ffd32f3c1f4b', 'e7bc901b0b1b08672331d365686fde578e597fe342312356c1c4edea109765a2'),
    '1.17.1': ('e8c211b41317a9f5a780c98a89592ecb72eb39a6e475d4ac9657e5bc9ffaf55f', 'e7bc901b0b1b08672331d365686fde578e597fe342312356c1c4edea109765a2'),
    '1.18': ('8417edceb471b38a59a6ce260f3aa1479e95264a38eb56283bdf24ec98647e6f', 'e7bc901b0b1b08672331d365686fde578e597fe342312356c1c4edea109765a2'),
    '1.18.1': ('ebcd120ad81480b968a548df6ffb83b88075e95195c8ff63d461c9df4df5dbdf', 'e7bc901b0b1b08672331d365686fde578e597fe342312356c1c4edea109765a2'),
    '1.18.2': ('57be9d1e35aa91cfdfa246adb63a0ea11a946081e0464d08bc3d36651718a343', 'e7bc901b0b1b08672331d365686fde578e597fe342312356c1c4edea109765a2'),
    '1.19': ('deefd056f0cf89c3d7fd48d03f56a8a73943586e8c061fdabd0fd92d32ced2b2', '2f14c76c27381e0f995c34302d55efd4de25dd884097eb35dcc2b1b4d1d5b419'),
    '1.19.1': ('f15b93c25ac7343ae8db6e7883a97f11777baaee924e7a3c7aeed826b155b233', '2f14c76c27381e0f995c34302d55efd4de25dd884097eb35dcc2b1b4d1d5b419'),
    '1.19.2': ('b26727069ef5f61c704add9a378ac90e3d271fd7876c0bd3dcfbe9fd0bec4d96', '2f14c76c27381e0f995c34302d55efd4de25dd884097eb35dcc2b1b4d1d5b419'),
    '1.19.3': ('4ebd3ad142512953d0193ae3a1d1a30c896907de7c68780977151f6cc79f1e1b', 'fe59b6735eaa1b08d71c5be41ad8295fbbb44586192b3962778eec03caa77fac'),
    '1.19.4': ('a524a10da550741785c8c3a0fb39047f106b0c7c2cfa255e8278cb6f1abe3f53', '1a59d207655f0a8dfacd58fc7d71d33cf1ebf209e5764edfa770f70528e7df78'),
    '1.20': ('ff41c542cec182ce74508a5e42194e0f4009341de75f0a7bf770d18cf701d56b', 'f10d5da83ec8cd995d4f484b788c5b1467a490728e687c629a681450e3253017'),
    '1.20.1': ('3af73a9dc5a102e38147946360dd27d4d70bae7055bf91cf2151cd5d121b79e0', 'f10d5da83ec8cd995d4f484b788c5b1467a490728e687c629a681450e3253017'),
    '1.20.3': ('36ed89be93f182034df0678bce957b5442f0c6905f41e94ff6a0521b2e138bae', '18d83f2c0c04adda138cd8caeb8db14442628f1e6ca3c949b202db2d63573f73'),
    '1.20.4': ('c03fa6f39daa69ddf413c965a3a83084db746a7a138ce535a693293b5472d363', '18d83f2c0c04adda138cd8caeb8db14442628f1e6ca3c949b202db2d63573f73'),
}
# DataVersions independently read from each verified server jar's version.json.
LOCAL_REPORT_DATA_VERSIONS = {
    '1.20.2': 3578,
    '1.14': 1952,
    '1.14.1': 1957,
    '1.14.2': 1963,
    '1.14.3': 1968,
    '1.14.4': 1976,
    '1.15': 2225,
    '1.15.1': 2227,
    '1.15.2': 2230,
    '1.16': 2566,
    '1.16.1': 2567,
    '1.16.2': 2578,
    '1.16.3': 2580,
    '1.16.4': 2584,
    '1.16.5': 2586,
    '1.17': 2724,
    '1.17.1': 2730,
    '1.18': 2860,
    '1.18.1': 2865,
    '1.18.2': 2975,
    '1.19': 3105,
    '1.19.1': 3117,
    '1.19.2': 3120,
    '1.19.3': 3218,
    '1.19.4': 3337,
    '1.20': 3463,
    '1.20.1': 3465,
    '1.20.3': 3698,
    '1.20.4': 3700,
}
ATTESTED_COUNTS.update({
    '1.14': 676,
    '1.14.1': 676,
    '1.14.2': 676,
    '1.14.3': 676,
    '1.14.4': 676,
    '1.15': 680,
    '1.15.1': 680,
    '1.15.2': 680,
    '1.16': 763,
    '1.16.1': 763,
    '1.16.2': 763,
    '1.16.3': 763,
    '1.16.4': 763,
    '1.16.5': 763,
    '1.17': 898,
    '1.17.1': 898,
    '1.18': 898,
    '1.18.1': 898,
    '1.18.2': 898,
    '1.19': 933,
    '1.19.1': 933,
    '1.19.2': 933,
    '1.19.3': 972,
    '1.19.4': 998,
    '1.20': 1003,
    '1.20.1': 1003,
    '1.20.3': 1058,
    '1.20.4': 1058,
})

# Independent modern release jar/report, DataVersion, block and state attestations.
LOCAL_REPORT_ATTESTATIONS.update({
    '1.20.5': ('f8f6a38fededc12d6bbac21e5341c168a7c9bf4ef90193fcf0abcc1366c42bac', '0dde7f869588905763ea6ff2e7e01bec1db740a58d27477fd27c2f07fb029f73'),
    '1.20.6': ('c6d01d018ca782e506f0ec60652d47fd565078be9122b625c1681bc86c29c7ec', '0dde7f869588905763ea6ff2e7e01bec1db740a58d27477fd27c2f07fb029f73'),
    '1.21': ('c96394da86f9d9f9ef7ca2d2ee1f2f0980c29b7aa5c94b43c02c50435dbcf53f', '0dde7f869588905763ea6ff2e7e01bec1db740a58d27477fd27c2f07fb029f73'),
    '1.21.1': ('e3bc55693e93cda0188f2e60aea28113fc647c5e85a15fa3d1b347349231b4bb', '0dde7f869588905763ea6ff2e7e01bec1db740a58d27477fd27c2f07fb029f73'),
    '1.21.2': ('3bcbca82b23b0a13f745e25ca5956e33a6f4ccfb5ed451b961c943c0f790418d', '8db9069f23f3285d9737873322ff0cdbf4e741416b5e9c6b0f0d410ef1fec938'),
    '1.21.3': ('e153b89b02c0839cdf5e8c1d57c80dd42a3fffb80c60817632080c041bf8afb5', '8db9069f23f3285d9737873322ff0cdbf4e741416b5e9c6b0f0d410ef1fec938'),
    '1.21.4': ('1066970b09e9c671844572291c4a871cc1ac2b85838bf7004fa0e778e10f1358', '381aaf2729f48928011683b4364e6a3053c0dd986f00126d77822a68b252d1a5'),
    '1.21.5': ('ae7681dadce21b6b4017d28e7eb567d86b6c100a6969994f540b9e54f812dc29', '8ab11b6855cfdad4dc15fed915d1cba96a7748ebe8b3324041e0c4e4e1dfb724'),
    '1.21.6': ('08abf384c48afb9e822144ad8a99166482857994389269e26c6a04c6c91d9171', '56ce847593fd1370bc81bf3ca4e08772faa84695862cb60bf1e2aeebdb2e6845'),
    '1.21.7': ('b955b8f75d811cc326179472174941358eeaf97a68999ee119ccd3873350c4ee', '56ce847593fd1370bc81bf3ca4e08772faa84695862cb60bf1e2aeebdb2e6845'),
    '1.21.8': ('2349d9a8f0d4be2c40e7692890ef46a4b07015e7955b075460d02793be7fbbe7', '56ce847593fd1370bc81bf3ca4e08772faa84695862cb60bf1e2aeebdb2e6845'),
    '1.21.9': ('ebc5161abcd57523c14a04ce108f0b671da0d0d74a28926b19a7d139ebabaf31', '375189fda2c2d4bc65f34a248d24c56167369fbcf5e20b6c9350dc57404c85a9'),
    '1.21.10': ('5bb64dc47379903e8f288bd6a4b276e889075c5c0f4c0b714e958d835c1874e7', '375189fda2c2d4bc65f34a248d24c56167369fbcf5e20b6c9350dc57404c85a9'),
    '1.21.11': ('f83b8e093865806f931c7e34aae41b177d4c076335263dd124c75d6d65dd1726', '293ff1dbba615e5dd8f7d9b9e60adc26e040962fd6113b1f4e820060e2c8ba8b'),
    '26.1': ('98ab064389a8b34d48ac3d4c5ed858dd9433d0dfd1a12e1cbbda916448d92994', 'c4f6aafb57a085df217fcb93533de7c8baa5711ff6eecad07563b28813713cc0'),
    '26.1.1': ('d792784979722dc35144acffb953554e707445c62450550044c4281e632cbbcc', 'c4f6aafb57a085df217fcb93533de7c8baa5711ff6eecad07563b28813713cc0'),
    '26.1.2': ('cd47e7c38328f64768fd17af8fcd8b22496b40b63d4ffee81e71ae059fedcb42', 'c4f6aafb57a085df217fcb93533de7c8baa5711ff6eecad07563b28813713cc0'),
    '26.2': ('cdacdfb25898de5e4b4b0e5ddcc2722f77067e46605709c2d886c000ebb63ec5', 'dec22eb9547b0bbea396cbf35569f7ec81b7be662775ce03dc2236227473af7b'),
    '26.3': ('d052f14d7a173734fba553711e5b570162e2f2a313267ee31a21b975a679be64', '7a0de8aaf7b04d00c40b8ffdc4cfe75184cff2e821d336a020573201867105a4'),
})
LOCAL_REPORT_DATA_VERSIONS.update({
    '1.20.5': 3837,
    '1.20.6': 3839,
    '1.21': 3953,
    '1.21.1': 3955,
    '1.21.2': 4080,
    '1.21.3': 4082,
    '1.21.4': 4189,
    '1.21.5': 4325,
    '1.21.6': 4435,
    '1.21.7': 4438,
    '1.21.8': 4440,
    '1.21.9': 4554,
    '1.21.10': 4556,
    '1.21.11': 4671,
    '26.1': 4786,
    '26.1.1': 4788,
    '26.1.2': 4790,
    '26.2': 4903,
    '26.3': 5023,
})
ATTESTED_COUNTS.update({
    '1.20.5': 1060,
    '1.20.6': 1060,
    '1.21': 1060,
    '1.21.1': 1060,
    '1.21.2': 1084,
    '1.21.3': 1084,
    '1.21.4': 1095,
    '1.21.5': 1104,
    '1.21.6': 1105,
    '1.21.7': 1105,
    '1.21.8': 1105,
    '1.21.9': 1166,
    '1.21.10': 1166,
    '1.21.11': 1166,
    '26.1': 1168,
    '26.1.1': 1168,
    '26.1.2': 1168,
    '26.2': 1196,
    '26.3': 1286,
})
ATTESTED_STATE_COUNTS = {
    '1.20.5': 26684,
    '1.20.6': 26684,
    '1.21': 26684,
    '1.21.1': 26684,
    '1.21.2': 27318,
    '1.21.3': 27318,
    '1.21.4': 27866,
    '1.21.5': 27914,
    '1.21.6': 27946,
    '1.21.7': 27946,
    '1.21.8': 27946,
    '1.21.9': 29671,
    '1.21.10': 29671,
    '1.21.11': 29671,
    '26.1': 29873,
    '26.1.1': 29873,
    '26.1.2': 29873,
    '26.2': 32366,
    '26.3': 35723,
}

def sha(data): return hashlib.sha256(data).hexdigest()
def canonical(obj): return (json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)+'\n').encode()
def pretty(obj): return (json.dumps(obj, sort_keys=True, indent=2, ensure_ascii=False)+'\n').encode()
def semver(s):
    if not re.fullmatch(r'\d+\.\d+(?:\.\d+)?', s): raise ValueError('not a numeric Java release: '+s)
    parts = tuple(map(int,s.split('.')))
    return parts + (0,) * (3-len(parts))

def validate_digest(value, length, label):
    if not isinstance(value,str) or not re.fullmatch('[0-9a-f]{%d}' % length,value): raise ValueError('invalid '+label+' digest')

def validate_source(source):
    if not isinstance(source,dict) or not isinstance(source.get('url'),str): raise ValueError('invalid source descriptor')
    url=source['url']; parsed=urllib.parse.urlsplit(url)
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or any(c.isspace() for c in url): raise ValueError('invalid source URL')
    validate_digest(source.get('sha256'),64,'source SHA-256')
    if 'sha1' in source: validate_digest(source['sha1'],40,'source SHA-1')

def read_source(source, cache, fetch=False):
    validate_source(source)
    digest=source['sha256']
    path=cache / digest
    if not path.exists():
        if not fetch: raise FileNotFoundError('missing pinned source '+digest+' '+source['url'])
        with urllib.request.urlopen(urllib.request.Request(source['url'],headers={'User-Agent':'mindcraft-block-history/1'}),timeout=90) as r: data=r.read()
        if sha(data)!=digest: raise ValueError('source SHA-256 mismatch '+source['url'])
        cache.mkdir(parents=True,exist_ok=True); path.write_bytes(data)
    data=path.read_bytes()
    if sha(data)!=digest: raise ValueError('source SHA-256 mismatch '+source['url'])
    if 'sha1' in source and hashlib.sha1(data).hexdigest()!=source['sha1']: raise ValueError('source SHA-1 mismatch '+source['url'])
    return data

def validate_schema(props, defaults):
    if not isinstance(props,dict) or not isinstance(defaults,dict) or set(props)!=set(defaults): raise ValueError('invalid property/default keys')
    p={}
    for key,values in sorted(props.items()):
        if not isinstance(key,str) or not isinstance(values,list) or not values or any(not isinstance(x,str) for x in values) or len(set(values))!=len(values) or defaults[key] not in values: raise ValueError('invalid property domain or default')
        p[key]=sorted(values)
    return {'properties':p, 'defaults':dict(sorted(defaults.items()))}

def identifier(raw, allow_unqualified=False):
    if not isinstance(raw,str): raise ValueError('invalid identifier')
    name='minecraft:'+raw if allow_unqualified and ':' not in raw else raw
    if not re.fullmatch(r'minecraft:[a-z0-9_./-]+',name): raise ValueError('invalid identifier '+raw)
    return name

def from_full(report):
    if not isinstance(report,dict) or not report: raise ValueError('empty or invalid full block inventory')
    result={}
    for name,entry in sorted(report.items()):
        identifier(name)
        states=entry['states']; default=[x for x in states if x.get('default')]
        if len(default)!=1: raise ValueError('expected one default '+name)
        props=entry.get('properties',{}); schema=validate_schema(props,default[0].get('properties',{}))
        keys=sorted(props); actual=set()
        for state in states:
            values=state.get('properties',{})
            if set(values)!=set(keys) or any(values[k] not in props[k] for k in keys): raise ValueError('invalid full state '+name)
            actual.add(tuple(values[k] for k in keys))
        if len(actual)!=len(states): raise ValueError('duplicate state '+name)
        cartesian=set(itertools.product(*(props[k] for k in keys)))
        if not actual <= cartesian: raise ValueError('unexpected full state '+name)
        schema['combinations']='cartesian' if actual==cartesian else [list(t) for t in sorted(actual)]
        result[name]=schema
    return result

def from_summary(registry, summary):
    if not isinstance(registry,list) or not registry or not isinstance(summary,dict) or any(not isinstance(x,str) for x in registry): raise ValueError('empty or invalid block registry')
    if len(set(registry))!=len(registry) or set(summary)-set(registry): raise ValueError('invalid block registry join')
    result={}
    for raw in sorted(registry):
        name=identifier(raw,allow_unqualified=True)
        if name in result: raise ValueError('duplicate identifier '+name)
        if raw not in summary: result[name]=None; continue
        entry=summary[raw]
        if not isinstance(entry,list) or len(entry)!=2: raise ValueError('invalid summary '+name)
        schema=validate_schema(*entry); schema['combinations']='unknown'; result[name]=schema
    return result

def diff(previous,current,previous_version):
    if previous is None:
        return {'kind':'after_gap' if previous_version else 'baseline','from':None,'baseline':list(current),'added':[],'removed':[],'changed':{},'schema_indeterminate':[]}
    a,b=set(previous),set(current); changed={}; uncertain=[]
    for name in sorted(a & b):
        x,y=previous[name],current[name]
        if x is None or y is None:
            uncertain.append(name); continue
        # Combination evidence is source-dependent; never interpret unknown as a change.
        if x['properties']!=y['properties'] or x['defaults']!=y['defaults']:
            changed[name]={'before':{'properties':x['properties'],'defaults':x['defaults']},'after':{'properties':y['properties'],'defaults':y['defaults']}}
    return {'kind':'adjacent','from':previous_version,'baseline':[],'added':sorted(b-a),'removed':sorted(a-b),'changed':changed,'schema_indeterminate':uncertain}

def validate_drop(previous, current, previous_version, release):
    if previous is None: return
    removed=sorted(set(previous)-set(current))
    # Guard individual removals even if additions conceal a net drop.
    if len(removed)*10 < len(previous): return
    review=release.get('large_drop_review')
    if (not isinstance(review,dict) or review.get('from')!=previous_version or
        type(review.get('removed_count')) is not int or review['removed_count']!=len(removed) or
        review.get('removed_sha256')!=sha(canonical(removed)) or
        not isinstance(review.get('reason'),str) or not review['reason'].strip()):
        raise ValueError('large adjacent removal requires explicit review '+release['version'])

def build(lock, cache, fetch=False, verify_server_jars=False):
    if lock['schema']!=SCHEMA or lock['edition']!='java': raise ValueError('unsupported source lock')
    urls={}; sha1s={}; sha256s={}
    def descriptor(s):
        validate_source(s)
        url=s['url']; digest=s['sha256']
        if url in urls and urls[url]!=digest: raise ValueError('conflicting source URL hashes '+url)
        urls[url]=digest
        if 'sha1' in s:
            if s['sha1'] in sha1s and sha1s[s['sha1']]!=digest: raise ValueError('conflicting source SHA-1 hashes '+url)
            if digest in sha256s and sha256s[digest]!=s['sha1']: raise ValueError('conflicting source SHA-256 hashes '+url)
            sha1s[s['sha1']]=digest
            sha256s[digest]=s['sha1']
    def source(s):
        descriptor(s)
        return read_source(s,cache,fetch)
    manifest=json.loads(source(lock['manifest'])); inventory={x['id']:x for x in manifest['versions'] if x['type']=='release'}
    expected=sorted((x for x in inventory if re.fullmatch(r'\d+\.\d+(?:\.\d+)?',x) and semver(x)>=(1,13,0)),key=semver)
    releases=lock['releases']; versions=[r['version'] for r in releases]
    if versions!=expected or len(set(map(semver,versions)))!=len(versions): raise ValueError('lock does not match sorted manifest inventory')
    npm_versions=None; npm_source=None; outputs={}; entries=[]; prev=None; prev_version=None
    generator_hash=sha(Path(__file__).read_bytes())
    for r in releases:
        v=r['version']; official=inventory[v]; meta=r['mojang_metadata']
        validate_digest(official.get('sha1'),40,'manifest metadata SHA-1')
        if meta['url']!=official['url'] or meta.get('sha1')!=official['sha1']: raise ValueError('manifest metadata mismatch '+v)
        metadata=json.loads(source(meta))
        if metadata['id']!=v or metadata['type']!='release': raise ValueError('metadata identity mismatch '+v)
        if r['kind']=='unavailable':
            config={'schema':SCHEMA,'generator':REVISION,'generator_sha256':generator_hash,'edition':'java','release':v,'coverage':'unavailable','reason':r['reason'],'data_version':None}
            prev=None; prev_version=v
            config_bytes=pretty(config); outputs[f'releases/{v}.json']=config_bytes
            entries.append({'release':v,'coverage':'unavailable','config':f'releases/{v}.json','sha256':sha(config_bytes)}); continue
        if not re.fullmatch(r'[0-9a-f]{40}',r['revision']): raise ValueError('source revision must be an immutable commit '+v)
        if r['kind']=='official-full-report':
            expected_url='https://raw.githubusercontent.com/Arcensoth/mcdata/'+r['revision']+'/generated/reports/blocks.json'
            if r['report']['url']!=expected_url: raise ValueError('report revision mismatch '+v)
            server=r['server']; official_server=metadata['downloads']['server']
            descriptor(server)
            validate_digest(official_server.get('sha1'),40,'official server SHA-1')
            if server['url']!=official_server['url'] or server['sha1']!=official_server['sha1']: raise ValueError('official server mismatch '+v)
            validate_digest(r.get('official_report_sha256'),64,'official report SHA-256')
            if v in FULL_ATTESTATIONS and (server['sha256'],r['official_report_sha256'])!=FULL_ATTESTATIONS[v]: raise ValueError('official attestation mismatch '+v)
            if verify_server_jars: source(server)
            raw=source(r['report'])
            if sha(raw)!=r['official_report_sha256']: raise ValueError('official report mismatch '+v)
            registry=from_full(json.loads(raw))
            dv_source=r['data_version_source']; tarbytes=source(dv_source)
            if npm_source is not None and dv_source!=npm_source: raise ValueError('conflicting data version source '+v)
            if npm_versions is None:
                npm_source=dict(dv_source)
                with tarfile.open(fileobj=io.BytesIO(tarbytes),mode='r:gz') as t:
                    npm_versions=json.load(t.extractfile('package/minecraft-data/data/pc/common/protocolVersions.json'))
            matches=[x for x in npm_versions if x.get('minecraftVersion')==v and 'dataVersion' in x]
            if len(matches)!=1: raise ValueError('ambiguous data version '+v)
            dv=matches[0]['dataVersion']; coverage='shared' if v=='1.13.2' else 'exact'; origin='official-full-report'
        elif r['kind']=='mcmeta-summary':
            base='https://raw.githubusercontent.com/misode/mcmeta/'+r['revision']+'/'
            for key,path in [('version_info','version.json'),('blocks','blocks/data.json'),('registries','registries/data.json')]:
                if r[key]['url']!=base+path: raise ValueError('source revision mismatch '+v)
            vi=json.loads(source(r['version_info']))
            if vi['id']!=v or vi['type']!='release' or not isinstance(vi.get('data_version'),int): raise ValueError('stale or invalid release identity '+v)
            dv=vi['data_version']; registry=from_summary(json.loads(source(r['registries']))['block'],json.loads(source(r['blocks'])))
            coverage='partial' if any(x is None for x in registry.values()) else 'exact'; origin='mcmeta-summary'
            if v in LOCAL_REPORT_ATTESTATIONS and 'local_report' not in r: raise ValueError('missing local report attestation '+v)
            if 'local_report' in r:
                att=r['local_report']; server=att['server']; official_server=metadata['downloads']['server']
                descriptor(server); validate_digest(official_server.get('sha1'),40,'official server SHA-1')
                if server['url']!=official_server['url'] or server.get('sha1')!=official_server['sha1']: raise ValueError('official server mismatch '+v)
                report_hash=att['sha256']; validate_digest(report_hash,64,'local report SHA-256')
                if LOCAL_REPORT_ATTESTATIONS.get(v)!=(server['sha256'],report_hash): raise ValueError('local report attestation mismatch '+v)
                if LOCAL_REPORT_DATA_VERSIONS.get(v)!=dv: raise ValueError('local report DataVersion mismatch '+v)
                if att['java_major']!=metadata['javaVersion']['majorVersion']: raise ValueError('official Java version mismatch '+v)
                if verify_server_jars: source(server)
                path=cache/report_hash
                if not path.is_file(): raise FileNotFoundError('missing locally generated report '+report_hash+' for '+v)
                raw=path.read_bytes()
                if sha(raw)!=report_hash: raise ValueError('local report SHA-256 mismatch '+v)
                report=json.loads(raw)
                full=from_full(report)
                if v in ATTESTED_STATE_COUNTS and sum(len(entry['states']) for entry in report.values()) != ATTESTED_STATE_COUNTS[v]: raise ValueError('attested state count mismatch '+v)
                if set(full)!=set(registry): raise ValueError('local report identifier mismatch '+v)
                for name,known in registry.items():
                    if known is not None and (known['properties']!=full[name]['properties'] or known['defaults']!=full[name]['defaults']):
                        raise ValueError('local report schema mismatch '+v+' '+name)
                registry=full; coverage='exact'; origin='official-full-report'
        else: raise ValueError('unknown source kind '+r['kind'])
        if v in ATTESTED_COUNTS and len(registry)!=ATTESTED_COUNTS[v]: raise ValueError('attested block count mismatch '+v)
        validate_drop(prev,registry,prev_version,r)
        payload={'schema':SCHEMA,'edition':'java','release':v,'blocks':registry}
        delta=diff(prev,registry,prev_version); delta.update(schema=SCHEMA,edition='java',release=v)
        regpath=f'registries/{v}.json.gz'; deltapath=f'deltas/{v}.json.gz'
        regdata=gzip.compress(canonical(payload),compresslevel=9,mtime=0); deltadata=gzip.compress(canonical(delta),compresslevel=9,mtime=0)
        outputs[regpath]=regdata; outputs[deltapath]=deltadata
        known=sum(x is not None for x in registry.values())
        cfg={'schema':SCHEMA,'generator':REVISION,'generator_sha256':generator_hash,'edition':'java','release':v,'data_version':dv,
             'coverage':coverage,'identifier_coverage':'complete-as-reported','schema_coverage':'complete-as-reported' if known==len(registry) else 'partial',
             'legal_combinations_coverage':'complete' if origin=='official-full-report' else 'unknown',
             'feature_flags':'unknown; registry may include experimental or disabled blocks',
             'source_kind':origin,'source_revision':r['revision'],'source_lock_sha256':sha(pretty(lock)),
             'block_count':len(registry),'known_schema_count':known,'unknown_schema_count':len(registry)-known,
             'same_registry_as_previous':prev is not None and prev==registry,
             'registry':{'path':regpath,'sha256':sha(regdata)},'delta':{'path':deltapath,'sha256':sha(deltadata)}}
        config_bytes=pretty(cfg); outputs[f'releases/{v}.json']=config_bytes
        entries.append({'release':v,'data_version':dv,'coverage':coverage,'config':f'releases/{v}.json','sha256':sha(config_bytes)})
        prev=registry; prev_version=v
    outputs['index.json']=pretty({'schema':SCHEMA,'generator':REVISION,'generator_sha256':generator_hash,'source_lock_sha256':sha(pretty(lock)),'edition':'java','unsupported':'pre-1.13, snapshots, Bedrock and modded registries','releases':entries})
    return outputs

def main():
    p=argparse.ArgumentParser(); p.add_argument('--cache',type=Path,default=ROOT/'.cache'); p.add_argument('--output',type=Path,default=ROOT/'generated'); p.add_argument('--lock',type=Path,default=ROOT/'sources.lock.json'); p.add_argument('--fetch',action='store_true'); p.add_argument('--check',action='store_true'); p.add_argument('--verify-server-jars',action='store_true'); args=p.parse_args()
    lock=json.loads(args.lock.read_text()); outputs=build(lock,args.cache,args.fetch,args.verify_server_jars)
    if args.check:
        expected=set(outputs); existing={str(x.relative_to(args.output)) for x in args.output.rglob('*') if x.is_file()}
        if existing!=expected: raise ValueError('generated file set differs: '+str(sorted(existing ^ expected)))
        for path,data in outputs.items():
            if (args.output/path).read_bytes()!=data: raise ValueError('generated output differs: '+path)
        print('verified',len(outputs),'generated files')
    else:
        existing={str(x.relative_to(args.output)) for x in args.output.rglob('*') if x.is_file()} if args.output.exists() else set()
        extra=existing-set(outputs)
        if extra: raise ValueError('refusing to leave stale generated files: '+str(sorted(extra)))
        args.output.mkdir(parents=True,exist_ok=True)
        for path,data in outputs.items():
            dest=args.output/path; dest.parent.mkdir(parents=True,exist_ok=True); dest.write_bytes(data)
        print('generated',len(outputs),'files')

if __name__=='__main__': main()
