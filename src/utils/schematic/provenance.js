import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nbt from 'prismarine-nbt';
import { loadRelease, validateBlueprint, validateState } from '../../../schematics/tooling/history_registry.mjs';
import { convertBlueprint } from '../../../schematics/tooling/convert_history.mjs';
import { validateSpongeStructure } from './sponge_structure.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const inventoryPath = path.join(projectRoot, 'schematics/tooling/historical_artifacts.v1.json');
const inventoryHash = '815a8dc6780bf7bc1e11c7c5ea6b50409a5bb6a4b5e496117e418aae0f49b174';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Status is an assertion about these exact bytes, not the name used to find them.
// STRICT_VALIDATED checks content and blueprint correspondence, not authorship.
// Mutable sidecars and checksums are not signatures.
export async function schematicProvenance(filename, bytes) {
  try {
    const absolute = path.resolve(filename);
    if (await realpath(absolute) !== absolute || !(await lstat(absolute)).isFile()) throw new Error('symlinked artifact is not trusted');
    const data = bytes ?? await readFile(absolute);
    const digest = hash(data);
    const inventoryBytes = await readFile(inventoryPath);
    if (hash(inventoryBytes) !== inventoryHash) throw new Error('historical inventory is untrusted');
    const inventory = JSON.parse(inventoryBytes).artifacts;
    const historicalHash = inventory[path.relative(projectRoot, absolute).split(path.sep).join('/')];
    if (historicalHash && historicalHash !== digest) throw new Error('historical artifact hash mismatch');
    const sidecar = `${absolute}.provenance.json`;
    let text;
    try {
      if (await realpath(sidecar) !== sidecar || !(await lstat(sidecar)).isFile()) throw new Error('symlinked provenance is not trusted');
      text = await readFile(sidecar, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return historicalHash ? { validationStatus: 'HISTORICAL_UNKNOWN', sha256: digest, identity: `historical:${digest}` }
        : { validationStatus: 'UNKNOWN', sha256: digest, reason: 'missing provenance' };
    }
    const digestPath = `${absolute}.provenance.sha256`;
    if (await realpath(digestPath) !== digestPath || !(await lstat(digestPath)).isFile()
        || await readFile(digestPath, 'utf8') !== `${hash(Buffer.from(text))}\n`) throw new Error('provenance digest mismatch');
    const keys = [...text.matchAll(/"([^"\\]+)"\s*:/g)].map(match => match[1]);
    if (new Set(keys).size !== keys.length) throw new Error('duplicate provenance fields');
    const report = JSON.parse(text);
    if (Object.keys(report).sort().join(',') !== 'artifact,blueprint,blueprintSha256,convertTo,packReport,packReportSha256,schemaVersion,sha256,targetVersion,validation'
        || report.schemaVersion !== 1 || report.artifact !== path.basename(absolute)
        || report.sha256 !== digest || !['NONVALIDATED', 'STRICT_VALIDATED'].includes(report.validation)
        || typeof report.blueprint !== 'string' || !/^[a-f0-9]{64}$/.test(report.blueprintSha256)
        || !(report.convertTo === null || typeof report.convertTo === 'string')
        || !(report.targetVersion === null || typeof report.targetVersion === 'string')) throw new Error('invalid or mismatched provenance');
    const variant = /^(.*)\.mc(\d+(?:\.\d+)+)(\.nonvalidated)?\.schem$/.exec(report.artifact);
    if (/(?:^|\.)mc\d/i.test(report.artifact.slice(0, -6))
        && (!variant || /(?:^|\.)mc\d/i.test(variant[1]))) throw new Error('invalid schematic variant pattern');
    if (report.validation === 'NONVALIDATED') {
      if (report.targetVersion !== null && report.convertTo !== null) throw new Error('conflicting target versions');
      const declared = report.convertTo ?? report.targetVersion;
      if (declared !== null) {
        const profile = loadRelease(declared);
        if (variant && declared !== variant[2]) throw new Error('provenance target filename mismatch');
        const { parsed } = await nbt.parse(data);
        validateSpongeStructure(parsed);
        if (nbt.simplify(parsed).DataVersion !== profile.dataVersion) throw new Error('provenance target DataVersion mismatch');
      }
    }
    const derivative = variant?.[3] ? variant : null;
    if (derivative) {
      if (report.validation !== 'NONVALIDATED' || report.convertTo !== derivative[2] || report.targetVersion !== null) throw new Error('nonvalidated derivative label mismatch');
      const { parsed } = await nbt.parse(data);
      validateSpongeStructure(parsed);
      if (nbt.simplify(parsed).DataVersion !== loadRelease(derivative[2]).dataVersion) throw new Error('nonvalidated derivative DataVersion mismatch');
    }
    if (report.packReport !== null || report.packReportSha256 !== null) {
      if (typeof report.packReport !== 'string' || path.basename(report.packReport) !== report.packReport
          || !/^[a-f0-9]{64}$/.test(report.packReportSha256)) throw new Error('invalid pack report reference');
      const packReportPath = path.join(path.dirname(absolute), report.packReport);
      if (await realpath(packReportPath) !== packReportPath || hash(await readFile(packReportPath)) !== report.packReportSha256) throw new Error('pack report mismatch');
      const packReport = JSON.parse(await readFile(packReportPath, 'utf8'));
      if (packReport.schemaVersion !== 2 || packReport.validation !== report.validation
          || packReport.targetVersion !== report.convertTo || !Array.isArray(packReport.entries)
          || packReport.entries.filter(entry => entry.schematic === report.artifact && entry.sha256 === digest && entry.validation === report.validation).length !== 1) throw new Error('pack report entry mismatch');
    }
    const blueprint = path.resolve(projectRoot, report.blueprint);
    if (!blueprint.startsWith(projectRoot + path.sep) || await realpath(blueprint) !== blueprint
        || hash(await readFile(blueprint)) !== report.blueprintSha256) throw new Error('blueprint provenance mismatch');
    if (report.validation === 'STRICT_VALIDATED') {
      const blueprintData = JSON.parse(await readFile(blueprint, 'utf8'));
      if (report.targetVersion && report.convertTo) throw new Error('conflicting target versions');
      const sourceProfile = loadRelease(blueprintData.minecraft_version);
      validateBlueprint(blueprintData, sourceProfile, false);
      if (report.targetVersion && report.targetVersion !== blueprintData.minecraft_version) throw new Error('blueprint target version mismatch');
      let legend = blueprintData.legend;
      const version = report.convertTo ?? report.targetVersion ?? blueprintData.minecraft_version;
      if (report.convertTo) {
        const history = JSON.parse(await readFile(path.join(projectRoot, 'schematics/tooling/block_history.v1.json'), 'utf8'));
        legend = convertBlueprint(blueprintData, version, history).legend;
      }
      const profile = loadRelease(version);
      const { parsed } = await nbt.parse(data);
      const root = nbt.simplify(parsed);
      const { dims, states, indices } = validateSpongeStructure(parsed, { compilerShape: true });
      if (profile.config.coverage === 'partial' || root.DataVersion !== profile.dataVersion) throw new Error('strict profile mismatch');
      for (const state of states) validateState(state, profile, false);
      const expectedStates = new Set(Object.values(legend));
      if (states.length !== expectedStates.size || states.some(state => !expectedStates.has(state))) throw new Error('blueprint palette mismatch');
      const expectedDims = [blueprintData.width_x, blueprintData.height_y, blueprintData.length_z];
      if (JSON.stringify(dims) !== JSON.stringify(expectedDims) || !Array.isArray(blueprintData.layers) || blueprintData.layers.length !== dims[1]) throw new Error('blueprint dimensions mismatch');
      let index = 0;
      for (const layer of blueprintData.layers) {
        if (!Array.isArray(layer) || layer.length !== dims[2]) throw new Error('invalid blueprint layers');
        for (const row of layer) {
          if (typeof row !== 'string' || row.length !== dims[0]) throw new Error('invalid blueprint row');
          for (const char of row) {
            if (!Object.hasOwn(legend, char) || states[indices[index++]] !== legend[char]) throw new Error('blueprint voxel mismatch');
          }
        }
      }
    }
    return { validationStatus: report.validation, sha256: digest, identity: `sidecar:${hash(Buffer.from(text))}` };
  } catch (error) {
    return { validationStatus: 'INVALID', reason: error.message };
  }
}

export function provenanceAllowed(provenance, options = {}) {
  return provenance.validationStatus === 'STRICT_VALIDATED' || (!options.requireStrictSchematicValidation && (provenance.validationStatus === 'HISTORICAL_UNKNOWN'
    || (provenance.validationStatus === 'NONVALIDATED' && options.allowNonvalidatedSchematic === true)));
}
