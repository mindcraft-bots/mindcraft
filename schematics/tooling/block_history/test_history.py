#!/usr/bin/env python3
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('block_history_generator',ROOT/'generate.py')
g=importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
DATA=ROOT/'generated'

def load(path): return json.loads(path.read_bytes())
def zipped(path): return json.loads(gzip.decompress(path.read_bytes()))

class PublishedDataTests(unittest.TestCase):
    def test_index_identity_hashes_and_all_profiles(self):
        index=load(DATA/'index.json'); lock=load(ROOT/'sources.lock.json')
        self.assertEqual(index['source_lock_sha256'],g.sha(g.pretty(lock)))
        self.assertEqual(index['generator_sha256'],g.sha((ROOT/'generate.py').read_bytes()))
        entries=index['releases']; versions=[e['release'] for e in entries]
        self.assertEqual(len(versions),51); self.assertEqual(versions,sorted(versions,key=g.semver)); self.assertEqual(len(set(versions)),len(versions))
        self.assertEqual(versions,[x['version'] for x in lock['releases']])
        for entry in entries:
            raw=(DATA/entry['config']).read_bytes(); self.assertEqual(g.sha(raw),entry['sha256']); cfg=json.loads(raw)
            self.assertEqual(cfg['edition'],'java'); self.assertEqual(cfg['release'],entry['release'])
            self.assertEqual(cfg['coverage'],entry['coverage']); self.assertIn('unknown',cfg['feature_flags'])
            for key in ('registry','delta'):
                raw=(DATA/cfg[key]['path']).read_bytes(); self.assertEqual(g.sha(raw),cfg[key]['sha256'])
                self.assertEqual(json.loads(gzip.decompress(raw))['release'],cfg['release'])

    def test_independently_generated_official_counts(self):
        # Expected values independently obtained from the Mojang server reports;
        # the jar and report hashes and generation procedure are in PROVENANCE.md.
        for v,count,dv in [('1.13',593,1519),('1.14',676,1952),('1.15.2',680,2230),('1.16.5',763,2586),('1.17',898,2724),('1.18.2',898,2975),('1.19.4',998,3337),('1.20.2',1003,3578),('1.20.4',1058,3700),('1.21.2',1084,4080),('1.21.7',1105,4438),('26.3',1286,5023)]:
            cfg=load(DATA/'releases'/f'{v}.json'); reg=zipped(DATA/cfg['registry']['path'])
            self.assertEqual(len(reg['blocks']),count); self.assertEqual(cfg['block_count'],count); self.assertEqual(cfg['data_version'],dv)

    def test_baseline_and_real_deltas(self):
        baseline=zipped(DATA/'deltas/1.13.json.gz'); self.assertEqual(baseline['kind'],'baseline'); self.assertEqual(len(baseline['baseline']),593); self.assertFalse(baseline['added'])
        wall=zipped(DATA/'deltas/1.16.json.gz')['changed']['minecraft:cobblestone_wall']
        self.assertEqual(wall['before']['properties']['east'],['false','true']); self.assertEqual(wall['after']['properties']['east'],['low','none','tall'])
        chain=zipped(DATA/'deltas/1.21.9.json.gz'); self.assertIn('minecraft:chain',chain['removed']); self.assertIn('minecraft:iron_chain',chain['added']); self.assertNotIn('alternatives',chain)

    def test_report_establishes_previously_unknown_schemas(self):
        cfg=load(DATA/'releases/1.14.json'); blocks=zipped(DATA/cfg['registry']['path'])['blocks']
        self.assertEqual(cfg['coverage'],'exact'); self.assertEqual(len(blocks),676); self.assertEqual(cfg['unknown_schema_count'],0)
        self.assertEqual(blocks['minecraft:stone'],{'properties':{},'defaults':{},'combinations':'cartesian'}); self.assertIsNotNone(blocks['minecraft:oak_stairs'])
        self.assertEqual(zipped(DATA/'registries/1.20.5.json.gz')['blocks']['minecraft:stone']['properties'],{})

    def test_exact_local_reports_are_independently_attested_per_release(self):
        cfg=load(DATA/'releases/1.20.2.json'); blocks=zipped(DATA/cfg['registry']['path'])['blocks']
        self.assertEqual((cfg['coverage'],cfg['schema_coverage'],cfg['legal_combinations_coverage']),('exact','complete-as-reported','complete'))
        self.assertEqual((cfg['known_schema_count'],cfg['unknown_schema_count']),(1003,0))
        for name in ('minecraft:air','minecraft:stone'):
            self.assertEqual(blocks[name],{'properties':{},'defaults':{},'combinations':'cartesian'})
            for v in ('1.20.1','1.20.3'):
                self.assertEqual(zipped(DATA/f'registries/{v}.json.gz')['blocks'][name],blocks[name])
        self.assertTrue(all(x['combinations']=='cartesian' for x in blocks.values()))
        lock=load(ROOT/'sources.lock.json'); by={r['version']:r for r in lock['releases']}
        for v in g.LOCAL_REPORT_ATTESTATIONS:
            att=by[v]['local_report']; cfg=load(DATA/'releases'/f'{v}.json')
            self.assertEqual((att['server']['sha256'],att['sha256']),g.LOCAL_REPORT_ATTESTATIONS[v])
            self.assertEqual(cfg['data_version'],g.LOCAL_REPORT_DATA_VERSIONS[v])
            self.assertEqual((cfg['coverage'],cfg['legal_combinations_coverage']),('exact','complete'))
            self.assertEqual(cfg['block_count'],g.ATTESTED_COUNTS[v])
        for v, states in g.ATTESTED_STATE_COUNTS.items():
            blocks=zipped(DATA/f'registries/{v}.json.gz')['blocks']
            self.assertTrue(all(x is not None and x['combinations']=='cartesian' for x in blocks.values()))
            import math
            self.assertEqual(sum(math.prod(map(len,x['properties'].values())) for x in blocks.values()),states)
        self.assertNotEqual(by['1.20.1']['local_report']['server']['sha256'],by['1.20.2']['local_report']['server']['sha256'])
        self.assertEqual(by['1.20.3']['local_report']['sha256'],by['1.20.4']['local_report']['sha256'])
        self.assertNotEqual(by['1.20.3']['local_report']['server']['sha256'],by['1.20.4']['local_report']['server']['sha256'])

    def test_same_schema_versions_are_individual(self):
        a=load(DATA/'releases/1.13.1.json'); b=load(DATA/'releases/1.13.2.json')
        self.assertNotEqual(a['data_version'],b['data_version']); self.assertEqual(b['coverage'],'shared'); self.assertTrue(b['same_registry_as_previous'])
        delta=zipped(DATA/b['delta']['path']); self.assertEqual(delta['from'],'1.13.1'); self.assertFalse(delta['added'] or delta['removed'] or delta['changed'])
        self.assertTrue(load(DATA/'releases/1.21.7.json')['same_registry_as_previous'])

    def test_semantic_order(self):
        self.assertEqual(sorted(['1.21.10','26.1','1.9','1.21.9','1.13'],key=g.semver),['1.9','1.13','1.21.9','1.21.10','26.1'])
        for bad in ['1.21-pre1','bedrock','1','1.2.3.4']:
            with self.assertRaises(ValueError): g.semver(bad)

