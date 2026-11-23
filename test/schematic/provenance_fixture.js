// Adapt older injected-reader tests to the real provenance gate; no production bypass.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = mkdtempSync(path.join(os.tmpdir(), 'schematic-provenance-fixture-'));
const root = fileURLToPath(new URL('../../', import.meta.url));
// Provenance requires its blueprint to be inside the project, even for injected readers.
const blueprintDirectory = mkdtempSync(path.join(root, 'test/schematic/.provenance-fixture-'));
const blueprintFile = path.join(blueprintDirectory, 'fixture.json');
const blueprint = path.relative(root, blueprintFile).split(path.sep).join('/');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const blueprintBytes = Buffer.from(JSON.stringify({ minecraft_version: '1.21.4', data_version: 4189,
  width_x: 2, height_y: 1, length_z: 1,
  legend: { a: 'minecraft:stone', b: 'minecraft:chain[axis=y,waterlogged=false]' }, layers: [['ab']],
  expected_counts: { 'minecraft:stone': 1, 'minecraft:chain[axis=y,waterlogged=false]': 1 },
  non_air_count: 2, spot_checks: [{ x: 1, y: 0, z: 0, char: 'b' }] }));
writeFileSync(blueprintFile, blueprintBytes);
const blueprintHash = sha(blueprintBytes);
export const fixtureBlueprint = blueprint;
export const fixtureBlueprintHash = blueprintHash;
let sequence = 0;
after(() => {
  rmSync(directory, { recursive: true, force: true });
  rmSync(blueprintDirectory, { recursive: true, force: true });
});

export function writeFixtureProvenance(filename, bytes, validation = 'NONVALIDATED') {
  const report = JSON.stringify({ schemaVersion: 1, artifact: path.basename(filename),
    sha256: sha(bytes), validation, blueprint, blueprintSha256: blueprintHash,
    convertTo: null, targetVersion: null, packReport: null, packReportSha256: null });
  writeFileSync(`${filename}.provenance.json`, report);
  writeFileSync(`${filename}.provenance.sha256`, `${sha(Buffer.from(report))}\n`);
}

export function provenanceFixtureDependencies(dependencies) {
  dependencies.allowNonvalidatedSchematic = true;
  const resolved = new Map();
  return new Proxy(dependencies, {
    get(target, key) {
      if (key === 'allowNonvalidatedSchematic') return true;
      if (key === 'resolvePath') return async (...args) => {
        const original = await target.resolvePath(...args);
        if (!resolved.has(original)) {
          const folder = path.join(directory, String(sequence++));
          const { mkdirSync } = await import('node:fs');
          mkdirSync(folder);
          const name = path.basename(original).replace(/(?<!\.mc1\.20\.4)\.schem$/, '.mc1.20.4.schem');
          resolved.set(original, path.join(folder, name));
        }
        return resolved.get(original);
      };
      if (key === 'fsReadFile') return async filename => {
        const bytes = await target.fsReadFile(filename);
        writeFileSync(filename, bytes);
        writeFixtureProvenance(filename, bytes);
        return bytes;
      };
      if (key === 'writeLog') return message => {
        if (!message.startsWith('WARNING: schematic validation status ')) target.writeLog?.(message);
      };
      return target[key];
    },
  });
}
