import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import nbt from 'prismarine-nbt';
import minecraftData from 'minecraft-data';
import { SCHEMATICS_DIR, listSchematics, listSchematicEntries, resolveSchematicPath } from '../../src/utils/schematic/paths.js';
import { schematicProvenance } from '../../src/utils/schematic/provenance.js';
import { buildSchematic } from '../../src/utils/schematic/build_schematic.js';
import { readSchematic } from '../../src/utils/schematic/reader.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
import { fixtureBlueprint as blueprint, fixtureBlueprintHash } from './provenance_fixture.js';
const consent = version => ({ version, allowNonvalidatedSchematic: true });
function sponge(version, block = 'minecraft:stone') {
  const tag = (type, value) => ({ type, value });
  return gzipSync(nbt.writeUncompressed({ type: 'compound', name: 'Schematic', value: {
    Version: tag('int', 2), DataVersion: tag('int', minecraftData.versions.pc.find(v => v.minecraftVersion === version).dataVersion),
    Width: tag('short', 1), Height: tag('short', 1), Length: tag('short', 1), PaletteMax: tag('int', 1),
    Palette: tag('compound', { [block]: tag('int', 0) }), BlockData: tag('byteArray', [0]),
  } }));
}
async function artifact(filename, version, fields = {}, block) {
  const bytes = sponge(version, block);
  await writeFile(filename, bytes);
  const report = { schemaVersion: 1, artifact: path.basename(filename), sha256: sha(bytes), validation: 'NONVALIDATED',
    blueprint, blueprintSha256: fixtureBlueprintHash,
    targetVersion: null, convertTo: null, packReport: null, packReportSha256: null, ...fields };
  await reportFile(filename, report);
  return bytes;
}
async function reportFile(filename, report) {
  const text = JSON.stringify(report);
  await writeFile(`${filename}.provenance.json`, text);
  await writeFile(`${filename}.provenance.sha256`, `${sha(Buffer.from(text))}\n`);
}
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'strict-selection-'));
  const pack = path.join(root, 'schems/pack3');
  await mkdir(pack, { recursive: true });
  try { await run(root, pack); } finally { await rm(root, { recursive: true, force: true }); }
}

test('eligibility precedes ambiguity; exact filenames pin independently of siblings and owners', async () => {
  await fixture(async (root, pack) => {
    await writeFile(path.join(pack, 'index.json'), JSON.stringify({ schemaVersion: 2, groups: { 1: { 1: 'ship.schem', 2: 'ship.mc26.1.nonvalidated.schem' } } }));
    for (const version of ['1.21.4', '26.1']) {
      await artifact(path.join(pack, `ship.mc${version}.schem`), version);
      if (version === '26.1') await artifact(path.join(pack, `ship.mc${version}.nonvalidated.schem`), version, { convertTo: version });
    }
    assert.equal(path.basename(await resolveSchematicPath('pack3:1:1', root, consent('1.21.4'))), 'ship.mc1.21.4.schem');
    await artifact(path.join(pack, 'ship.mc1.21.4.nonvalidated.schem'), '1.21.4', { convertTo: '1.21.4' });
    await assert.rejects(resolveSchematicPath('pack3:ship', root, consent('1.21.4')), /Ambiguous/);
    assert.equal(path.basename(await resolveSchematicPath('pack3:ship.mc1.21.4.schem', root, consent('1.21.4'))), 'ship.mc1.21.4.schem');
    await rm(path.join(pack, 'ship.mc1.21.4.nonvalidated.schem.provenance.sha256'));
    assert.equal(path.basename(await resolveSchematicPath('pack3:ship', root, consent('1.21.4'))), 'ship.mc1.21.4.schem');
    await writeFile(path.join(pack, 'index.json'), JSON.stringify({ schemaVersion: 2, groups: { 1: { 1: 'ship.schem' } } }));
    assert.equal(path.basename(await resolveSchematicPath('pack3:ship', root, consent('1.21.4'))), 'ship.mc1.21.4.schem');
    await assert.rejects(resolveSchematicPath('pack3:ship', root, consent('26.1')), /Ambiguous/);
    assert.equal(path.basename(await resolveSchematicPath('pack3:ship.mc26.1.schem', root, consent('26.1'))), 'ship.mc26.1.schem');
    await rm(path.join(pack, 'ship.mc26.1.nonvalidated.schem.provenance.sha256'));
    assert.equal(path.basename(await resolveSchematicPath('pack3:ship', root, consent('26.1'))), 'ship.mc26.1.schem');
    assert.equal(path.basename(await resolveSchematicPath('pack3:ship', root, consent('1.21.4'))), 'ship.mc1.21.4.schem');
  });
});

test('root listing uses complete families and isolates malformed and ambiguous families', async () => {
  await fixture(async root => {
    for (const name of ['good.mc1.21.4.schem', 'clash.mc1.21.4.schem', 'bad.mc1.2.mc1.21.4.schem']) await artifact(path.join(root, name), '1.21.4');
    await artifact(path.join(root, 'clash.mc1.21.4.nonvalidated.schem'), '1.21.4', { convertTo: '1.21.4' });
    const entries = await listSchematicEntries(root, consent('1.21.4'));
    assert.equal(entries.find(e => e.fileName.startsWith('good.')).selected, true);
    for (const entry of entries.filter(e => e.fileName.startsWith('clash.'))) {
      assert.equal(entry.selected, false); assert.match(entry.selectionError, /Ambiguous/);
    }
    assert.match(entries.find(e => e.fileName.startsWith('bad.')).selectionError, /Invalid schematic variant/);
    assert.deepEqual(await listSchematics(root, consent('1.21.4')), ['good.mc1.21.4.schem']);
    await assert.rejects(resolveSchematicPath('clash.schem', root, consent('1.21.4')), /Ambiguous/);
    assert.equal(path.basename(await resolveSchematicPath('good.schem', root, consent('1.21.4'))), 'good.mc1.21.4.schem');
  });
});

