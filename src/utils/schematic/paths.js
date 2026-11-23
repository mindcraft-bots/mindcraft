import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import minecraftData from "minecraft-data";
import nbt from "prismarine-nbt";
import { schematicProvenance, provenanceAllowed } from "./provenance.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export const SCHEMATICS_DIR = path.resolve(moduleDirectory, "../../../schematics");
export const SCHEMATIC_PACKS_DIR = path.join(SCHEMATICS_DIR, "schems");

const SCHEMATIC_EXTENSIONS = new Set([".schem", ".schematic", ".litematic"]);
const PACK_NAME = /^pack[1-9]\d*$/;
const GROUP_AND_FILE_ID_SELECTOR = /^(\d+):(\d+)$/;
const VARIANT = /^(.*)\.mc(\d+(?:\.\d+)+)(\.nonvalidated)?\.schem$/;
// Older minecraft-data entries omit releaseType; numeric labels identify those releases.
const releases = minecraftData.versions.pc.filter((version) => /^\d+(?:\.\d+)+$/.test(version.minecraftVersion)
  && (version.releaseType === "release" || version.releaseType === undefined)
  && Number.isInteger(version.dataVersion) && version.dataVersion > 0);
const releasesByName = new Map(releases.map((version) => [version.minecraftVersion, version]));
const releasesByDataVersion = new Map(releases.map((version) => [version.dataVersion, version]));

// Mineflayer normalizes server versions through a registry/protocol alias. Treat
// that label as no more precise than the oldest release sharing its protocol.
export function conservativeBotVersion(bot) {
  const release = releaseFor(bot?.version);
  const clientRelease = bot?._client?.version == null ? release : releaseFor(bot._client.version);
  if (!release || !clientRelease || clientRelease.version !== release.version) return undefined;
  return releases.filter(item => item.version === release.version)
    .sort((a, b) => a.dataVersion - b.dataVersion)[0]?.minecraftVersion;
}

function requireTarget(options) {
  const target = releaseFor(options?.version);
  if (!target) throw new Error(`Unknown Minecraft engine release ${String(options?.version)}; cannot select a schematic version`);
  return target;
}

function releaseAtMost(a, b) {
  const left = a.minecraftVersion.split('.').map(Number);
  const right = b.minecraftVersion.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) < (right[i] ?? 0);
  }
  return true;
}

function releaseFor(name) {
  return typeof name === "string" ? releasesByName.get(name) : undefined;
}

function validationDiagnostic(provenance, options) {
  const status = provenance?.validationStatus ?? 'UNKNOWN';
  return `validation status ${status}${provenance?.reason ? `: ${provenance.reason}` : ''}${status === 'NONVALIDATED'
    ? (options.requireStrictSchematicValidation ? '; strict validation is required' : '; operator consent requires allow_nonvalidated_schematic_builds=true') : ''}`;
}

async function baseRelease(candidate, bytes) {
  try {
    const { parsed } = await nbt.parse(bytes ?? await readFile(candidate));
    const root = nbt.simplify(parsed);
    const version = root?.DataVersion ?? root?.Schematic?.DataVersion;
    return Number.isInteger(version) ? releasesByDataVersion.get(version) : undefined;
  } catch {
    return undefined;
  }
}

