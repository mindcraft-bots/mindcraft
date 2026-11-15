import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listSchematics,
  parseOptionalCoordinate,
  resolveSchematicPath,
} from "../../src/utils/schematic/paths.js";

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mindcraft-schematics-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("resolveSchematicPath accepts confined files and confined missing candidates", async () => {
  await withTempDirectory(async (directory) => {
    const existing = path.join(directory, "house.schem");
    await writeFile(existing, "schematic");

    assert.equal(await resolveSchematicPath("house.schem", directory), existing);
    assert.equal(await resolveSchematicPath("future.schematic", directory), path.join(directory, "future.schematic"));
  });
});

test("resolveSchematicPath rejects absolute, empty, NUL, and traversal paths", async () => {
  await withTempDirectory(async (directory) => {
    for (const filename of ["", "/tmp/outside.schem", "../outside.schem", "nested/../../outside.schem", "bad\0name.schem"]) {
      await assert.rejects(resolveSchematicPath(filename, directory));
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
      await assert.rejects(resolveSchematicPath("escape/secret.schem", directory));
      await assert.rejects(resolveSchematicPath("escape/not-created.schem", directory));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("listSchematics returns sorted supported regular files and ignores escaping symlinks", async () => {
  await withTempDirectory(async (directory) => {
    const outside = path.join(path.dirname(directory), `${path.basename(directory)}-outside.schem`);
    await writeFile(path.join(directory, "zeta.litematic"), "file");
    await writeFile(path.join(directory, "alpha.schem"), "file");
    await writeFile(path.join(directory, "middle.schematic"), "file");
    await writeFile(path.join(directory, "ignored.txt"), "file");
    await mkdir(path.join(directory, "folder.schem"));
    await writeFile(outside, "outside");
    await symlink(outside, path.join(directory, "escape.schem"), "file");
    await symlink(path.join(directory, "alpha.schem"), path.join(directory, "inside.schem"), "file");

    try {
      assert.deepEqual(await listSchematics(directory), [
        "alpha.schem",
        "inside.schem",
        "middle.schematic",
        "zeta.litematic",
      ]);
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("listSchematics treats a missing directory as empty", async () => {
  await withTempDirectory(async (directory) => {
    assert.deepEqual(await listSchematics(path.join(directory, "missing")), []);
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
