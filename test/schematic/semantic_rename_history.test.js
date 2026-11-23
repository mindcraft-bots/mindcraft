import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DATA_ROOT, loadRelease } from '../../schematics/tooling/history_registry.mjs';
import { convertBlueprint, validateHistory } from '../../schematics/tooling/convert_history.mjs';

const history = JSON.parse(readFileSync(new URL('../../schematics/tooling/block_history.v1.json', import.meta.url)));
const releases = JSON.parse(readFileSync(`${DATA_ROOT}/index.json`)).releases;
const opt = { allowUnverified: true };
const fixture = (state, version, dv) => ({ minecraft_version: version, data_version: dv, legend: { A: state } });
const pairs = [
  { old: 'minecraft:grass', modern: 'minecraft:short_grass', last: 3578, first: 3698, url: 'https://minecraft.wiki/w/Java_Edition_1.20.3#Blocks' },
  { old: 'minecraft:grass_path', modern: 'minecraft:dirt_path', last: 2586, first: 2724, url: 'https://minecraft.wiki/w/Java_Edition_1.17#Blocks' },
];

test('pinned profiles corroborate every inventory boundary and known schemas, without inventing unknown schemas', () => {
  for (const entry of releases) {
    const profile = loadRelease(entry.release);
    for (const pair of pairs) {
      const old = profile.dataVersion <= pair.last;
      assert.equal(Object.hasOwn(profile.blocks, pair.old), old, entry.release);
      assert.equal(Object.hasOwn(profile.blocks, pair.modern), !old, entry.release);
      const schema = profile.blocks[old ? pair.old : pair.modern];
      assert.deepEqual(schema.properties, {}, entry.release);
      assert.deepEqual(schema.defaults, {}, entry.release);
    }
  }
  const a = loadRelease('1.13.2'), b = loadRelease('1.14');
  for (const [old, modern] of [['minecraft:sign', 'minecraft:oak_sign'], ['minecraft:wall_sign', 'minecraft:oak_wall_sign']]) {
    assert.deepEqual(a.blocks[old].properties, b.blocks[modern].properties);
    assert.equal(a.blocks[old].combinations, 'cartesian');
    assert.equal(b.blocks[modern].combinations, 'cartesian');
    assert.ok(!history.alternatives.some((e) => e.from === old || e.from === modern));
  }
});

test('reviewed bounds, bidirectional reports and property validation', () => {
  for (const pair of pairs) {
    const forward = history.alternatives.find((e) => e.from === pair.old && e.to === pair.modern);
    const reverse = history.alternatives.find((e) => e.from === pair.modern && e.to === pair.old);
    assert.equal(forward.source.min.dataVersion, 1519);
    assert.equal(forward.source.max.dataVersion, pair.last);
    assert.equal(forward.target.min.dataVersion, pair.first);
    assert.equal(forward.target.max.dataVersion, 5023);
    assert.deepEqual(reverse.source, forward.target);
    assert.deepEqual(reverse.target, forward.source);
    assert.equal(forward.evidence.source, pair.url);
    assert.match(forward.evidence.sourceAttribution, /Minecraft Wiki.*CC BY-NC-SA/);
    assert.match(forward.evidence.registry, /sources.lock.json/);
    for (const [source, version, dv, target, expected] of [
      [pair.old, '1.13', 1519, '1.20.5', pair.modern],
      [pair.old, '1.13.2', 1631, '26.3', pair.modern],
      [pair.modern, '1.20.5', 3837, '1.13', pair.old],
      [pair.modern, '26.3', 5023, '1.13.2', pair.old],
    ]) {
      const result = convertBlueprint(fixture(source, version, dv), target, history, opt);
      assert.equal(result.legend.A, expected);
      assert.deepEqual(result.changes[0].via, [expected]);
      assert.equal(result.changes[0].evidence[0].source, pair.url);
      assert.equal(result.sourceDataVersion, dv);
      assert.equal(result.targetDataVersion, loadRelease(target).dataVersion);
      assert.equal(result.validation, 'NONVALIDATED');
    }
    assert.throws(() => convertBlueprint(fixture(`${pair.old}[snowy=false]`, '1.13', 1519), '1.20.5', history, opt), /complete canonical property set/);
    assert.throws(() => convertBlueprint(fixture(`${pair.modern}[snowy=false]`, '1.20.5', 3837), '1.13', history, opt), /complete canonical property set/);
    assert.throws(() => convertBlueprint(fixture(pair.old, '1.13', 1520), '1.20.5', history, opt), /data_version.*does not match/);
    assert.throws(() => convertBlueprint(fixture(pair.modern, '1.13', 1519), '1.20.5', history, opt), /not a vanilla/);
    assert.throws(() => convertBlueprint(fixture(pair.old, '1.13', 1519), '26.3.1', history, opt), /unsupported or missing/);
    const narrow = structuredClone(history);
    narrow.alternatives.find((e) => e.from === pair.old).source.min = { release: '1.13.1', dataVersion: 1628 };
    assert.throws(() => convertBlueprint(fixture(pair.old, '1.13', 1519), '1.20.5', narrow, opt), /no authored fallback/);
    const invalid = structuredClone(history);
    invalid.alternatives.find((e) => e.from === pair.old).target.min.dataVersion++;
    assert.throws(() => validateHistory(invalid), /DataVersion mismatch/);
    invalid.alternatives.find((e) => e.from === pair.old).target.min.dataVersion--;
    invalid.alternatives.find((e) => e.from === pair.old).source.max.dataVersion++;
    assert.throws(() => validateHistory(invalid), /DataVersion mismatch/);
    const ambiguous = structuredClone(history);
    ambiguous.alternatives.push(structuredClone(forward));
    assert.throws(() => convertBlueprint(fixture(pair.old, '1.13', 1519), '1.20.5', ambiguous, opt), /ambiguous authored fallbacks/);
  }
});

test('independently verified transition releases retain reviewed bounds and unrelated identifiers remain unrelated', () => {
  for (const [old, modern, lastOld, oldDV, firstNew, newDV] of [
    ['minecraft:grass', 'minecraft:short_grass', '1.20.2', 3578, '1.20.3', 3698],
    ['minecraft:grass_path', 'minecraft:dirt_path', '1.16.5', 2586, '1.17', 2724],
  ]) {
    const forward = convertBlueprint(fixture(old, lastOld, oldDV), firstNew, history);
    const reverse = convertBlueprint(fixture(modern, firstNew, newDV), lastOld, history);
    assert.equal(forward.legend.A, modern); assert.equal(forward.validation, 'validated');
    assert.equal(reverse.legend.A, old); assert.equal(reverse.validation, 'validated');
    assert.equal(convertBlueprint(fixture(old, '1.13', 1519), firstNew, history).legend.A, modern);
    const reviewed = convertBlueprint(fixture(modern, '1.20.5', 3837), lastOld, history, opt);
    assert.equal(reviewed.legend.A, old); assert.equal(reviewed.validation, 'NONVALIDATED');
    const verified = convertBlueprint(fixture(old, '1.13', 1519), '1.20.5', history);
    assert.equal(verified.legend.A, modern); assert.equal(verified.validation, 'validated');
  }
  const block = 'minecraft:grass_block[snowy=false]';
  const result = convertBlueprint(fixture(block, '1.13', 1519), '1.20.5', history, opt);
  assert.equal(result.legend.A, block);
  assert.deepEqual(result.changes, []);
});
