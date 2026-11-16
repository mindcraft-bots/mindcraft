import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export const SCHEMATICS_DIR = path.resolve(moduleDirectory, "../../../schematics");
export const SCHEMATIC_PACKS_DIR = path.join(SCHEMATICS_DIR, "schems");

const SCHEMATIC_EXTENSIONS = new Set([".schem", ".schematic", ".litematic"]);
const PACK_NAME = /^pack[1-9]\d*$/;
const PACK_ID = /^(\d+)-(\d+)$/;
const GROUP_OFFSET_ID = /^(\d+):(\d+)$/;
const DIRECT_ID_FILENAME = /^(\d+-\d+)_[\w.-]+\.(?:schem|schematic|litematic)$/i;

function normalizeIdPart(value, label) {
  if (!/^\d+$/.test(value)) throw new TypeError(`Schematic ${label} must be a positive whole number`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`Schematic ${label} must be between 1 and ${Number.MAX_SAFE_INTEGER}`);
  }
  return String(number).padStart(2, "0");
}

function normalizePackId(group, fileId) {
  return `${normalizeIdPart(group, "group")}-${normalizeIdPart(fileId, "file ID")}`;
}

function splitPackId(id) {
  const match = PACK_ID.exec(id);
  if (!match) throw new Error(`Invalid schematic pack ID: ${id}`);
  return {
    id: normalizePackId(match[1], match[2]),
    group: normalizeIdPart(match[1], "group"),
    fileId: normalizeIdPart(match[2], "file ID"),
  };
}

function isWithinDirectory(directory, candidate) {
  const relativePath = path.relative(directory, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath));
}

function validateFilename(filename) {
  if (typeof filename !== "string" || filename.length === 0 || filename.includes("\0") || filename.includes("\\")) {
    throw new TypeError("Schematic filename must be a non-empty path without NUL or backslash characters");
  }

  if (path.isAbsolute(filename) || path.win32.isAbsolute(filename)) {
    throw new TypeError("Absolute schematic paths are not allowed");
  }
}

