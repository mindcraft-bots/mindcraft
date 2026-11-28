import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { plan, derive } from '../../schematics/tooling/symmetry_fix.mjs';
import minecraftData from 'minecraft-data';
import { diagnose, parsePlane, parseState, render, transform } from '../../schematics/tooling/symmetry.mjs';

const tool = new URL('../../schematics/tooling/symmetry_fix.mjs', import.meta.url).pathname;
const bytes = d => Buffer.from(JSON.stringify(d));
const fixture = (last = 'b') => ({ minecraft_version:'1.21.4', data_version:4189, width_x:40, height_y:1, length_z:1,
  legend:{ a:'minecraft:stone', b:'minecraft:dirt', '.':'minecraft:air' }, layers:[['a'.repeat(39)+last]],
  expected_counts: last === 'b' ? {'minecraft:stone':39,'minecraft:dirt':1} : {'minecraft:stone':39,'minecraft:air':1},
  non_air_count:last === 'b' ? 40 : 39, spot_checks:[{x:39,y:0,z:0,char:last}] });
const config = { plane:'x=19.5', bounds:'0,39,0,0,0,0', authoritative:'low', threshold:0.95, allow:[[39,0,0]] };
const cli = (...args) => spawnSync(process.execPath, [tool,...args], {encoding:'utf8'});

test('plan and derive preserve source, track exact changes, update counts and spot checks', () => {
  const original = bytes(fixture()), before = original.toString(), p = plan(original, config);
  assert.equal(p.report.pairs.coverage, 0.95);
  assert.deepEqual(p.changes[0], {from:[0,0,0],to:[39,0,0],source:'minecraft:stone',before:'minecraft:dirt',after:'minecraft:stone',class:'material'});
  const output = JSON.parse(derive(original,p));
  assert.equal(original.toString(), before);
  assert.deepEqual(output.expected_counts, {'minecraft:stone':40});
  assert.equal(output.spot_checks[0].char, 'a');
  assert.equal(diagnose(output, config.plane, config.bounds).exact, true);
  assert.throws(() => derive(bytes({...fixture(), extra:true}),p), /does not exactly match/);
  assert.throws(() => derive(original,{...p,changes:[]}), /does not exactly match/);
});

test('air edits, allowlists, unsafe bounds, center and threshold are explicit', () => {
  const d = fixture('.'), b = bytes(d);
  assert.throws(() => plan(b,{...config,allow:[]}), /allowlist/);
  assert.equal(JSON.parse(derive(b,plan(b,config))).non_air_count,40);
  assert.throws(() => plan(b,{...config,threshold:0.99}), /unsafe agreement/);
  assert.throws(() => plan(b,{...config,bounds:'1,39,0,0,0,0'}), /unsafe region/);
  assert.throws(() => plan(b,{...config,threshold:0.9}), /threshold/);
  d.spot_checks[0].note = 'old material';
  assert.throws(() => plan(bytes(d),config), /annotated spot/);
  const center = {minecraft_version:'1.21.4',data_version:4189,width_x:3,height_y:1,length_z:1,
    legend:{a:'minecraft:stone',b:'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]'},layers:[['aba']],expected_counts:{'minecraft:stone':2,'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]':1},spot_checks:[]};
  assert.throws(() => plan(bytes(center),{...config,plane:'x=1',bounds:'0,2,0,0,0,0',allow:[]}), /center mismatches/);
});

test('high side can explicitly replace solid with air and inconsistent metadata fails closed', () => {
  const d = fixture('.');
  const p = plan(bytes(d),{...config,authoritative:'high',allow:[[0,0,0]]});
  assert.equal(p.changes[0].after,'minecraft:air');
  const out = JSON.parse(derive(bytes(d),p));
  assert.equal(out.non_air_count,38); assert.equal(out.expected_counts['minecraft:air'],2);
  assert.throws(() => plan(bytes({...d,non_air_count:40}),config),/non_air_count inconsistent/);
  assert.throws(() => plan(bytes({...d,expected_counts:{}}),config),/expected_counts inconsistent/);
  assert.throws(() => plan(bytes({...d,spot_checks:[{x:39,y:0,z:0,char:'a'}]}),config),/spot_checks inconsistent/);
});

