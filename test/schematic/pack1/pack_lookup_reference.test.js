import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SCHEMATICS_DIR,
  listSchematicEntries as listEntries,
  resolveSchematicPath as resolvePath,
} from "../../../src/utils/schematic/paths.js";
import { writeFixtureProvenance } from "../provenance_fixture.js";
const options = { version: "1.21.4", allowNonvalidatedSchematic: true };
const resolveSchematicPath = (selector, root = SCHEMATICS_DIR) => resolvePath(selector, root, options);
const listSchematicEntries = (root = SCHEMATICS_DIR) => listEntries(root, options);
async function artifact(folder, base) {
  const name = base.replace(/\.schem$/, '.mc1.21.4.schem');
  const bytes = await readFile(path.join(SCHEMATICS_DIR, 'schems/pack1/02_bee_hot_air_balloon.mc1.21.4.schem'));
  await writeFile(path.join(folder, name), bytes);
  writeFixtureProvenance(path.join(folder, name), bytes);
  return name;
}

async function withRoot(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mindcraft-pack-lookup-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createPack(root, name = "pack1") {
  const directory = path.join(root, "schems", name);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function writeManifest(directory, groups) {
  await writeFile(path.join(directory, "index.json"), JSON.stringify({ schemaVersion: 2, groups }, null, 2));
}

test("versioned manifest preserves real pack mappings and literal filename selection", async () => {
  const filename = "01_wardrobe_nether_portal.schem";
  const expected = path.join(SCHEMATICS_DIR, "schems", "pack1", filename.replace(/\.schem$/, ".mc1.21.4.schem"));
  assert.equal(await resolveSchematicPath("pack1:1:1"), expected);
  assert.equal(await resolveSchematicPath("pack1:01:01"), expected);
  assert.equal(await resolveSchematicPath("pack1:01_wardrobe_nether_portal"), expected);
  assert.equal(await resolveSchematicPath(`pack1:${filename}`), expected);

  const index = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(SCHEMATICS_DIR, "schems", "pack1", "index.json"), "utf8"));
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.groups["1"]["1"], filename);
  assert.equal(Object.hasOwn(index, "ids"), false);
});