test('canonical nonvalidated metadata must be known, consistent and match bytes and filename; denial explains consent', async () => {
  await fixture(async (root, pack) => {
    const file = path.join(pack, 'single.mc1.21.4.schem');
    await artifact(file, '1.21.4');
    const original = JSON.parse(await readFile(`${file}.provenance.json`, 'utf8'));
    for (const fields of [
      { targetVersion: '1.21.4', convertTo: '1.21.4' },
      { targetVersion: '99.99' }, { convertTo: '99.99' },
      { targetVersion: '26.1' }, { convertTo: '26.1' },
    ]) {
      await reportFile(file, { ...original, ...fields });
      assert.equal((await schematicProvenance(file)).validationStatus, 'INVALID', JSON.stringify(fields));
      await assert.rejects(resolveSchematicPath('pack3:single', root, consent('26.1')), /INVALID/);
    }
    const mismatch = path.join(pack, 'mismatch.mc1.21.4.schem');
    await artifact(mismatch, '26.1', { targetVersion: '1.21.4' });
    assert.equal((await schematicProvenance(mismatch)).validationStatus, 'INVALID');
    for (const fields of [{ targetVersion: '1.21.4' }, { convertTo: '1.21.4' }, {}]) {
      await reportFile(file, { ...original, ...fields });
      assert.equal((await schematicProvenance(file)).validationStatus, 'NONVALIDATED');
    }
    await assert.rejects(resolveSchematicPath('pack3:single', root, { version: '1.21.4' }), /NONVALIDATED.*allow_nonvalidated_schematic_builds=true/);
    await assert.rejects(resolveSchematicPath('single.schem', pack, { version: '1.21.4' }), /NONVALIDATED.*allow_nonvalidated_schematic_builds=true/);
    await assert.rejects(resolveSchematicPath('pack3:single', root, { version: '1.21.4', requireStrictSchematicValidation: true }), /NONVALIDATED/);
  });
});

test('build consumes selected bytes despite replacement and recovery rejects changed snapshots without mutation', async () => {
  await fixture(async root => {
    const file = path.join(root, 'race.mc1.21.4.schem');
    const original = await artifact(file, '1.21.4');
    const bot = Object.assign(new EventEmitter(), { version: '1.21.4', registry: minecraftData('1.21.4'),
      game: { dimension: 'overworld', gameMode: 'survival' }, entity: {}, world: {}, _client: new EventEmitter() });
    let mutations = 0, parsed;
    const logs = [];
    const dependencies = { allowNonvalidatedSchematic: true, requireSelectionSnapshot: true,
      resolvePath: async (selector, _directory, options) => {
        const snapshot = await resolveSchematicPath(selector, root, options);
        await artifact(file, '26.1');
        return snapshot;
      },
      readSchematic: async (bytes, version, _class, registry) => { parsed = Buffer.from(bytes); return readSchematic(bytes, version, undefined, registry); },
      makeBuild: () => { throw new Error('stop before mutation'); },
      changeGameMode: async () => { mutations++; }, writeLog: message => logs.push(message),
    };
    assert.equal(await buildSchematic(bot, 'race.schem', 0, 0, 0, dependencies), false);
    assert.deepEqual(parsed, original);
    assert.equal(mutations, 0);
    assert.match(logs.join(' '), /stop before mutation/);
    await artifact(file, '1.21.4', {}, 'minecraft:dirt');
    const session = { cancelled: false, resumeEligible: true, context: { selector: 'race.schem', resolvedPath: file,
      source: original, schematic: {}, origin: { x: 0, y: 0, z: 0 } } };
    assert.equal(await buildSchematic(bot, 'race.schem', 0, 0, 0, { ...dependencies, resumeSession: session,
      resolvePath: (selector, _directory, options) => resolveSchematicPath(selector, root, options) }), false);
    assert.equal(session.cancelled, true);
    assert.match(logs.at(-1), /asset changed/);
    assert.equal(mutations, 0);

    const current = await readFile(file);
    const provenance = await schematicProvenance(file, current);
    const makeSession = () => ({ cancelled: false, resumeEligible: true, context: { selector: 'race.schem', resolvedPath: file,
      source: Buffer.from(current), sourceSha256: sha(current), provenanceIdentity: provenance.identity, schematic: {}, origin: { x: 0, y: 0, z: 0 } } });
    const changedReport = JSON.parse(await readFile(`${file}.provenance.json`, 'utf8'));
    changedReport.targetVersion = '1.21.4';
    await reportFile(file, changedReport);
    const tampered = makeSession();
    const resolvePath = (selector, _directory, options) => resolveSchematicPath(selector, root, options);
    assert.equal(await buildSchematic(bot, 'race.schem', 0, 0, 0, { ...dependencies, resolvePath, resumeSession: tampered }), false);
    assert.match(logs.at(-1), /snapshot identity changed/);
    assert.equal(tampered.cancelled, true);
    const revoked = makeSession();
    assert.equal(await buildSchematic(bot, 'race.schem', 0, 0, 0, { ...dependencies, resolvePath, resumeSession: revoked, allowNonvalidatedSchematic: false }), false);
    assert.match(logs.at(-1), /NONVALIDATED/);
    assert.equal(revoked.cancelled, true);
    assert.equal(mutations, 0);
  });
});