test('repair requires exact nonempty in-range ordered bounds, including zero coordinates', () => {
  const original = bytes(fixture());
  for (const bounds of ['', ' ', '\t', '0,39,0,0,0,0 ', ' 0,39,0,0,0,0', '0,39,0,0,0,0\n', '0,39,0,0,0,0\r\n',
    '0,39,0,0,0', '0,39,0,0,0,0,0', '0,39,0,0,0,0.0', '-1,39,0,0,0,0',
    '0,,0,0,0,0', '0,40,0,0,0,0', '0,39,0,1,0,0', '0,39,0,0,0,1',
    '39,0,0,0,0,0', '0,39,1,0,0,0', '0,39,0,0,1,0', '0,9007199254740992,0,0,0,0']) {
    assert.throws(() => plan(original, {...config,bounds}), /bounds/, JSON.stringify(bounds));
  }
  assert.deepEqual(plan(original,config).report.bounds, [0,39,0,0,0,0]);
});

test('spot-check state assertions must be valid and match the resolved voxel', () => {
  for (const state of ['minecraft:dirt', 'minecraft:not_a_block', 'minecraft:stone[axis=x]', 'minecraft:stone\n', '', null, 0, {}]) {
    const d = fixture(); d.spot_checks.push({x:0,y:0,z:0,char:'a',state});
    assert.throws(() => plan(bytes(d),config), /spot_checks (?:invalid state|inconsistent state)/, JSON.stringify(state));
  }
  const d = fixture();
  const stairs = 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]';
  d.legend.c = stairs;
  const row = [...d.layers[0][0]]; row[5] = row[34] = 'c'; d.layers[0][0] = row.join('');
  d.expected_counts = {'minecraft:stone':37, [stairs]:2, 'minecraft:dirt':1};
  d.spot_checks.push({x:0,y:0,z:0,char:'a',state:'minecraft:stone'},
    {x:5,y:0,z:0,char:'c',state:'minecraft:oak_stairs[waterlogged=false,shape=straight,half=bottom,facing=north]'});
  const original = bytes(d), output = JSON.parse(derive(original,plan(original,config)));
  assert.deepEqual(output.spot_checks.slice(1), d.spot_checks.slice(1));
  assert.equal(output.spot_checks[0].char, 'a');
  const annotated = fixture(); annotated.spot_checks[0].state = 'minecraft:dirt';
  assert.throws(() => plan(bytes(annotated),config), /annotated spot check.*manual review/);
});

test('CLI rejects invalid bounds and spot-check states without writing source, output, or receipt', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'symmetry-validation-')); t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const src=path.join(dir,'source.json'), cfg=path.join(dir,'config.json'), approved=path.join(dir,'approved.json'), out=path.join(dir,'out.json');
  const valid = bytes(fixture()), validPlan = plan(valid,config);
  const invalidState = fixture(); invalidState.spot_checks.push({x:0,y:0,z:0,char:'a',state:'minecraft:dirt'});
  const cases = [
    {source:valid, config:{...config,bounds:''}, error:/bounds/},
    {source:valid, config:{...config,bounds:' '}, error:/bounds/},
    {source:valid, config:{...config,bounds:'0,40,0,0,0,0'}, error:/bounds/},
    {source:bytes(invalidState), config, error:/spot_checks inconsistent state/},
    {source:bytes({...invalidState,spot_checks:[{x:0,y:0,z:0,char:'a',state:null}]}), config, error:/spot_checks invalid state/},
  ];
  for (const c of cases) {
    fs.writeFileSync(src,c.source); fs.writeFileSync(cfg,JSON.stringify(c.config));
    fs.writeFileSync(approved,JSON.stringify({...validPlan,config:c.config}));
    const originalConfig=fs.readFileSync(cfg), originalApproval=fs.readFileSync(approved);
    for (const args of [['--plan',src,cfg], ['--apply',src,approved,'--output',out]]) {
      const result=cli(...args);
      assert.notEqual(result.status,0); assert.match(result.stderr,c.error); assert.equal(result.stdout,'');
      assert.deepEqual(fs.readFileSync(src),c.source); assert.deepEqual(fs.readFileSync(cfg),originalConfig);
      assert.deepEqual(fs.readFileSync(approved),originalApproval);
      assert.equal(fs.existsSync(out),false); assert.equal(fs.existsSync(out+'.symmetry-audit.json'),false);
    }
  }
  const noMode=cli(src,cfg); assert.notEqual(noMode.status,0); assert.match(noMode.stderr,/usage:/);
  assert.equal(fs.existsSync(out),false); assert.equal(fs.existsSync(out+'.symmetry-audit.json'),false);
});

