import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SCHEMATICS_DIR,
  listSchematics,
  parseOptionalCoordinate,
  resolveSchematicPath,
} from "../../src/utils/schematic/paths.js";
import { syntheticSponge } from "./synthetic_sponge.js";
import { writeFixtureProvenance } from "./provenance_fixture.js";
const options = { version: "1.21.4", allowNonvalidatedSchematic: true };
async function makeVariant(directory, name) {
  const bytes = syntheticSponge();
  await writeFile(path.join(directory, name), bytes);
  writeFixtureProvenance(path.join(directory, name), bytes);
}

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mindcraft-schematics-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("resolveSchematicPath resolves a confined family but rejects missing and unversioned originals", async () => {
  await withTempDirectory(async directory => {
    await writeFile(path.join(directory, "house.schem"), "original");
    await assert.rejects(resolveSchematicPath("house.schem", directory, options), /No compatible/);
    await makeVariant(directory, "house.mc1.21.4.schem");
    assert.equal(await resolveSchematicPath("house.schem", directory, options), path.join(directory, "house.mc1.21.4.schem"));
    await assert.rejects(resolveSchematicPath("future.schematic", directory, options), /Only version-suffixed/);
  });
});

test("resolveSchematicPath rejects absolute, empty, NUL, and traversal paths", async () => {
  await withTempDirectory(async (directory) => {
    for (const filename of ["", "/tmp/outside.schem", "../outside.schem", "nested/../../outside.schem", "bad\0name.schem"]) {
      await assert.rejects(resolveSchematicPath(filename, directory, options));
    }
  });
});

test("resolveSchematicPath rejects symlinks and missing descendants that escape", async () => {
  await withTempDirectory(async (directory) => {
    const outside = path.join(path.dirname(directory), `${path.basename(directory)}-outside`);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.schem"), "outside");
    await symlink(outside, path.join(directory, "escape"), "dir");

    try {
      await assert.rejects(resolveSchematicPath("escape/secret.schem", directory, options));
      await assert.rejects(resolveSchematicPath("escape/not-created.schem", directory, options));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("listSchematics returns only eligible versioned regular files and ignores symlinks", async () => {
  await withTempDirectory(async (directory) => {
    const outside = path.join(path.dirname(directory), `${path.basename(directory)}-outside.schem`);
    await writeFile(path.join(directory, "zeta.litematic"), "file");
    await writeFile(path.join(directory, "alpha.schem"), "file");
    await makeVariant(directory, "alpha.mc1.21.4.schem");
    await writeFile(path.join(directory, "middle.schematic"), "file");
    await writeFile(path.join(directory, "ignored.txt"), "file");
    await mkdir(path.join(directory, "folder.schem"));
    await writeFile(outside, "outside");
    await symlink(outside, path.join(directory, "escape.schem"), "file");
    await symlink(path.join(directory, "alpha.mc1.21.4.schem"), path.join(directory, "inside.mc1.21.4.schem"), "file");

    try {
      assert.deepEqual(await listSchematics(directory, options), ["alpha.mc1.21.4.schem"]);
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("listSchematics treats a missing directory as empty", async () => {
  await withTempDirectory(async (directory) => {
    assert.deepEqual(await listSchematics(path.join(directory, "missing"), options), []);
  });
});

test("parseOptionalCoordinate handles omitted values and finite numeric values/strings", () => {
  for (const value of [undefined, null, "null", "", "   "]) {
    assert.equal(parseOptionalCoordinate(value), null);
  }
  assert.equal(parseOptionalCoordinate(12.5), 12.5);
  assert.equal(parseOptionalCoordinate("-2.75"), -2.75);
  assert.equal(parseOptionalCoordinate("+3e2"), 300);
});

test("parseOptionalCoordinate rejects invalid and non-finite values", () => {
  for (const value of ["abc", "12 blocks", "Infinity", "1e999", Infinity, NaN, true]) {
    assert.throws(() => parseOptionalCoordinate(value));
  }
});
