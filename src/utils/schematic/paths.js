import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import minecraftData from "minecraft-data";
import nbt from "prismarine-nbt";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export const SCHEMATICS_DIR = path.resolve(moduleDirectory, "../../../schematics");
export const SCHEMATIC_PACKS_DIR = path.join(SCHEMATICS_DIR, "schems");

const SCHEMATIC_EXTENSIONS = new Set([".schem", ".schematic", ".litematic"]);
const PACK_NAME = /^pack[1-9]\d*$/;
const GROUP_AND_FILE_ID_SELECTOR = /^(\d+):(\d+)$/;
const VARIANT = /^(.*)\.mc(\d+(?:\.\d+)+)\.schem$/;
// Older minecraft-data entries omit releaseType; numeric labels identify those releases.
const releases = minecraftData.versions.pc.filter((version) => /^\d+(?:\.\d+)+$/.test(version.minecraftVersion)
  && (version.releaseType === "release" || version.releaseType === undefined)
  && Number.isInteger(version.dataVersion) && version.dataVersion > 0);
const releasesByName = new Map(releases.map((version) => [version.minecraftVersion, version]));
const releasesByDataVersion = new Map(releases.map((version) => [version.dataVersion, version]));

function releaseFor(name) {
  return typeof name === "string" ? releasesByName.get(name) : undefined;
}

async function baseRelease(candidate) {
  try {
    const { parsed } = await nbt.parse(await readFile(candidate));
    const root = nbt.simplify(parsed);
    const version = root?.DataVersion ?? root?.Schematic?.DataVersion;
    return Number.isInteger(version) ? releasesByDataVersion.get(version) : undefined;
  } catch {
    return undefined;
  }
}

// Variant labels are the compiler's target release, not the registry's possibly aliased label.
async function selectFamily(baseName, fileNames, directory, targetVersion, owned = () => true) {
  if (!baseName.endsWith(".schem")) {
    throw new Error(`No compatible known-version schematic for case-sensitive filename ${baseName}`);
  }
  const target = releaseFor(targetVersion);
  if (!target) throw new Error(`Unknown Minecraft engine release ${String(targetVersion)}; cannot select a schematic version`);
  const stem = baseName.slice(0, -".schem".length);
  const candidates = [];
  for (const name of fileNames) {
    if (!owned(name)) continue;
    const match = VARIANT.exec(name);
    if (match && match[1] === stem) {
      const release = releaseFor(match[2]);
      if (release) candidates.push({ name, release, variant: true });
    } else if (name === baseName) {
      const release = await baseRelease(path.join(directory, name));
      if (release) candidates.push({ name, release, variant: false });
    }
  }
  const seen = new Map();
  for (const candidate of candidates.filter((item) => item.variant)) {
    const previous = seen.get(candidate.release.dataVersion);
    if (previous) throw new Error(`Ambiguous schematic variants ${previous} and ${candidate.name} share a DataVersion`);
    seen.set(candidate.release.dataVersion, candidate.name);
  }
  const compatible = candidates.filter(({ release }) => release.dataVersion <= target.dataVersion)
    .sort((a, b) => b.release.dataVersion - a.release.dataVersion || Number(b.variant) - Number(a.variant));
  return { candidates, selected: compatible[0] ?? null, target };
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

  const root = path.resolve(directory);
  const candidate = path.resolve(root, fileName);
  if (!isWithinDirectory(root, candidate)) {
    throw new Error("Schematic path escapes the schematics directory");
  }

  await assertExistingAncestorsStayWithin(root, candidate);
  if (options && path.extname(candidate).toLowerCase() === ".schem") {
    const parent = path.dirname(candidate);
    const names = await readdir(parent);
    const safeNames = [];
    for (const name of names) {
      if (path.extname(name).toLowerCase() !== ".schem") continue;
      try {
        const real = await realpath(path.join(parent, name));
        if (isWithinDirectory(await getRealRoot(root), real) && (await stat(real)).isFile()) safeNames.push(name);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      }
    }
    const name = path.basename(candidate);
    const explicit = VARIANT.exec(name);
    const base = explicit ? `${explicit[1]}.schem` : name;
    const family = await selectFamily(base, safeNames, parent, options.version);
    const selected = explicit ? family.candidates.find((item) => item.name === name
      && item.release.dataVersion <= family.target.dataVersion) : family.selected;
    if (!selected) throw new Error(`No compatible known-version schematic for ${fileName} on Minecraft ${String(options.version)}`);
    const result = path.join(parent, selected.name);
    await assertExistingAncestorsStayWithin(root, result);
    return result;
  }
  return candidate;
}

async function getPackDirectory(packName, directory) {
  const packsRoot = path.resolve(directory, "schems");
  const realDirectory = await getRealRoot(path.resolve(directory));
  const realPacksRoot = await realpath(packsRoot);
  if (!isWithinDirectory(realDirectory, realPacksRoot)) {
    throw new Error("Schematic packs directory resolves outside the configured schematics root");
  }
  const packDirectory = path.join(packsRoot, packName);
  const realPackDirectory = await realpath(packDirectory);
  if (!isWithinDirectory(realPacksRoot, realPackDirectory)) {
    throw new Error(`Schematic pack ${packName} resolves outside the schems directory`);
  }
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
  if (!(await stat(realCandidate)).isFile()) throw new Error(`Schematic pack target ${fileName} is not a regular file`);
  return candidate;
}