// Variant labels are the compiler's target release, not the registry's possibly aliased label.
async function selectFamily(baseName, fileNames, directory, targetVersion, owned = () => true, options = {}, exactName = null) {
  if (!baseName.endsWith(".schem")) {
    throw new Error(`No compatible known-version schematic for case-sensitive filename ${baseName}`);
  }
  const target = requireTarget({ version: targetVersion });
  const stem = baseName.slice(0, -".schem".length);
  if (/(?:^|\.)mc\d/i.test(stem)) throw new Error(`Invalid schematic variant pattern ${baseName}`);
  const candidates = [];
  for (const name of fileNames) {
    if (!owned(name) || (exactName && name !== exactName)) continue;
    const match = VARIANT.exec(name);
    if (match && match[1] === stem) {
      const release = releaseFor(match[2]);
      if (!release) continue;
      const filename = path.join(directory, name);
      let source;
      try { source = await readFile(filename); } catch { continue; }
      const embedded = await baseRelease(filename, source);
      if (embedded?.dataVersion !== release.dataVersion) continue;
      // Bind provenance to the exact snapshot, never a path-only lookup.
      const provenance = await schematicProvenance(filename, source);
      candidates.push({ name, release, source, provenance, variant: true, nonvalidatedVariant: Boolean(match[3]) });
    }
  }
  for (const candidate of candidates) {
    if (candidate.nonvalidatedVariant && candidate.provenance.validationStatus !== "NONVALIDATED") candidate.provenance = { validationStatus: "INVALID", reason: "NONVALIDATED suffix requires matching provenance" };
  }
  const compatible = candidates.filter(({ release, provenance }) => release.dataVersion <= target.dataVersion && releaseAtMost(release, target) && provenanceAllowed(provenance, options))
    .sort((a, b) => b.release.dataVersion - a.release.dataVersion || Number(b.variant) - Number(a.variant)
      || Number(b.nonvalidatedVariant) - Number(a.nonvalidatedVariant));
  const seen = new Map();
  for (const candidate of compatible) {
    const group = seen.get(candidate.release.dataVersion) ?? [];
    for (const previous of group) {
      if (!(previous.nonvalidatedVariant !== candidate.nonvalidatedVariant
        && (previous.nonvalidatedVariant ? previous : candidate).provenance.validationStatus === 'NONVALIDATED'
        && ['HISTORICAL_UNKNOWN', 'STRICT_VALIDATED'].includes((previous.nonvalidatedVariant ? candidate : previous).provenance.validationStatus))) {
        throw new Error(`Ambiguous schematic variants ${previous.name} and ${candidate.name} share a DataVersion`);
      }
    }
    group.push(candidate);
    seen.set(candidate.release.dataVersion, group);
  }
  return { candidates, selected: compatible[0] ?? null, target };
}

function rejectedProvenance(family, exactName) {
  return family.candidates.filter(item => (!exactName || item.name === exactName)
    && item.release.dataVersion <= family.target.dataVersion && releaseAtMost(item.release, family.target))
    .sort((a, b) => b.release.dataVersion - a.release.dataVersion)[0]?.provenance;
}

function selectionResult(filename, selected, options) {
  return options.returnSnapshot ? { path: filename, source: Buffer.from(selected.source), provenance: selected.provenance } : filename;
}

function normalizePositivePart(value, label) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new TypeError(`Schematic ${label} must be a positive whole number`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`Schematic ${label} must be between 1 and ${Number.MAX_SAFE_INTEGER}`);
  }
  return number;
}

function parseUniqueJson(source) {
  let cursor = 0;
  const skipWhitespace = () => {
    while (/[ \t\r\n]/.test(source[cursor] ?? "")) cursor++;
  };
  const parseString = () => {
    const start = cursor++;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
      } else if (source[cursor++] === '"') {
        return JSON.parse(source.slice(start, cursor));
      }
    }
    throw new SyntaxError("Unterminated JSON string");
  };
  const parseValue = () => {
    skipWhitespace();
    if (source[cursor] === '"') return parseString();
    if (source[cursor] === "{") {
      cursor++;
      skipWhitespace();
      const value = Object.create(null);
      if (source[cursor] === "}") { cursor++; return value; }
      while (true) {
        skipWhitespace();
        if (source[cursor] !== '"') throw new SyntaxError("Expected a JSON object key");
        const key = parseString();
        if (Object.hasOwn(value, key)) throw new SyntaxError(`Duplicate JSON object key ${key}`);
        skipWhitespace();
        if (source[cursor++] !== ":") throw new SyntaxError("Expected a colon after a JSON object key");
        value[key] = parseValue();
        skipWhitespace();
        const separator = source[cursor++];
        if (separator === "}") return value;
        if (separator !== ",") throw new SyntaxError("Expected a comma or closing brace");
      }
    }
    if (source[cursor] === "[") {
      cursor++;
      skipWhitespace();
      const value = [];
      if (source[cursor] === "]") { cursor++; return value; }
      while (true) {
        value.push(parseValue());
        skipWhitespace();
        const separator = source[cursor++];
        if (separator === "]") return value;
        if (separator !== ",") throw new SyntaxError("Expected a comma or closing bracket");
      }
    }
    const start = cursor;
    while (cursor < source.length && !/[\s,}\]]/.test(source[cursor])) cursor++;
    if (start === cursor) throw new SyntaxError("Expected a JSON value");
    return JSON.parse(source.slice(start, cursor));
  };

  const parsed = parseValue();
  skipWhitespace();
  if (cursor !== source.length) throw new SyntaxError("Unexpected trailing JSON content");
  return parsed;
}