function validatePackFileName(filename) {
  if (typeof filename !== "string" || filename.length === 0 || filename.includes("\0") || filename.includes("\\")
    || filename === "." || filename === ".." || filename.includes("/") || path.isAbsolute(filename) || path.win32.isAbsolute(filename)) {
    throw new TypeError("Pack schematic must be a filename without absolute paths, traversal, NUL, or backslashes");
  }
  if (!SCHEMATIC_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
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
export async function resolveSchematicPath(filename, directory = SCHEMATICS_DIR) {
  validateFilename(filename);

  const packMatch = /^(pack[^:]*):(.*)$/.exec(filename);
  if (packMatch) {
    const [, packName, selector] = packMatch;
    if (!PACK_NAME.test(packName)) throw new TypeError(`Invalid schematic pack name: ${packName}`);
    return resolvePackSchematic(packName, selector, directory);
  }

  const root = path.resolve(directory);
  const candidate = path.resolve(root, filename);
  if (!isWithinDirectory(root, candidate)) {
    throw new Error("Schematic path escapes the schematics directory");
  }

  await assertExistingAncestorsStayWithin(root, candidate);
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

async function assertPackFile(packDirectory, realPackDirectory, filename) {
  validatePackFileName(filename);
  const candidate = path.join(packDirectory, filename);
  const realCandidate = await realpath(candidate);
  if (!isWithinDirectory(realPackDirectory, realCandidate)) {
    throw new Error(`Schematic pack file ${filename} resolves outside its pack directory`);
  }
  if (!(await stat(realCandidate)).isFile()) throw new Error(`Schematic pack target ${filename} is not a regular file`);
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
    if (error.code === "ENOENT") return new Map();
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid schematic pack index.json: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.ids || typeof parsed.ids !== "object" || Array.isArray(parsed.ids)) {
    throw new Error('Invalid schematic pack index.json: expected an object with an "ids" filename mapping');
  }

  const ids = new Map();
  const idsByFilename = new Map();
  for (const [rawId, filename] of Object.entries(parsed.ids)) {
    let id;
    try {
      id = splitPackId(rawId).id;
    } catch (error) {
      throw new Error(`Invalid schematic pack ID in index: ${rawId}: ${error.message}`);
    }
    if (ids.has(id)) throw new Error(`Schematic pack index contains duplicate numeric ID ${id}`);
    validatePackFileName(filename);
    const direct = DIRECT_ID_FILENAME.exec(filename);
    if (direct && splitPackId(direct[1]).id !== id) {
      throw new Error(`Schematic pack index conflict: ID ${id} points to ${filename}, whose filename declares ${splitPackId(direct[1]).id}`);
    }
    await assertPackFile(packDirectory, realPackDirectory, filename);
    const priorId = idsByFilename.get(filename);
    if (priorId) throw new Error(`Schematic pack index maps ${filename} to multiple IDs (${priorId} and ${id})`);
    ids.set(id, filename);
    idsByFilename.set(filename, id);
  }
  return ids;
}

async function scanPack(packName, directory) {
  const { packDirectory, realPackDirectory } = await getPackDirectory(packName, directory);
  const entries = await readdir(packDirectory, { withFileTypes: true });
  const filenames = [];
  for (const entry of entries) {
    if (!SCHEMATIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      await assertPackFile(packDirectory, realPackDirectory, entry.name);
      filenames.push(entry.name);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      if (error.message.includes("resolves outside")) continue;
      throw error;
    }
  }

  const ids = await readPackIndex(packDirectory, realPackDirectory);
  for (const filename of filenames) {
    const direct = DIRECT_ID_FILENAME.exec(filename);
    if (!direct) continue;
    const id = splitPackId(direct[1]).id;
    const indexedFilename = ids.get(id);
    if (indexedFilename && indexedFilename !== filename) {
      throw new Error(`Schematic pack ID conflict: index maps ${id} to ${indexedFilename}, but ${filename} declares the same ID`);
    }
    ids.set(id, filename);
  }
  return { packDirectory, filenames: filenames.sort((a, b) => a.localeCompare(b)), ids };
}

async function resolvePackSchematic(packName, selector, directory) {
  if (!selector) throw new TypeError("A pack-qualified filename or both numeric group and file ID are required");
  const { packDirectory, filenames, ids } = await scanPack(packName, directory);
  let matches;
  const groupOffset = GROUP_OFFSET_ID.exec(selector);
  if (selector.includes(":") && !groupOffset) {
    throw new TypeError("Pack schematic IDs must be packN:<numeric-group>:<numeric-file-ID>");
  }
  if (/^\d+$/.test(selector)) {
    throw new TypeError("A numeric schematic selector needs both group and file ID: packN:<group>:<file-ID>");
  }
  if (groupOffset) {
    const id = normalizePackId(groupOffset[1], groupOffset[2]);
    const filename = ids.get(id);
    if (!filename) throw new Error(`No schematic with group ${id.split("-")[0]} and file ID ${id.split("-")[1]} was found in ${packName}`);
    matches = [filename];
  } else {
    const selectorHasExtension = SCHEMATIC_EXTENSIONS.has(path.extname(selector).toLowerCase());
    validatePackFileName(selectorHasExtension ? selector : `${selector}.schem`);
    matches = filenames.filter((filename) => selectorHasExtension
      ? filename === selector
      : path.basename(filename, path.extname(filename)) === selector);
    if (matches.length === 0 && PACK_ID.test(selector)) {
      throw new TypeError(`Dash-form schematic IDs are unsupported; use ${packName}:<group>:<file-ID> or a literal filename/stem`);
    }
    if (matches.length === 0) throw new Error(`No schematic named ${selector} was found in ${packName}`);
    if (matches.length > 1) throw new Error(`Ambiguous schematic name ${selector} in ${packName}: ${matches.join(", ")}`);
  }
  const { realPackDirectory } = await getPackDirectory(packName, directory);
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

  const filenames = [];
  for (const entry of entries) {
    if (!SCHEMATIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

    const candidate = path.join(root, entry.name);
    if (entry.isFile()) {
      filenames.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;

    try {
      const realCandidate = await realpath(candidate);
      if (!isWithinDirectory(realRoot, realCandidate)) continue;
      if ((await stat(candidate)).isFile()) filenames.push(entry.name);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      throw error;
    }
  }

  return filenames.sort((left, right) => left.localeCompare(right));
}

/** List pack schematics with stable group/file IDs, pack name, and exact filename. */
export async function listSchematicEntries(directory = SCHEMATICS_DIR) {
  const legacyFilenames = await listSchematics(directory);
  const packsRoot = path.resolve(directory, "schems");
  const legacyEntry = (filename) => ({ pack: "legacy", id: null, group: null, fileId: null, filename });
  let entries;
  try {
    entries = await readdir(packsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return legacyFilenames.map(legacyEntry);
    throw error;
  }

  const results = legacyFilenames.map(legacyEntry);
  for (const entry of entries) {
    if (!PACK_NAME.test(entry.name) || !entry.isDirectory()) continue;
    const pack = await scanPack(entry.name, directory);
    const idByFilename = new Map([...pack.ids].map(([id, filename]) => [filename, id]));
    for (const filename of pack.filenames) {
      const id = idByFilename.get(filename) ?? null;
      const [group, fileId] = id ? id.split("-") : [null, null];
      results.push({ pack: entry.name, id, group, fileId, filename });
    }
  }
  return results.sort((left, right) => {
    const packOrder = left.pack.localeCompare(right.pack);
    if (packOrder) return packOrder;
    const idOrder = left.id === right.id ? 0 : left.id === null ? 1 : right.id === null ? -1 : left.id.localeCompare(right.id);
    return idOrder || left.filename.localeCompare(right.filename);
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
