// Adapt older injected-reader tests to the real provenance gate; no production bypass.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { SCHEMATICS_DIR } from '../../src/utils/schematic/paths.js';

const directory = mkdtempSync(path.join(os.tmpdir(), 'schematic-provenance-fixture-'));
const blueprint = 'schematics/blueprints/pack1/02_bee_hot_air_balloon.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const blueprintHash = sha(readFileSync(path.join(SCHEMATICS_DIR, 'blueprints/pack1/02_bee_hot_air_balloon.json')));
let sequence = 0;
after(() => rmSync(directory, { recursive: true, force: true }));

export function writeFixtureProvenance(filename, bytes) {
  const report = JSON.stringify({ schemaVersion: 1, artifact: path.basename(filename),
    sha256: sha(bytes), validation: 'NONVALIDATED', blueprint, blueprintSha256: blueprintHash,
    convertTo: null, targetVersion: null, packReport: null, packReportSha256: null });
  writeFileSync(`${filename}.provenance.json`, report);
  writeFileSync(`${filename}.provenance.sha256`, `${sha(Buffer.from(report))}\n`);
}

export function provenanceFixtureDependencies(dependencies) {
  dependencies.allowNonvalidatedSchematic = true;
  return new Proxy(dependencies, {
    get(target, key) {
      if (key === 'allowNonvalidatedSchematic') return true;
      if (key === 'resolvePath') return async (...args) => {
        const original = await target.resolvePath(...args);
        const folder = path.join(directory, String(sequence++));
        const { mkdirSync } = await import('node:fs');
        mkdirSync(folder);
        return path.join(folder, path.basename(original));
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
