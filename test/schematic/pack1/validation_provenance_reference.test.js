import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { constants } from 'node:fs';
import nbt from 'prismarine-nbt';
import { validateSchematicSource } from '../../../src/utils/schematic/reader.js';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import minecraftData from 'minecraft-data';
import { SCHEMATICS_DIR, listSchematicEntries, resolveSchematicPath } from '../../../src/utils/schematic/paths.js';
import { schematicProvenance } from '../../../src/utils/schematic/provenance.js';
import { buildSchematic } from '../../../src/utils/schematic/build_schematic.js';

const root = path.dirname(SCHEMATICS_DIR);
const bee = path.join(SCHEMATICS_DIR, 'blueprints/pack1/02_bee_hot_air_balloon.json');
const compiler = path.join(SCHEMATICS_DIR, 'tooling/compile_blueprint.py');
const python = process.env.HISTORY_TEST_PYTHON || 'python3';
const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8' });

test('historical pack1 strict variants remain authenticated and selectable', async () => {
    const old = path.join(SCHEMATICS_DIR, 'schems/pack1/02_bee_hot_air_balloon.mc26.1.schem');
    assert.equal((await schematicProvenance(old)).validationStatus, 'STRICT_VALIDATED');
    assert.equal((await schematicProvenance(old, Buffer.concat([await readFile(old), Buffer.from([0])]))).validationStatus, 'INVALID');
    const comparison = run(process.execPath, ['schematics/tooling/validate_blueprint.mjs', bee,
      path.join(SCHEMATICS_DIR, 'schems/pack1/02_bee_hot_air_balloon.mc1.21.4.schem')]);
    assert.equal(comparison.status, 0, comparison.stderr);
    assert.equal(JSON.parse(comparison.stdout).validationStatus, 'STRICT_VALIDATED');
    assert.equal(JSON.parse(comparison.stdout).legalCombinationProof, 'NOT_PERFORMED_BY_READER_COMPARISON');
    assert.equal(await resolveSchematicPath('pack1:02_bee_hot_air_balloon.mc26.1.schem', SCHEMATICS_DIR, { version: '26.1', requireStrictSchematicValidation: true }), old);
    await assert.rejects(resolveSchematicPath('pack1:02_bee_hot_air_balloon.mc26.1.schem', SCHEMATICS_DIR, { version: '1.21.4' }), /No compatible/);
    await assert.rejects(resolveSchematicPath('pack1:02_bee_hot_air_balloon.MC26.1.schem', SCHEMATICS_DIR, { version: '26.1' }));
});