test('symmetric doors can have either intended or inward hinges; dependent edits fail closed', () => {
  const door = hinge => `minecraft:dark_oak_door[facing=south,half=lower,hinge=${hinge},open=true,powered=false]`;
  for (const [a,b] of [['left','right'],['right','left']]) {
    const d = {minecraft_version:'1.21.4',data_version:4189,width_x:2,height_y:1,length_z:1,legend:{a:door(a),b:door(b)},layers:[['ab']]};
    assert.equal(diagnose(d,'x=0.5').exact,true);
  }
  const d = fixture(); d.legend.b = door('left'); d.expected_counts = {'minecraft:stone':39,[door('left')]:1};
  assert.throws(() => plan(bytes(d),config), /neighbour-dependent/);
});

test('CLI dry run, exact approval, stale hash, no clobber, symlinks and receipt', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'symmetry-')); t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const src=path.join(dir,'source.json'), cfg=path.join(dir,'config.json'), approved=path.join(dir,'approved.json'), out=path.join(dir,'out.json');
  fs.writeFileSync(src,bytes(fixture())); fs.writeFileSync(cfg,JSON.stringify(config));
  const original=fs.readFileSync(src); const dry=cli('--plan',src,cfg);
  assert.equal(dry.status,0,dry.stderr); assert.deepEqual(fs.readFileSync(src),original); assert.equal(fs.existsSync(out),false);
  fs.writeFileSync(approved,dry.stdout);
  fs.writeFileSync(src,Buffer.concat([original,Buffer.from(' ')]));
  assert.notEqual(cli('--apply',src,approved,'--output',out).status,0);
  fs.writeFileSync(src,original);
  fs.symlinkSync(src,path.join(dir,'link.json'));
  assert.notEqual(cli('--plan',path.join(dir,'link.json'),cfg).status,0);
  const linkedOutput=path.join(dir,'linked-output.json'); fs.symlinkSync(path.join(dir,'absent'),linkedOutput);
  assert.notEqual(cli('--apply',src,approved,'--output',linkedOutput).status,0);
  const applied=cli('--apply',src,approved,'--output',out);
  assert.equal(applied.status,0,applied.stderr);
  const receipt=JSON.parse(fs.readFileSync(out+'.symmetry-audit.json'));
  assert.equal(receipt.approved_patch.changes.length,1); assert.match(receipt.output_sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(fs.readFileSync(src),original);
  assert.notEqual(cli('--apply',src,approved,'--output',out).status,0);
});

test('rotation and both diagonal reflections preserve complete state', () => {
  const f = (legend,rows) => ({minecraft_version:'1.21.4',data_version:4189,width_x:rows[0].length,height_y:1,length_z:rows.length,legend,layers:[rows]});
  assert.equal(diagnose(f({a:'minecraft:oak_sign[rotation=4,waterlogged=true]',b:'minecraft:oak_sign[rotation=12,waterlogged=true]'},['ab']),'x=0.5').exact,true);
  assert.equal(diagnose(f({'.':'minecraft:air',a:'minecraft:oak_log[axis=x]',b:'minecraft:oak_log[axis=z]'},['a.','.b']),'x=-z+1').exact,true);
});

test('directional reflections are involutions and preserve all unrelated properties', () => {
  const registry=minecraftData('1.21.4');
  const states=[
    ...Array.from({length:16},(_,n)=>`minecraft:oak_sign[rotation=${n},waterlogged=true]`),
    'minecraft:dark_oak_door[facing=east,half=upper,hinge=left,open=true,powered=false]',
    'minecraft:oak_stairs[facing=north,half=top,shape=outer_left,waterlogged=true]',
    'minecraft:oak_log[axis=x]',
    ...['north_south','east_west','ascending_east','ascending_west','ascending_north','ascending_south','south_east','south_west','north_west','north_east'].map(s=>`minecraft:rail[shape=${s},waterlogged=true]`),
  ];
  for (const text of states) for (const p of ['x=0','z=0','x=z','x=-z+3']) {
    const original=parseState(text,registry), plane=parsePlane(p);
    const mirrored=transform(original,plane);
    assert.equal(render(transform(mirrored,plane)),render(original),`${text} ${p}`);
    assert.equal(render(parseState(render(mirrored),registry)),render(mirrored));
  }
});