async function readPackIndex(packDirectory, realPackDirectory) {
  const indexPath = path.join(packDirectory, "index.json");
  let source;
  try {
    const realIndex = await realpath(indexPath);
    if (!isWithinDirectory(realPackDirectory, realIndex)) throw new Error("Schematic pack index resolves outside its pack directory");
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
      await assertPackFile(packDirectory, realPackDirectory, fileName);
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
    if (!SCHEMATIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
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
  let matches;
  const indexedSelector = GROUP_AND_FILE_ID_SELECTOR.exec(selector);
  if (selector.includes(":") && !indexedSelector) {
    throw new TypeError("Pack schematic selector must be packN:<group>:<fileId>");
  }
  if (/^\d+$/.test(selector)) {
    throw new TypeError("A numeric schematic selector needs both group and fileId: packN:<group>:<fileId>");
  }
  if (indexedSelector) {
    const group = normalizePositivePart(indexedSelector[1], "group");
    const fileId = normalizePositivePart(indexedSelector[2], "file id");
    const fileName = mappings.get(group)?.get(fileId);
    if (!fileName) throw new Error(`No schematic with group ${group} and file id ${fileId} was found in ${packName}`);
    matches = [fileName];
  } else {
    const selectorHasExtension = SCHEMATIC_EXTENSIONS.has(path.extname(selector).toLowerCase());
    validatePackFileName(selectorHasExtension ? selector : `${selector}.schem`);
    matches = fileNames.filter((fileName) => selectorHasExtension
      ? fileName === selector
      : path.basename(fileName, path.extname(fileName)) === selector);
    if (options && !VARIANT.test(selector)) {
      const base = selectorHasExtension ? selector : `${selector}.schem`;
      if (base.endsWith(".schem") && !matches.includes(base)
        && fileNames.some((name) => VARIANT.exec(name)?.[1] === base.slice(0, -6))) matches.push(base);
    }
    if (matches.length === 0) throw new Error(`No schematic named ${selector} was found in ${packName}`);
    if (matches.length > 1) throw new Error(`Ambiguous schematic name ${selector} in ${packName}: ${matches.join(", ")}`);
  }
  const { realPackDirectory } = await getPackDirectory(packName, directory);
  if (options && matches[0].toLowerCase().endsWith(".schem")) {
    const name = matches[0];
    const explicit = VARIANT.exec(name);
    const base = explicit ? `${explicit[1]}.schem` : name;
    const owner = fileNamesToTuple.get(name);
    const owned = (candidate) => {
      const tuple = fileNamesToTuple.get(candidate);
      return !tuple || (owner && tuple.group === owner.group && tuple.fileId === owner.fileId);
    };
    const family = await selectFamily(base, fileNames, packDirectory, options.version, owned);
    const selected = explicit ? family.candidates.find((item) => item.name === name
      && item.release.dataVersion <= family.target.dataVersion) : family.selected;
    if (!selected) throw new Error(`No compatible known-version schematic for ${packName}:${selector} on Minecraft ${String(options.version)}`);
    return assertPackFile(packDirectory, realPackDirectory, selected.name);
  }
  return assertPackFile(packDirectory, realPackDirectory, matches[0]);
}

/** List supported schematic filenames, sorted lexically; escaping symlinks are ignored. */
export async function listSchematics(directory = SCHEMATICS_DIR) {
  const root = path.resolve(directory);
  const realRoot = await getRealRoot(root);
  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const fileNames = [];
  for (const entry of entries) {
    if (!SCHEMATIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

    const candidate = path.join(root, entry.name);
    if (entry.isFile()) {
      fileNames.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;

    try {
      const realCandidate = await realpath(candidate);
      if (!isWithinDirectory(realRoot, realCandidate)) continue;
      if ((await stat(candidate)).isFile()) fileNames.push(entry.name);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      throw error;
    }
  }

  return fileNames.sort((left, right) => left.localeCompare(right));
}

/** List pack schematics with explicit group, fileId, and fileName fields plus legacy aliases. */
export async function listSchematicEntries(directory = SCHEMATICS_DIR, options = undefined) {
  const legacyFileNames = await listSchematics(directory);
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
  async function annotate(result, name, names, folder, owned, selector, exact = false) {
    if (!options || !name.toLowerCase().endsWith(".schem")) return result;
    const match = VARIANT.exec(name);
    const base = match ? `${match[1]}.schem` : name;
    try {
      const family = await selectFamily(base, names, folder, options.version, owned);
      const item = family.candidates.find((candidate) => candidate.name === name);
      return { ...result, selector, version: item?.release.minecraftVersion ?? null,
        compatible: item ? item.release.dataVersion <= family.target.dataVersion : false,
        selected: exact ? Boolean(item && item.release.dataVersion <= family.target.dataVersion) : family.selected?.name === name };
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