class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup); self.cache=Path(self.temp.name)
        self.commit='a'*40
        def source(url, data, sha1=False):
            b=g.canonical(data); h=g.sha(b); (self.cache/h).write_bytes(b); src={'url':url,'sha256':h}
            if sha1: src['sha1']=hashlib.sha1(b).hexdigest()
            return src
        self.source=source; entries=[]; releases=[]
        for i,v in enumerate(['1.30','1.30.1','1.31']):
            url='https://example.test/'+v; metadata=source(url,{'id':v,'type':'release'},True)
            entries.append({'id':v,'type':'release','url':url,'sha1':metadata['sha1']})
            commit=('%040x' % (i+1)); base='https://raw.githubusercontent.com/misode/mcmeta/'+commit+'/'
            releases.append({'version':v,'kind':'mcmeta-summary','revision':commit,'mojang_metadata':metadata,
              'version_info':source(base+'version.json',{'id':v,'type':'release','data_version':i+1}),
              'registries':source(base+'registries/data.json',{'block':['stone','oak_stairs']}),
              'blocks':source(base+'blocks/data.json',{'oak_stairs':[{'facing':['north','south']},{'facing':'north'}]})})
        manifest=source('https://example.test/manifest',{'versions':entries})
        self.lock={'schema':1,'edition':'java','manifest':manifest,'releases':releases}

    def test_deterministic_build_and_checks(self):
        a=g.build(self.lock,self.cache); b=g.build(self.lock,self.cache); self.assertEqual(a,b)
        self.assertIsNone(json.loads(gzip.decompress(a['registries/1.30.json.gz']))['blocks']['minecraft:stone'])
        self.assertEqual(json.loads(a['releases/1.30.1.json'])['coverage'],'partial')

    def test_cli_check_detects_output_tampering_and_stale_files(self):
        lockfile=self.cache/'lock.json'; lockfile.write_bytes(g.pretty(self.lock)); output=self.cache/'out'
        command=[sys.executable,str(ROOT/'generate.py'),'--lock',str(lockfile),'--cache',str(self.cache),'--output',str(output)]
        subprocess.run(command,check=True,capture_output=True)
        subprocess.run(command+['--check'],check=True,capture_output=True)
        target=output/'releases/1.30.json'; original=target.read_bytes(); target.write_bytes(b'tampered')
        result=subprocess.run(command+['--check'],capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0); self.assertIn('generated output differs',result.stderr)
        target.write_bytes(original); (output/'stale.json').write_text('{}')
        result=subprocess.run(command,capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0); self.assertIn('stale generated files',result.stderr)

    def test_tampered_and_missing_source_fail_closed(self):
        src=self.lock['releases'][0]['blocks']; path=self.cache/src['sha256']; original=path.read_bytes(); path.write_bytes(b'bad')
        with self.assertRaisesRegex(ValueError,'SHA-256 mismatch'): g.build(self.lock,self.cache)
        path.write_bytes(original); path.unlink()
        with self.assertRaisesRegex(FileNotFoundError,'missing pinned source'): g.build(self.lock,self.cache)

    def test_stale_fallback_identity_rejected(self):
        r=self.lock['releases'][1]; base='https://raw.githubusercontent.com/misode/mcmeta/'+r['revision']+'/'
        r['version_info']=self.source(base+'version.json',{'id':'1.30','type':'release','data_version':2})
        with self.assertRaisesRegex(ValueError,'stale or invalid release identity'): g.build(self.lock,self.cache)

    def test_missing_release_no_stale_reuse(self):
        r=self.lock['releases'][1]; r['kind']='unavailable'; r['reason']='report missing'
        out=g.build(self.lock,self.cache); self.assertEqual(json.loads(out['releases/1.30.1.json'])['coverage'],'unavailable')
        self.assertNotIn('registries/1.30.1.json.gz',out)
        delta=json.loads(gzip.decompress(out['deltas/1.31.json.gz'])); self.assertEqual(delta['kind'],'after_gap'); self.assertFalse(delta['added']); self.assertFalse(delta['removed'])

    def test_manifest_mismatch_and_commit_conflicts_rejected(self):
        bad=copy.deepcopy(self.lock); bad['releases'].pop()
        with self.assertRaisesRegex(ValueError,'manifest inventory'): g.build(bad,self.cache)
        bad=copy.deepcopy(self.lock); bad['releases'][0]['revision']='b'*40
        with self.assertRaisesRegex(ValueError,'revision mismatch'): g.build(bad,self.cache)

    def full_lock(self):
        lock=copy.deepcopy(self.lock)
        versions=[r['version'] for r in lock['releases']]
        data=g.canonical([{'minecraftVersion':v,'dataVersion':i+1} for i,v in enumerate(versions)])
        buf=io.BytesIO()
        with tarfile.open(fileobj=buf,mode='w:gz') as tar:
            info=tarfile.TarInfo('package/minecraft-data/data/pc/common/protocolVersions.json'); info.size=len(data); tar.addfile(info,io.BytesIO(data))
        tarbytes=buf.getvalue(); digest=g.sha(tarbytes); (self.cache/digest).write_bytes(tarbytes)
        dv={'url':'https://example.test/data.tgz','sha256':digest}
        for r in lock['releases']:
            v=r['version']; jar=('jar '+v).encode(); h=g.sha(jar); (self.cache/h).write_bytes(jar)
            server={'url':'https://example.test/'+v+'/server.jar','sha256':h,'sha1':hashlib.sha1(jar).hexdigest()}
            url=r['mojang_metadata']['url']; meta=self.source(url,{'id':v,'type':'release','downloads':{'server':server}},True)
            r['mojang_metadata']=meta
            manifest=json.loads((self.cache/lock['manifest']['sha256']).read_bytes())
            next(x for x in manifest['versions'] if x['id']==v)['sha1']=meta['sha1']
            lock['manifest']=self.source(lock['manifest']['url'],manifest)
            report=self.source('https://raw.githubusercontent.com/Arcensoth/mcdata/'+r['revision']+'/generated/reports/blocks.json',{'minecraft:stone':{'states':[{'default':True}]},'minecraft:oak_stairs':{'states':[{'default':True}]}})
            r.update(kind='official-full-report',server=server,report=report,official_report_sha256=report['sha256'],data_version_source=copy.deepcopy(dv))
        return lock

    def test_empty_inventories_and_identifiers(self):
        with self.assertRaisesRegex(ValueError,'inventory'): g.from_full({})
        with self.assertRaisesRegex(ValueError,'registry'): g.from_summary([], {})
        for bad in ('minecraft:', 'minecraft:Bad', 'minecraft:two:colons', 'other:stone', 'minecraft:stone space', 'minecraft:é', 'minecraft:stone\n'):
            with self.subTest(bad=bad):
                with self.assertRaisesRegex(ValueError,'identifier'): g.from_full({bad:{'states':[{'default':True}]}})
                with self.assertRaisesRegex(ValueError,'identifier'): g.from_summary([bad],{})
        with self.assertRaisesRegex(ValueError,'identifier'): g.from_full({'stone':{'states':[{'default':True}]}})
        self.assertIn('minecraft:stone',g.from_summary(['stone'],{}))
        with self.assertRaisesRegex(ValueError,'duplicate identifier'): g.from_summary(['stone','minecraft:stone'],{})

    def test_empty_and_corrupted_counts_cannot_create_adjacent_deltas(self):
        for kind in ('summary','full'):
            for index in (0,1,2):
                with self.subTest(kind=kind,index=index):
                    lock=self.full_lock() if kind=='full' else copy.deepcopy(self.lock)
                    r=lock['releases'][index]
                    if kind=='full':
                        r['report']=self.source(r['report']['url'],{}); r['official_report_sha256']=r['report']['sha256']
                    else: r['registries']=self.source(r['registries']['url'],{'block':[]}); r['blocks']=self.source(r['blocks']['url'],{})
                    with self.assertRaisesRegex(ValueError,'empty or invalid'): g.build(lock,self.cache)
        lock=copy.deepcopy(self.lock); r=lock['releases'][1]
        r['registries']=self.source(r['registries']['url'],{'block':['stone']}); r['blocks']=self.source(r['blocks']['url'],{})
        with mock.patch.dict(g.ATTESTED_COUNTS,{'1.30.1':2}):
            with self.assertRaisesRegex(ValueError,'attested block count mismatch'): g.build(lock,self.cache)
        full=self.full_lock(); rfull=full['releases'][1]
        rfull['report']=self.source(rfull['report']['url'],{'minecraft:stone':{'states':[{'default':True}]}})
        rfull['official_report_sha256']=rfull['report']['sha256']
        with mock.patch.dict(g.ATTESTED_COUNTS,{'1.30.1':2}):
            with self.assertRaisesRegex(ValueError,'attested block count mismatch'): g.build(full,self.cache)
        with self.assertRaisesRegex(ValueError,'large adjacent removal'): g.build(lock,self.cache)
        removed=['minecraft:oak_stairs']
        r['large_drop_review']={'from':'1.30','removed_count':1,'removed_sha256':g.sha(g.canonical(removed)),'reason':'Reviewed fixture removal'}
        out=g.build(lock,self.cache)
        delta=json.loads(gzip.decompress(out['deltas/1.30.1.json.gz']))
        self.assertEqual(delta['removed'],removed)
        next_delta=json.loads(gzip.decompress(out['deltas/1.31.json.gz']))
        self.assertEqual(next_delta['added'],removed)
        r['large_drop_review']['removed_sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'large adjacent removal'): g.build(lock,self.cache)
        r.pop('large_drop_review'); r['registries']=self.source(r['registries']['url'],{'block':['stone','new_block']})
        with self.assertRaisesRegex(ValueError,'large adjacent removal'): g.build(lock,self.cache)

    def test_full_source_descriptors_and_server_attestations(self):
        lock=self.full_lock(); g.build(lock,self.cache,verify_server_jars=True)
        for field,value in [('sha256','bad'),('sha1','bad'),('sha256','0'*64)]:
            bad=copy.deepcopy(lock); r=bad['releases'][0]; r['server'][field]=value
            with mock.patch.dict(g.FULL_ATTESTATIONS,{'1.30':(lock['releases'][0]['server']['sha256'],r['official_report_sha256'])}):
                with self.assertRaises(ValueError): g.build(bad,self.cache)
        bad=copy.deepcopy(lock); bad['releases'][1]['data_version_source']['sha256']='bad'
        with self.assertRaisesRegex(ValueError,'digest'): g.build(bad,self.cache)
        bad=copy.deepcopy(lock); bad['releases'][1]['data_version_source']['url']='https://example.test/other.tgz'
        with self.assertRaisesRegex(ValueError,'conflicting data version source'): g.build(bad,self.cache)
        bad=copy.deepcopy(lock); bad['releases'][1]['data_version_source']['sha1']='0'*40
        with self.assertRaisesRegex(ValueError,'SHA-1 mismatch'): g.build(bad,self.cache)
        bad=copy.deepcopy(lock); dv=bad['releases'][0]['data_version_source']
        dv['sha1']=hashlib.sha1((self.cache/dv['sha256']).read_bytes()).hexdigest()
        bad['releases'][1]['data_version_source']['sha1']='0'*40
        with self.assertRaisesRegex(ValueError,'conflicting source SHA-256 hashes'): g.build(bad,self.cache)
        bad=copy.deepcopy(lock); bad['releases'][1]['official_report_sha256']='invalid'
        with self.assertRaisesRegex(ValueError,'digest'): g.build(bad,self.cache)
        jar=lock['releases'][0]['server']; (self.cache/jar['sha256']).write_bytes(b'tampered')
        g.build(lock,self.cache)  # Normal offline generation does not consume jars.
        with self.assertRaisesRegex(ValueError,'SHA-256 mismatch'): g.build(lock,self.cache,verify_server_jars=True)

    def test_conflicting_descriptors_rejected(self):
        bad=self.full_lock(); bad['releases'][1]['revision']=bad['releases'][0]['revision']
        bad['releases'][1]['report']['url']=bad['releases'][0]['report']['url']
        bad['releases'][1]['report']['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'conflicting source URL hashes'): g.build(bad,self.cache)

    def test_local_report_is_release_bound_and_fails_closed(self):
        lock=copy.deepcopy(self.lock); r=lock['releases'][1]; v=r['version']
        jar=b'fixture jar'; jarhash=g.sha(jar); (self.cache/jarhash).write_bytes(jar)
        server={'url':'https://example.test/server.jar','sha1':hashlib.sha1(jar).hexdigest(),'sha256':jarhash}
        meta=self.source(r['mojang_metadata']['url'],{'id':v,'type':'release','downloads':{'server':server},'javaVersion':{'majorVersion':17}},True)
        r['mojang_metadata']=meta
        manifest=json.loads((self.cache/lock['manifest']['sha256']).read_bytes()); next(x for x in manifest['versions'] if x['id']==v)['sha1']=meta['sha1']
        lock['manifest']=self.source(lock['manifest']['url'],manifest)
        report={'minecraft:stone':{'states':[{'default':True}]},'minecraft:oak_stairs':{'properties':{'facing':['north','south']},'states':[{'properties':{'facing':'north'},'default':True},{'properties':{'facing':'south'}}]}}
        data=g.canonical(report); digest=g.sha(data); path=self.cache/digest; path.write_bytes(data)
        r['local_report']={'server':server,'sha256':digest,'java_major':17}
        with mock.patch.dict(g.LOCAL_REPORT_ATTESTATIONS,{v:(jarhash,digest)}), mock.patch.dict(g.LOCAL_REPORT_DATA_VERSIONS,{v:2}):
            out=g.build(lock,self.cache,verify_server_jars=True)
            with mock.patch.dict(g.ATTESTED_STATE_COUNTS,{v:4}):
                with self.assertRaisesRegex(ValueError,'attested state count mismatch'): g.build(lock,self.cache)
            with mock.patch.dict(g.ATTESTED_STATE_COUNTS,{v:3}):
                self.assertEqual(out,g.build(lock,self.cache,verify_server_jars=True))
            self.assertEqual(json.loads(out['releases/1.30.1.json'])['coverage'],'exact')
            self.assertIsNone(json.loads(gzip.decompress(out['registries/1.30.json.gz']))['blocks']['minecraft:stone'])
            with mock.patch.dict(g.LOCAL_REPORT_DATA_VERSIONS,{v:-1}):
                with self.assertRaisesRegex(ValueError,'local report DataVersion mismatch'): g.build(lock,self.cache)
            bad=copy.deepcopy(lock); bad['releases'][1]['local_report']['java_major']=8
            with self.assertRaisesRegex(ValueError,'Java version mismatch'): g.build(bad,self.cache)
            bad=copy.deepcopy(lock); del bad['releases'][1]['local_report']
            with self.assertRaisesRegex(ValueError,'missing local report attestation'): g.build(bad,self.cache)
            bad=copy.deepcopy(lock); block=bad['releases'][1]['blocks']
            block['sha256']=self.source(block['url'],{'oak_stairs':[{'facing':['north','south']},{'facing':'south'}]})['sha256']
            with self.assertRaisesRegex(ValueError,'local report schema mismatch'): g.build(bad,self.cache)
            path.write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError,'local report SHA-256 mismatch'): g.build(lock,self.cache)
            path.unlink()
            with self.assertRaisesRegex(FileNotFoundError,'missing locally generated report'): g.build(lock,self.cache,fetch=True)
        with self.assertRaisesRegex(ValueError,'attestation mismatch'): g.build(lock,self.cache)

    def test_full_report_preserves_non_cartesian_combinations(self):
        report={'minecraft:test':{'properties':{'a':['x','y'],'b':['x','y']},'states':[{'default':True,'properties':{'a':'x','b':'x'}},{'properties':{'a':'y','b':'y'}}]}}
        self.assertEqual(g.from_full(report)['minecraft:test']['combinations'],[['x','x'],['y','y']])
        report['minecraft:test']['states'].append(report['minecraft:test']['states'][1])
        with self.assertRaisesRegex(ValueError,'duplicate state'): g.from_full(report)

    def test_early_server_identity_exceptions_are_exact(self):
        sys.path.insert(0,str(ROOT)); self.addCleanup(sys.path.remove,str(ROOT))
        import report_batch
        identity={'id':'1.14.1 / a8f78b0d43c74598a199d6d80cda413f','name':'1.14.1','release_target':'1.14.1','world_version':1957,'stable':False}
        report_batch.validate_identity(identity,'1.14.1',1957)
        for key,value in [('id','1.14.1'),('stable',True),('release_target','1.14'),('world_version',1958)]:
            bad=dict(identity); bad[key]=value
            with self.assertRaisesRegex(ValueError,'identity/DataVersion mismatch'): report_batch.validate_identity(bad,'1.14.1',1957)
        digest=report_batch.cache_bytes(self.cache,b'report')
        self.assertEqual(report_batch.cache_bytes(self.cache,b'report'),digest)
        (self.cache/digest).write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError,'existing cache entry'): report_batch.cache_bytes(self.cache,b'report')

if __name__=='__main__': unittest.main()
