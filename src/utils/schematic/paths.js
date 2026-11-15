import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export const SCHEMATICS_DIR = path.resolve(moduleDirectory, "../../../schematics");

const SCHEMATIC_EXTENSIONS = new Set([".schem", ".schematic", ".litematic"]);

function isWithinDirectory(directory, candidate) {
  const relativePath = path.relative(directory, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath));
}

function validateFilename(filename) {
  if (typeof filename !== "string" || filename.length === 0 || filename.includes("\0")) {
    throw new TypeError("Schematic filename must be a non-empty string without NUL characters");
  }

  if (path.isAbsolute(filename) || path.win32.isAbsolute(filename)) {
    throw new TypeError("Absolute schematic paths are not allowed");
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

  const root = path.resolve(directory);
  const candidate = path.resolve(root, filename);
  if (!isWithinDirectory(root, candidate)) {
    throw new Error("Schematic path escapes the schematics directory");
  }

  await assertExistingAncestorsStayWithin(root, candidate);
  return candidate;
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