test('actual bee tuple selects consented derivative, reports ownership, and rejects aliases and spoofed labels', async () => {
  const dir = await mkdtemp(path.join(SCHEMATICS_DIR, '.family-adversarial-'));
  const pack = path.join(SCHEMATICS_DIR, 'schems/pack1');
  const name = '02_bee_hot_air_balloon.mc26.1.nonvalidated.schem';
  const base = path.join(dir, '02_bee_hot_air_balloon.schem');
  const created = [];
  try {
    const result = run(python, [compiler, 'compile', bee, base, '--convert-to', '26.1', '--allow-unverified']);
    assert.equal(result.status, 0, result.stderr);
    for (const suffix of ['', '.provenance.json', '.provenance.sha256']) {
      const target = path.join(pack, name + suffix);
      await copyFile(path.join(dir, name + suffix), target, constants.COPYFILE_EXCL);
      created.push(target);
    }
    const options = { version: '26.1', allowNonvalidatedSchematic: true };
    assert.equal(await resolveSchematicPath('pack1:2:1', SCHEMATICS_DIR, options), path.join(pack, name));
    assert.equal(await resolveSchematicPath(`pack1:${name}`, SCHEMATICS_DIR, options), path.join(pack, name));
    assert.match(await resolveSchematicPath('pack1:2:1', SCHEMATICS_DIR, { version: '26.1' }), /mc26\.1\.schem$/);
    assert.equal(await resolveSchematicPath('pack1:2:1', SCHEMATICS_DIR, { ...options, requireStrictSchematicValidation: true }), path.join(pack, '02_bee_hot_air_balloon.mc26.1.schem'));
    await assert.rejects(resolveSchematicPath(`pack1:${name}`, SCHEMATICS_DIR, { ...options, requireStrictSchematicValidation: true }), /NONVALIDATED|No compatible/);
    const entry = (await listSchematicEntries(SCHEMATICS_DIR, options)).find(item => item.fileName === name);
    assert.deepEqual([entry.group, entry.fileId, entry.selector, entry.validationStatus, entry.selected], [2, 1, 'pack1:2:1', 'NONVALIDATED', true]);
    const reportPath = path.join(pack, `${name}.provenance.json`), text = await readFile(reportPath, 'utf8');
    const report = JSON.parse(text); report.convertTo = '1.21.4';
    const bad = JSON.stringify(report);
    await writeFile(reportPath, bad); await writeFile(`${path.join(pack, name)}.provenance.sha256`, `${createHash('sha256').update(bad).digest('hex')}\n`);
    assert.equal((await schematicProvenance(path.join(pack, name))).validationStatus, 'INVALID');
    await assert.rejects(resolveSchematicPath(`pack1:${name}`, SCHEMATICS_DIR, options), /INVALID|Ambiguous/);
    await writeFile(reportPath, text); await writeFile(`${path.join(pack, name)}.provenance.sha256`, `${createHash('sha256').update(text).digest('hex')}\n`);
    const alias = '02_bee_hot_air_balloon.mc26.1.1.nonvalidated.schem';
    const aliasFile = path.join(pack, alias), aliasReport = { ...JSON.parse(text), artifact: alias, convertTo: '26.1.1' };
    const aliasText = JSON.stringify(aliasReport);
    await copyFile(path.join(pack, name), aliasFile, constants.COPYFILE_EXCL); created.push(aliasFile);
    await writeFile(`${aliasFile}.provenance.json`, aliasText, { flag: 'wx' }); created.push(`${aliasFile}.provenance.json`);
    await writeFile(`${aliasFile}.provenance.sha256`, `${createHash('sha256').update(aliasText).digest('hex')}\n`, { flag: 'wx' }); created.push(`${aliasFile}.provenance.sha256`);
    assert.equal((await schematicProvenance(aliasFile)).validationStatus, 'INVALID');
    await assert.rejects(resolveSchematicPath(`pack1:${alias}`, SCHEMATICS_DIR, options), /No compatible/);
    await assert.rejects(resolveSchematicPath('pack1:02_bee_hot_air_balloon.mc26.1.NONVALIDATED.schem', SCHEMATICS_DIR, options));
    const isolated = path.join(dir, 'isolated/schems/pack1');
    await mkdir(isolated, { recursive: true });
    const normal = 'bee.mc26.1.schem', derivative = 'bee.mc26.1.nonvalidated.schem';
    for (const item of [normal, derivative]) {
      await copyFile(path.join(pack, name), path.join(isolated, item));
      const meta = JSON.stringify({ ...JSON.parse(text), artifact: item });
      await writeFile(path.join(isolated, `${item}.provenance.json`), meta);
      await writeFile(path.join(isolated, `${item}.provenance.sha256`), `${createHash('sha256').update(meta).digest('hex')}\n`);
    }
    await copyFile(path.join(SCHEMATICS_DIR, 'schems/pack1/02_bee_hot_air_balloon.mc1.21.4.schem'), path.join(isolated, 'bee.schem'));
    await writeFile(path.join(isolated, 'index.json'), JSON.stringify({ schemaVersion: 2, groups: { 2: { 1: 'bee.schem' } } }));
    await assert.rejects(resolveSchematicPath('pack1:2:1', path.join(dir, 'isolated'), options), /Ambiguous/);
    const invalidName = 'bee.mc26.1.NONVALIDATED.schem';
    await copyFile(path.join(pack, name), path.join(isolated, invalidName));
    const invalidMeta = JSON.stringify({ ...JSON.parse(text), artifact: invalidName });
    await writeFile(path.join(isolated, `${invalidName}.provenance.json`), invalidMeta);
    await writeFile(path.join(isolated, `${invalidName}.provenance.sha256`), `${createHash('sha256').update(invalidMeta).digest('hex')}\n`);
    assert.equal((await schematicProvenance(path.join(isolated, invalidName))).validationStatus, 'INVALID');
    await assert.rejects(resolveSchematicPath(`pack1:${invalidName}`, path.join(dir, 'isolated'), options), /Invalid schematic variant pattern/);
    const invalidEntry = (await listSchematicEntries(path.join(dir, 'isolated'), options)).find(item => item.fileName === invalidName);
    assert.equal(invalidEntry, undefined, 'malformed variants are not listed');
  } finally {
    for (const file of created.reverse()) await rm(file, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
