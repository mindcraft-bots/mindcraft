import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { constants } from 'node:fs';
import nbt from 'prismarine-nbt';
import { validateSchematicSource } from '../../src/utils/schematic/reader.js';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import minecraftData from 'minecraft-data';
import { SCHEMATICS_DIR, listSchematicEntries, resolveSchematicPath } from '../../src/utils/schematic/paths.js';
import { schematicProvenance } from '../../src/utils/schematic/provenance.js';
import { buildSchematic } from '../../src/utils/schematic/build_schematic.js';

const root = path.dirname(SCHEMATICS_DIR);
const bee = path.join(SCHEMATICS_DIR, 'blueprints/pack1/02_bee_hot_air_balloon.json');
const compiler = path.join(SCHEMATICS_DIR, 'tooling/compile_blueprint.py');
const python = process.env.HISTORY_TEST_PYTHON || 'python3';
const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8' });

test('new compiler provenance gates real selectors, listings, build, reader comparison and tampering', async () => {
  const packName = `pack${Date.now()}`;
  const folder = path.join(SCHEMATICS_DIR, 'schems', packName);
  await mkdir(folder);
  try {
    const file = path.join(folder, 'bee.nonvalidated.schem');
    const result = run(python, [compiler, 'compile', bee, file, '--allow-unverified']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).validation, 'NONVALIDATED');
    const selector = `${packName}:bee.nonvalidated.schem`;
    const options = { version: '1.21.4' };
    const consent = { ...options, allowNonvalidatedSchematic: true };
    assert.equal((await schematicProvenance(file)).validationStatus, 'NONVALIDATED');
    await assert.rejects(resolveSchematicPath(selector, SCHEMATICS_DIR, options), /NONVALIDATED/);
    assert.equal(await resolveSchematicPath(selector, SCHEMATICS_DIR, consent), file);
    await assert.rejects(resolveSchematicPath(selector, SCHEMATICS_DIR, { ...consent, requireStrictSchematicValidation: true }), /NONVALIDATED/);
    let entry = (await listSchematicEntries(SCHEMATICS_DIR, options)).find(e => e.pack === packName);
    assert.equal(entry.validationStatus, 'NONVALIDATED'); assert.equal(entry.compatible, false); assert.equal(entry.selected, false);
    entry = (await listSchematicEntries(SCHEMATICS_DIR, consent)).find(e => e.pack === packName);
    assert.equal(entry.compatible, true); assert.equal(entry.selected, true);
    const comparison = run(process.execPath, ['schematics/tooling/validate_blueprint.mjs', bee, file]);
    assert.equal(comparison.status, 0, comparison.stderr);
    const report = JSON.parse(comparison.stdout);
    assert.equal(report.fullVoxelAndStateComparison, 'PASS');
    assert.equal(report.validationStatus, 'NONVALIDATED');
    assert.equal(report.legalCombinationProof, 'NOT_PERFORMED_BY_READER_COMPARISON');

    const world = new Map(), key = p => `${p.x},${p.y},${p.z}`;
    const bot = Object.assign(new EventEmitter(), { version: '1.21.4', registry: minecraftData('1.21.4'),
      game: { gameMode: 'survival', dimension: 'overworld' }, entity: {}, world: {}, _client: new EventEmitter(),
      blockAt: p => world.get(key(p)) ?? { name: 'air', getProperties: () => ({}) } });
    const logs = [];
    const dependencies = {
      writeLog: msg => logs.push(msg),
      changeGameMode: (_bot, mode) => { bot.game.gameMode = mode; return true; },
      clearObstructions: () => ({ cleared: 0 }),
      guardDestruction: (_bot, _build, _Vec3, callback) => callback(),
      startSupply: () => async () => {},
      executeBuild: (_bot, build) => {
        for (const cell of build.plan) world.set(key(cell.position), { name: cell.name, getProperties: () => cell.properties });
        return { status: 'finished', errors: [] };
      },
    };
    assert.equal(await buildSchematic(bot, selector, 0, 64, 0, dependencies), false);
    assert.match(logs.join('\n'), /NONVALIDATED/);
    assert.equal(await buildSchematic(bot, selector, 0, 64, 0, { ...dependencies, allowNonvalidatedSchematic: true }), true, logs.join('\n'));
    assert.match(logs.join('\n'), /WARNING.*NONVALIDATED/);

    const sidecar = `${file}.provenance.json`, original = await readFile(sidecar, 'utf8');
    const altered = JSON.parse(original); altered.artifact = 'elsewhere.schem';
    await writeFile(sidecar, JSON.stringify(altered));
    assert.equal((await schematicProvenance(file)).validationStatus, 'INVALID');
    await assert.rejects(resolveSchematicPath(selector, SCHEMATICS_DIR, consent), /INVALID/);
    altered.artifact = path.basename(file); altered.validation = 'STRICT_VALIDATED';
    await writeFile(sidecar, JSON.stringify(altered));
    await writeFile(`${file}.provenance.sha256`, `${createHash('sha256').update(JSON.stringify(altered)).digest('hex')}\n`);
    // The unsigned sidecar can be rewritten; strict means independent content
    // verification against the now-complete profile, not proof of compiler execution.
    assert.equal((await schematicProvenance(file)).validationStatus, 'STRICT_VALIDATED');
    await writeFile(sidecar, original);
    await writeFile(`${file}.provenance.sha256`, `${createHash('sha256').update(original).digest('hex')}\n`);
    const data = await readFile(file); await writeFile(file, Buffer.concat([data, Buffer.from([0])]));
    assert.equal((await schematicProvenance(file)).validationStatus, 'INVALID');
    await writeFile(file, data);
    const alias = path.join(folder, 'arbitrary.schem');
    await copyFile(file, alias);
    assert.equal((await schematicProvenance(alias)).validationStatus, 'UNKNOWN');
    await assert.rejects(resolveSchematicPath(`${packName}:arbitrary.schem`, SCHEMATICS_DIR, consent), /UNKNOWN/);
    await symlink(file, path.join(folder, 'link.schem'));
    assert.equal((await schematicProvenance(path.join(folder, 'link.schem'))).validationStatus, 'INVALID');
    await assert.rejects(resolveSchematicPath(`${packName}:link.schem`, SCHEMATICS_DIR, consent), /INVALID/);
    await assert.rejects(resolveSchematicPath(`${packName}:BEE.nonvalidated.schem`, SCHEMATICS_DIR, consent));
    await rm(`${file}.provenance.sha256`);
    assert.equal((await schematicProvenance(file)).validationStatus, 'INVALID');
    await rm(sidecar);
    assert.equal((await schematicProvenance(file)).validationStatus, 'UNKNOWN');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('strict proof, historical allowlist, report binding and variant constraints fail closed', async () => {
  const dir = await mkdtemp(path.join(SCHEMATICS_DIR, '.provenance-test-'));
  try {
    const blueprint = path.join(dir, 'stone.json');
    await writeFile(blueprint, JSON.stringify({ minecraft_version: '1.13', data_version: 1519, width_x: 1, height_y: 1, length_z: 1,
      legend: { A: 'minecraft:stone' }, layers: [['A']], expected_counts: { 'minecraft:stone': 1 }, non_air_count: 1, spot_checks: [] }));
    const strict = path.join(dir, 'stone.schem');
    const compiled = run(python, [compiler, 'compile', blueprint, strict]);
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.equal((await schematicProvenance(strict)).validationStatus, 'STRICT_VALIDATED');
    assert.equal(await resolveSchematicPath(path.relative(SCHEMATICS_DIR, strict), SCHEMATICS_DIR, { version: '1.13', requireStrictSchematicValidation: true }), strict);
    const meta = `${strict}.provenance.json`, sidecar = await readFile(meta, 'utf8');
    const report = JSON.parse(sidecar); report.sha256 = '0'.repeat(64); await writeFile(meta, JSON.stringify(report));
    assert.equal((await schematicProvenance(strict)).validationStatus, 'INVALID');
    await assert.rejects(resolveSchematicPath(path.relative(SCHEMATICS_DIR, strict), SCHEMATICS_DIR, { version: '1.13', requireStrictSchematicValidation: true }));
    await writeFile(meta, sidecar); await rm(meta);
    assert.equal((await schematicProvenance(strict)).validationStatus, 'UNKNOWN');
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
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pack conversion report is hash-bound to each compiled artifact', async () => {
  const pack = `pack${Date.now()}`;
  const sourceDir = path.join(SCHEMATICS_DIR, 'blueprints', pack);
  const outputDir = path.join(SCHEMATICS_DIR, 'schems', pack);
  await mkdir(sourceDir); await mkdir(outputDir);
  try {
    await copyFile(bee, path.join(sourceDir, 'bee.json'));
    const result = run(python, ['schematics/tooling/compile_pack.py', pack, '26.1', '--allow-unverified']);
    assert.equal(result.status, 0, result.stderr);
    const artifact = path.join(outputDir, 'bee.mc26.1.nonvalidated.schem');
    const report = path.join(outputDir, 'conversion.mc26.1.nonvalidated.json');
    assert.equal((await schematicProvenance(artifact)).validationStatus, 'NONVALIDATED');
    const original = await readFile(report);
    await writeFile(report, Buffer.concat([original, Buffer.from(' ')]));
    assert.equal((await schematicProvenance(artifact)).validationStatus, 'INVALID');
    await assert.rejects(resolveSchematicPath(`${pack}:bee.mc26.1.nonvalidated.schem`, SCHEMATICS_DIR,
      { version: '26.1', allowNonvalidatedSchematic: true }), /INVALID/);
    await rm(report);
    assert.equal((await schematicProvenance(artifact)).validationStatus, 'INVALID');
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
});


test('strict content checks reject forged incomplete NBT and unrelated blueprint; CLI separates outcomes', async () => {
  const dir = await mkdtemp(path.join(SCHEMATICS_DIR, '.strict-adversarial-'));
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  try {
    const blueprint = path.join(dir, 'stone.json'), file = path.join(dir, 'stone.schem');
    await writeFile(blueprint, JSON.stringify({ minecraft_version: '1.13', data_version: 1519, width_x: 1, height_y: 1, length_z: 1,
      legend: { A: 'minecraft:stone' }, layers: [['A']], expected_counts: { 'minecraft:stone': 1 }, non_air_count: 1, spot_checks: [] }));
    const compiled = run(python, [compiler, 'compile', blueprint, file]);
    assert.equal(compiled.status, 0, compiled.stderr);
    const original = await readFile(file), metadata = JSON.parse(await readFile(`${file}.provenance.json`, 'utf8'));
    const writeForged = async (bytes, report) => {
      await writeFile(file, bytes); report.sha256 = sha(bytes);
      const text = JSON.stringify(report);
      await writeFile(`${file}.provenance.json`, text);
      await writeFile(`${file}.provenance.sha256`, `${sha(text)}\n`);
    };
    const { parsed } = await nbt.parse(original);
    delete parsed.value.Width; delete parsed.value.BlockData;
    const incomplete = gzipSync(nbt.writeUncompressed(parsed));
    await writeForged(incomplete, { ...metadata });
    assert.equal((await schematicProvenance(file)).validationStatus, 'INVALID');
    await assert.rejects(validateSchematicSource(incomplete, '1.13'), /Width|BlockData/);
    for (const mutate of [
      tags => { tags.Width.value = 0; },
      tags => { tags.BlockData.value = [1]; },
      tags => { tags.BlockData.value = [-128]; },
      tags => { tags.BlockData.value = [-128, 0]; },
      tags => { tags.BlockData.value = [0, 0]; },
      tags => { tags.Palette.value['minecraft:air'] = { type: 'int', value: 0 }; tags.PaletteMax.value = 2; },
    ]) {
      const broken = (await nbt.parse(original)).parsed; mutate(broken.value);
      const bytes = gzipSync(nbt.writeUncompressed(broken));
      await writeForged(bytes, { ...metadata });
      assert.equal((await schematicProvenance(file)).validationStatus, 'INVALID');
      await assert.rejects(validateSchematicSource(bytes, '1.13'), /Invalid Sponge/);
    }
    const stone = (await nbt.parse(original)).parsed;
    stone.value.DataVersion.value = 4189;
    const forged = gzipSync(nbt.writeUncompressed(stone));
    await writeForged(forged, { ...metadata, blueprint: 'schematics/blueprints/pack1/02_bee_hot_air_balloon.json', blueprintSha256: sha(await readFile(bee)) });
    assert.equal((await schematicProvenance(file)).validationStatus, 'INVALID');
    const pairBlueprint = path.join(dir, 'pair.json'), pairFile = path.join(dir, 'pair.schem');
    await writeFile(pairBlueprint, JSON.stringify({ minecraft_version: '1.13', data_version: 1519, width_x: 2, height_y: 1, length_z: 1,
      legend: { A: 'minecraft:stone', B: 'minecraft:air' }, layers: [['AB']], expected_counts: { 'minecraft:stone': 1, 'minecraft:air': 1 }, non_air_count: 1, spot_checks: [] }));
    const pairCompiled = run(python, [compiler, 'compile', pairBlueprint, pairFile]);
    assert.equal(pairCompiled.status, 0, pairCompiled.stderr);
    const pair = (await nbt.parse(await readFile(pairFile))).parsed;
    pair.value.BlockData.value.reverse();
    const pairBytes = gzipSync(nbt.writeUncompressed(pair));
    const pairMeta = JSON.parse(await readFile(`${pairFile}.provenance.json`, 'utf8'));
    pairMeta.sha256 = sha(pairBytes);
    const pairText = JSON.stringify(pairMeta);
    await writeFile(pairFile, pairBytes);
    await writeFile(`${pairFile}.provenance.json`, pairText);
    await writeFile(`${pairFile}.provenance.sha256`, `${sha(pairText)}\n`);
    assert.match((await schematicProvenance(pairFile)).reason, /voxel mismatch/);
    await writeForged(original, { ...metadata });
    let comparison = run(process.execPath, ['schematics/tooling/validate_blueprint.mjs', blueprint, file, '--require-strict-provenance']);
    assert.equal(comparison.status, 0, comparison.stderr);
    assert.equal(JSON.parse(comparison.stdout).provenanceOutcome, 'PASS');
    await writeFile(`${file}.provenance.json`, `${await readFile(`${file}.provenance.json`, 'utf8')} `);
    comparison = run(process.execPath, ['schematics/tooling/validate_blueprint.mjs', blueprint, file]);
    assert.equal(comparison.status, 0, comparison.stderr);
    assert.equal(JSON.parse(comparison.stdout).voxelOutcome, 'PASS');
    assert.equal(JSON.parse(comparison.stdout).provenanceOutcome, 'FAIL');
    comparison = run(process.execPath, ['schematics/tooling/validate_blueprint.mjs', blueprint, file, '--require-strict-provenance']);
    assert.equal(comparison.status, 2, comparison.stderr);
    assert.equal(JSON.parse(comparison.stdout).voxelOutcome, 'PASS');
    assert.equal(JSON.parse(comparison.stdout).provenanceOutcome, 'FAIL');
  } finally { await rm(dir, { recursive: true, force: true }); }
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
    await copyFile(path.join(SCHEMATICS_DIR, 'schems/pack1/02_bee_hot_air_balloon.schem'), path.join(isolated, 'bee.schem'));
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
    assert.equal(invalidEntry.validationStatus, 'INVALID');
    assert.equal(invalidEntry.selected, false);
  } finally {
    for (const file of created.reverse()) await rm(file, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