function isWithinDirectory(directory, candidate) {
  const relativePath = path.relative(directory, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath));
}

function validateFileName(fileName) {
  if (typeof fileName !== "string" || fileName.length === 0 || fileName.includes("\0") || fileName.includes("\\")) {
    throw new TypeError("Schematic filename must be a non-empty path without NUL or backslash characters");
  }

  if (fileName.split("/").some(part => part === ".." || part === ".")) throw new TypeError("Schematic path traversal is not allowed");
  if (path.isAbsolute(fileName) || path.win32.isAbsolute(fileName)) {
    throw new TypeError("Absolute schematic paths are not allowed");
  }
}

function validatePackFileName(fileName) {
  if (typeof fileName !== "string" || fileName.length === 0 || fileName.includes("\0") || fileName.includes("\\")
    || fileName === "." || fileName === ".." || fileName.includes("/") || path.isAbsolute(fileName) || path.win32.isAbsolute(fileName)) {
    throw new TypeError("Pack schematic must be a filename without absolute paths, traversal, NUL, or backslashes");
  }
  if (!SCHEMATIC_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
    throw new TypeError("Pack target must use a supported .schem, .schematic, or .litematic extension");
  }
}

async function getRealRoot(directory) {
  try {
    return await realpath(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return path.resolve(directory);
  }
}

async function assertExistingAncestorsStayWithin(root, candidate) {
  const realRoot = await getRealRoot(root);
  let ancestor = candidate;

  while (true) {
    try {
      const realAncestor = await realpath(ancestor);
      if (!isWithinDirectory(realRoot, realAncestor)) {
        throw new Error("Schematic path resolves outside the schematics directory");
      }
      return;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

/** Resolve a schematic filename while keeping both lexical and real paths inside the directory. */
export async function resolveSchematicPath(fileName, directory = SCHEMATICS_DIR, options = undefined) {
  validateFileName(fileName);

  const packMatch = /^(pack[^:]*):(.*)$/.exec(fileName);
  if (packMatch) {
    const [, packName, selector] = packMatch;
    if (!PACK_NAME.test(packName)) throw new TypeError(`Invalid schematic pack name: ${packName}`);
    return resolvePackSchematic(packName, selector, directory, options);
  }

  requireTarget(options);
  const root = path.resolve(directory);
  const candidate = path.resolve(root, fileName);
  if (!isWithinDirectory(root, candidate)) throw new Error("Schematic path escapes the schematics directory");
  const parts = fileName.split("/");
  if (parts[0] === "schems" && PACK_NAME.test(parts[1] ?? "") && parts.length === 3) {
    return resolvePackSchematic(parts[1], parts[2], directory, options);
  }
  // Do not allow alternate paths or symlinked directories to bypass pack ownership.
  await assertExistingAncestorsStayWithin(root, candidate);
  const parent = path.dirname(candidate);
  const realRoot = await getRealRoot(root);
  const realParent = await realpath(parent);
  if (realParent !== path.join(realRoot, path.relative(root, parent))) throw new Error("Symlinked schematic directories are not allowed");
  if (isWithinDirectory(path.join(realRoot, "schems"), realParent)) throw new Error("Use a direct pack-qualified schematic selector");
  const name = path.basename(candidate);
  if (!name.endsWith(".schem")) throw new Error("Only version-suffixed .schem files are supported");
  const names = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (entry.isFile() && VARIANT.test(entry.name)) names.push(entry.name);
  }
  const variant = VARIANT.exec(name);
  const base = variant ? `${variant[1]}.schem` : name;
  const family = await selectFamily(base, names, parent, options.version, () => true, options, variant ? name : null);
  const selected = variant ? family.candidates.find(item => item.name === name
    && item.release.dataVersion <= family.target.dataVersion && releaseAtMost(item.release, family.target)
    && provenanceAllowed(item.provenance, options)) : family.selected;
  if (!selected) throw new Error(`No compatible known-version schematic for ${fileName} on Minecraft ${String(options.version)}; ${validationDiagnostic(rejectedProvenance(family, variant ? name : null), options)}`);
  return selectionResult(path.join(parent, selected.name), selected, options);
}

async function getPackDirectory(packName, directory) {
  const packsRoot = path.resolve(directory, "schems");
  const realDirectory = await getRealRoot(path.resolve(directory));
  const realPacksRoot = await realpath(packsRoot);
  if (!isWithinDirectory(realDirectory, realPacksRoot)) {
    throw new Error("Schematic packs directory resolves outside the configured schematics root");
  }
  if (realPacksRoot !== path.join(realDirectory, "schems")) throw new Error("Symlinked schematic packs directories are not allowed");
  const packDirectory = path.join(packsRoot, packName);
  const realPackDirectory = await realpath(packDirectory);
  if (!isWithinDirectory(realPacksRoot, realPackDirectory)) {
    throw new Error(`Schematic pack ${packName} resolves outside the schems directory`);
  }
  if (realPackDirectory !== path.join(realPacksRoot, packName)) throw new Error(`Symlinked schematic pack ${packName} is not allowed`);
  if (!(await stat(realPackDirectory)).isDirectory()) throw new Error(`Schematic pack ${packName} is not a directory`);
  return { packsRoot, realPacksRoot, packDirectory, realPackDirectory };
}

async function assertPackFile(packDirectory, realPackDirectory, fileName) {
  validatePackFileName(fileName);
  const candidate = path.join(packDirectory, fileName);
  const realCandidate = await realpath(candidate);
  if (!isWithinDirectory(realPackDirectory, realCandidate)) {
    throw new Error(`Schematic pack file ${fileName} resolves outside its pack directory`);
  }
  if (realCandidate !== path.join(realPackDirectory, fileName)) throw new Error(`Symlinked schematic pack file ${fileName} is not allowed`);
  if (!(await stat(realCandidate)).isFile()) throw new Error(`Schematic pack target ${fileName} is not a regular file`);
  return candidate;
}

async function readPackIndex(packDirectory, realPackDirectory) {
  const indexPath = path.join(packDirectory, "index.json");
  let source;
  try {
    const realIndex = await realpath(indexPath);
    if (!isWithinDirectory(realPackDirectory, realIndex)) throw new Error("Schematic pack index resolves outside its pack directory");
    if (realIndex !== path.join(realPackDirectory, "index.json")) throw new Error("Symlinked schematic pack index is not allowed");
    if (!(await stat(realIndex)).isFile()) throw new Error("Schematic pack index is not a regular file");
    source = await readFile(realIndex, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { mappings: new Map(), fileNamesToTuple: new Map() };
    throw error;
  }

  let parsed;
  try {
    parsed = parseUniqueJson(source);
  } catch (error) {
    throw new Error(`Invalid schematic pack index.json: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).length !== 2 || parsed.schemaVersion !== 2
    || !parsed.groups || typeof parsed.groups !== "object" || Array.isArray(parsed.groups)) {
    throw new Error('Invalid schematic pack index.json: expected schemaVersion 2 and a groups object');
  }

  const mappings = new Map();
  const fileNamesToTuple = new Map();
  const normalizedGroups = new Set();
  for (const [rawGroup, rawFileIds] of Object.entries(parsed.groups)) {
    let group;
    try {
      group = normalizePositivePart(rawGroup, "group");
    } catch (error) {
      throw new Error(`Invalid schematic group in index: ${rawGroup}: ${error.message}`);
    }
    if (normalizedGroups.has(group)) throw new Error(`Schematic pack index contains duplicate normalized group ${group}`);
    normalizedGroups.add(group);
    if (!rawFileIds || typeof rawFileIds !== "object" || Array.isArray(rawFileIds)) {
      throw new Error(`Invalid schematic pack index group ${rawGroup}: expected a file-ID-to-file-name object`);
    }
    const fileIds = new Map();
    const normalizedFileIds = new Set();
    for (const [rawFileId, fileName] of Object.entries(rawFileIds)) {
      let fileId;
      try {
        fileId = normalizePositivePart(rawFileId, "file id");
      } catch (error) {
        throw new Error(`Invalid schematic file id in index group ${rawGroup}: ${rawFileId}: ${error.message}`);
      }
      if (normalizedFileIds.has(fileId)) throw new Error(`Schematic pack index contains duplicate normalized file id ${fileId} in group ${group}`);
      normalizedFileIds.add(fileId);
      validatePackFileName(fileName);
      if (!fileName.endsWith(".schem")) throw new Error("Schematic index family keys must use .schem");
      const priorTuple = fileNamesToTuple.get(fileName);
      if (priorTuple) throw new Error(`Schematic pack index maps ${fileName} to multiple tuples (${priorTuple.group}:${priorTuple.fileId} and ${group}:${fileId})`);
      fileIds.set(fileId, fileName);
      fileNamesToTuple.set(fileName, { group, fileId });
    }
    mappings.set(group, fileIds);
  }
  return { mappings, fileNamesToTuple };
}

async function scanPack(packName, directory) {
  const { packDirectory, realPackDirectory } = await getPackDirectory(packName, directory);
  const entries = await readdir(packDirectory, { withFileTypes: true });
  const fileNames = [];
  for (const entry of entries) {
    if (!entry.isFile() || !VARIANT.test(entry.name)) continue;
    try {
      await assertPackFile(packDirectory, realPackDirectory, entry.name);
      fileNames.push(entry.name);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      if (error.message.includes("resolves outside")) continue;
      throw error;
    }
  }

  const { mappings, fileNamesToTuple } = await readPackIndex(packDirectory, realPackDirectory);
  return { packDirectory, fileNames: fileNames.sort((a, b) => a.localeCompare(b)), mappings, fileNamesToTuple };
}

async function resolvePackSchematic(packName, selector, directory, options) {
  if (!selector) throw new TypeError("A pack-qualified file name or both numeric group and file ID are required");
  const { packDirectory, fileNames, mappings, fileNamesToTuple } = await scanPack(packName, directory);
  requireTarget(options);
  const indexedSelector = GROUP_AND_FILE_ID_SELECTOR.exec(selector);
  if (selector.includes(":") && !indexedSelector) throw new TypeError("Pack schematic selector must be packN:<group>:<fileId>");
  if (/^\d+$/.test(selector)) throw new TypeError("A numeric schematic selector needs both group and fileId: packN:<group>:<fileId>");
  let name;
  if (indexedSelector) {
    const group = normalizePositivePart(indexedSelector[1], "group");
    const fileId = normalizePositivePart(indexedSelector[2], "file id");
    name = mappings.get(group)?.get(fileId);
    if (!name) throw new Error(`No schematic with group ${group} and file id ${fileId} was found in ${packName}`);
  } else {
    name = selector.endsWith(".schem") ? selector : `${selector}.schem`;
    validatePackFileName(name);
    if (!name.endsWith(".schem") || /\.(?:schematic|litematic)(?:\.schem)?$/i.test(name)) throw new Error("Only version-suffixed .schem files are supported");
  }
  const variant = VARIANT.exec(name);
  const base = variant ? `${variant[1]}.schem` : name;
  const owner = fileNamesToTuple.get(name) ?? fileNamesToTuple.get(base);
  const owned = candidate => {
    const tuple = fileNamesToTuple.get(candidate);
    return !tuple || (owner && tuple.group === owner.group && tuple.fileId === owner.fileId);
  };
  const family = await selectFamily(base, fileNames, packDirectory, options.version, owned, options, variant ? name : null);
  const selected = variant ? family.candidates.find(item => item.name === name
    && item.release.dataVersion <= family.target.dataVersion && releaseAtMost(item.release, family.target)
    && provenanceAllowed(item.provenance, options)) : family.selected;
  if (!selected) throw new Error(`No compatible known-version schematic for ${packName}:${selector} on Minecraft ${String(options.version)}; ${validationDiagnostic(rejectedProvenance(family, variant ? name : null), options)}`);
  const { realPackDirectory } = await getPackDirectory(packName, directory);
  return selectionResult(await assertPackFile(packDirectory, realPackDirectory, selected.name), selected, options);
}

/** List eligible root-level variants; symbolic links are never candidates. */
export async function listSchematics(directory = SCHEMATICS_DIR, options = undefined) {
  requireTarget(options);
  const root = path.resolve(directory);
  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const names = entries.filter(entry => entry.isFile() && VARIANT.test(entry.name)).map(entry => entry.name);
  const fileNames = [];
  const families = new Map();
  for (const name of names) {
    const base = `${VARIANT.exec(name)[1]}.schem`;
    if (!families.has(base)) {
      try { families.set(base, await selectFamily(base, names, root, options.version, () => true, options)); }
      catch { families.set(base, null); }
    }
    const family = families.get(base);
    const item = family?.candidates.find(candidate => candidate.name === name);
    if (item && item.release.dataVersion <= family.target.dataVersion && releaseAtMost(item.release, family.target)
        && provenanceAllowed(item.provenance, options)) fileNames.push(name);
  }

  return fileNames.sort((left, right) => left.localeCompare(right));
}

/** List pack schematics with explicit group, fileId, and fileName fields plus legacy aliases. */
export async function listSchematicEntries(directory = SCHEMATICS_DIR, options = undefined) {
  requireTarget(options);
  let rootEntries;
  try { rootEntries = await readdir(path.resolve(directory), { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; rootEntries = []; }
  const legacyFileNames = rootEntries.filter(entry => entry.isFile() && VARIANT.test(entry.name)).map(entry => entry.name);
  const packsRoot = path.resolve(directory, "schems");
  const entryWithAliases = (pack, group, fileId, fileName) => ({
    pack,
    group,
    fileId,
    fileName,
    // Keep the original listing shape for existing callers while new code uses unambiguous names.
    id: fileId,
    filename: fileName,
  });
  const legacyEntry = (fileName) => entryWithAliases("legacy", null, null, fileName);
  const provenanceCache = new Map();
  async function annotate(result, name, names, folder, owned, selector, exact = false) {
    const filename = path.join(folder, name);
    if (!provenanceCache.has(filename)) provenanceCache.set(filename, schematicProvenance(filename));
    const provenance = await provenanceCache.get(filename);
    result = { ...result, ...provenance };
    if (!options || !name.toLowerCase().endsWith(".schem")) return result;
    const match = VARIANT.exec(name);
    const base = match ? `${match[1]}.schem` : name;
    try {
      const family = await selectFamily(base, names, folder, options.version, owned, options, exact ? name : null);
      const item = family.candidates.find((candidate) => candidate.name === name);
      return { ...result, selector, version: item?.release.minecraftVersion ?? null,
        compatible: item ? item.release.dataVersion <= family.target.dataVersion && releaseAtMost(item.release, family.target) && provenanceAllowed(item.provenance, options) : false,
        selected: exact ? Boolean(item && item.release.dataVersion <= family.target.dataVersion && releaseAtMost(item.release, family.target) && provenanceAllowed(item.provenance, options)) : family.selected?.name === name };
    } catch (error) {
      const version = match?.[2] ?? (await baseRelease(path.join(folder, name)))?.minecraftVersion ?? null;
      return { ...result, selector, version, compatible: false, selected: false, selectionError: error.message };
    }
  }
  const legacyResults = [];
  for (const name of legacyFileNames) {
    const base = VARIANT.exec(name)?.[1];
    legacyResults.push(await annotate(legacyEntry(name), name, legacyFileNames, path.resolve(directory), () => true, base ? `${base}.schem` : name));
  }
  let entries;
  try {
    entries = await readdir(packsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return legacyResults;
    throw error;
  }

  const results = legacyResults;
  for (const entry of entries) {
    if (!PACK_NAME.test(entry.name) || !entry.isDirectory()) continue;
    const pack = await scanPack(entry.name, directory);
    for (const fileName of pack.fileNames) {
      const match = VARIANT.exec(fileName);
      const base = match ? `${match[1]}.schem` : fileName;
      const tuple = pack.fileNamesToTuple.get(fileName) ?? pack.fileNamesToTuple.get(base);
      const owned = (name) => {
        const other = pack.fileNamesToTuple.get(name);
        return !other || (tuple && other.group === tuple.group && other.fileId === tuple.fileId);
      };
      const selector = tuple ? `${entry.name}:${tuple.group}:${tuple.fileId}` : `${entry.name}:${base}`;
      results.push(await annotate(entryWithAliases(entry.name, tuple?.group ?? null, tuple?.fileId ?? null, fileName),
        fileName, pack.fileNames, pack.packDirectory, owned, selector, Boolean(match && pack.fileNamesToTuple.has(fileName))));
    }
  }
  return results.sort((left, right) => {
    const packOrder = left.pack.localeCompare(right.pack);
    if (packOrder) return packOrder;
    if (left.group !== right.group) {
      if (left.group === null) return 1;
      if (right.group === null) return -1;
      return left.group - right.group;
    }
    if (left.fileId !== right.fileId) {
      if (left.fileId === null) return 1;
      if (right.fileId === null) return -1;
      return left.fileId - right.fileId;
    }
    return left.fileName.localeCompare(right.fileName);
  });
}

/** Parse an optional finite numeric coordinate, returning null when it is omitted. */
export function parseOptionalCoordinate(value) {
  if (value === undefined || value === null || value === "null") return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      throw new TypeError("Coordinate must be a finite number or a full numeric string");
    }
    const number = Number(trimmed);
    if (Number.isFinite(number)) return number;
    throw new TypeError("Coordinate must be finite");
  }

  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError("Coordinate must be a finite number or a full numeric string");
}
