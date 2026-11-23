import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SCHEMATICS_DIR,
  listSchematicEntries as listEntries,
  resolveSchematicPath as resolvePath,
} from "../../src/utils/schematic/paths.js";
import { syntheticSponge } from "./synthetic_sponge.js";
import { writeFixtureProvenance } from "./provenance_fixture.js";
const options = { version: "1.21.4", allowNonvalidatedSchematic: true };
const resolveSchematicPath = (selector, root = SCHEMATICS_DIR) => resolvePath(selector, root, options);
const listSchematicEntries = (root = SCHEMATICS_DIR) => listEntries(root, options);
async function artifact(folder, base) {
  const name = base.replace(/\.schem$/, '.mc1.21.4.schem');
  const bytes = syntheticSponge();
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

test("manifest JSON strings preserve spaces, delimiters, quotes, and escapes in literal filenames", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    const filenames = ['a house.schem', 'a,b.schem', 'a]b.schem', 'a}b.schem', 'a"b.schem'];
    const ids = {};
    for (const [index, filename] of filenames.entries()) {
      await artifact(pack, filename);
      ids[index + 1] = filename;
    }
    await writeManifest(pack, { 1: ids });
    for (const [index, filename] of filenames.entries()) {
      assert.equal(await resolveSchematicPath(`pack1:1:${index + 1}`, root), path.join(pack, filename.replace(/\.schem$/, ".mc1.21.4.schem")));
      assert.equal(await resolveSchematicPath(`pack1:${filename}`, root), path.join(pack, filename.replace(/\.schem$/, ".mc1.21.4.schem")));
    }
    assert.deepEqual((await listSchematicEntries(root)).map(entry => entry.filename), filenames.map(name => name.replace(/\.schem$/, ".mc1.21.4.schem")));
  });
});

test("numeric keys resolve independently, including sparse and wide values", async () => {
  await withRoot(async root => {
    const first = await createPack(root, "pack1"), second = await createPack(root, "pack2");
    for (const name of ["first-entry.schem", "unmapped-automated-addition.schem"]) await artifact(first, name);
    for (const name of ["wide-entry.schem", "maximum-id-entry.schem"]) await artifact(second, name);
    await writeManifest(first, { 2: { 7: "first-entry.schem" } });
    await writeManifest(second, { 100: { 9007199254740991: "maximum-id-entry.schem" }, 9007199254740991: { 3: "wide-entry.schem" } });
    assert.equal(await resolveSchematicPath("pack1:02:007", root), path.join(first, "first-entry.mc1.21.4.schem"));
    assert.equal(await resolveSchematicPath("pack2:100:9007199254740991", root), path.join(second, "maximum-id-entry.mc1.21.4.schem"));
    assert.equal(await resolveSchematicPath("pack2:9007199254740991:3", root), path.join(second, "wide-entry.mc1.21.4.schem"));
    const entries = await listSchematicEntries(root);
    assert.deepEqual(entries.map(({ pack, group, fileId }) => [pack, group, fileId]), [
      ["pack1", 2, 7], ["pack1", null, null], ["pack2", 100, 9007199254740991], ["pack2", 9007199254740991, 3],
    ]);
    assert.ok(entries.every(entry => entry.validationStatus === "NONVALIDATED" && entry.selected));
  });
});

test("manifest mappings do not depend on filename prefixes or directory ordering", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await artifact(pack, "z-last-by-name.schem");
    await artifact(pack, "02_added_later.schem");
    await writeManifest(pack, { "11": { "4": "z-last-by-name.schem" } });

    assert.equal(await resolveSchematicPath("pack1:11:4", root), path.join(pack, "z-last-by-name.mc1.21.4.schem"));
    const entries = await listSchematicEntries(root);
    assert.deepEqual(entries.map(({ group, fileId, fileName }) => ({ group, fileId, fileName })), [
      { group: 11, fileId: 4, fileName: "z-last-by-name.mc1.21.4.schem" },
      { group: null, fileId: null, fileName: "02_added_later.mc1.21.4.schem" },
    ]);
  });
});

test("literal hyphenated filenames remain filenames and ambiguous stems fail closed", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await artifact(pack, "west-wing.schem");
    await artifact(pack, "shared.schem");
    await writeFile(path.join(pack, "shared.schematic"), "two");
    await writeManifest(pack, { "4": { "1": "west-wing.schem" } });

    assert.equal(await resolveSchematicPath("pack1:west-wing", root), path.join(pack, "west-wing.mc1.21.4.schem"));
    assert.equal(await resolveSchematicPath("pack1:west-wing.schem", root), path.join(pack, "west-wing.mc1.21.4.schem"));
    assert.equal(await resolveSchematicPath("pack1:shared", root), path.join(pack, "shared.mc1.21.4.schem"));
    await assert.rejects(resolveSchematicPath("pack1:shared.schematic", root), /Only version-suffixed/);
  });
});

test("reserved-word filenames resolve only through explicit filename forms and extensions", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await artifact(pack, "id.schem");
    await artifact(pack, "name.schem");
    await writeManifest(pack, {});

    assert.equal(await resolveSchematicPath("pack1:id", root), path.join(pack, "id.mc1.21.4.schem"));
    assert.equal(await resolveSchematicPath("pack1:name.schem", root), path.join(pack, "name.mc1.21.4.schem"));
    assert.equal(await resolveSchematicPath("pack1:id.schem", root), path.join(pack, "id.mc1.21.4.schem"));
  });
});

test("malformed manifest versions and invalid group/id values are rejected", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await writeFile(path.join(pack, "target.schem"), "file");
    const malformed = [
      { schemaVersion: 1, groups: { "1": { "1": "target.schem" } } },
      { schemaVersion: 2, groups: ["target.schem"] },
      { schemaVersion: 2, groups: { "0": { "1": "target.schem" } } },
      { schemaVersion: 2, groups: { "1": { "0": "target.schem" } } },
      { schemaVersion: 2, groups: { "9007199254740992": { "1": "target.schem" } } },
      { schemaVersion: 2, groups: { "1": { "9007199254740992": "target.schem" } } },
      { schemaVersion: 2, groups: { "1": "not-an-id-map" } },
      { schemaVersion: 2, groups: { "1": { "1": "../target.schem" } } },
      { schemaVersion: 2, groups: { "1": { "1": "unsupported.txt" } } },
    ];
    for (const manifest of malformed) {
      await writeFile(path.join(pack, "index.json"), JSON.stringify(manifest));
      await assert.rejects(resolveSchematicPath("pack1:target.schem", root));
    }
  });
});

test("numeric normalization collisions and duplicate filenames are rejected", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    for (const name of ["first.schem", "second.schem"]) await writeFile(path.join(pack, name), name);

    await writeManifest(pack, { "2": { "1": "first.schem" }, "02": { "2": "second.schem" } });
    await assert.rejects(resolveSchematicPath("pack1:2:1", root), /duplicate normalized group/);

    await writeManifest(pack, { "2": { "1": "first.schem", "01": "second.schem" } });
    await assert.rejects(resolveSchematicPath("pack1:2:1", root), /duplicate normalized file id/);

    await writeManifest(pack, { "2": { "1": "first.schem" }, "3": { "1": "first.schem" } });
    await assert.rejects(resolveSchematicPath("pack1:2:1", root), /maps first\.schem to multiple tuples/);
  });
});

test("manifest whitespace follows JSON rather than broader JavaScript whitespace", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    for (const whitespace of ['\u00a0', '\ufeff', '\v', '\f']) {
      await writeFile(path.join(pack, 'index.json'), whitespace + JSON.stringify({ schemaVersion: 2, groups: {} }));
      await assert.rejects(listSchematicEntries(root), /Invalid schematic pack index.json/);
    }
    await writeFile(path.join(pack, 'index.json'), ' \t\r\n' + JSON.stringify({ schemaVersion: 2, groups: {} }));
    assert.deepEqual(await listSchematicEntries(root), []);
  });
});

test("duplicate JSON keys are rejected and missing families are independent", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await writeFile(path.join(pack, "index.json"), '{"schemaVersion":2,"schemaVersion":2,"groups":{}}');
    await assert.rejects(resolveSchematicPath("pack1:anything.schem", root), /duplicate JSON object key/i);

    await writeManifest(pack, { "2": { "1": "missing.schem" } });
    await assert.rejects(resolveSchematicPath("pack1:anything.schem", root), /No compatible/);
    assert.deepEqual(await listSchematicEntries(root), []);
  });
});

test("manifest targets and pack directories cannot escape through symlinks", async () => {
  await withRoot(async (root) => {
    const packs = path.join(root, "schems");
    const pack = await createPack(root);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "escape.schem"), "secret");
    await symlink(outside, path.join(packs, "pack2"), "dir");
    await symlink(path.join(outside, "escape.schem"), path.join(pack, "linked.schem"), "file");

    await assert.rejects(resolveSchematicPath("pack2:escape.schem", root), /outside the schems directory/);
    await writeManifest(pack, { "4": { "1": "linked.schem" } });
    await assert.rejects(resolveSchematicPath("pack1:4:1", root), /No compatible/);
    assert.deepEqual(await listSchematicEntries(root), []);
    await writeManifest(pack, { "4": { "1": "..\\outside\\escape.schem" } });
    await assert.rejects(resolveSchematicPath("pack1:4:1", root), /without absolute paths, traversal/);
  });
});

test("selectors reject malformed numeric tuples and unsafe paths", async () => {
  await withRoot(async (root) => {
    await createPack(root);
    for (const selector of [
      "pack1:2", "pack1:2:", "pack1::1", "pack1:2:1:3", "pack1:0:1", "pack1:2:0",
      "pack1:9007199254740992:1", "pack1:/tmp/outside.schem", "pack1:../outside.schem",
      "pack1:folder\\outside.schem", "pack1:bad\0name.schem", "pack1:notes.txt", "pack0:house.schem",
    ]) {
      await assert.rejects(resolveSchematicPath(selector, root), undefined, selector);
    }
  });
});

test("supported-looking directories are not treated as schematic files", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await mkdir(path.join(pack, "not-a-file.schem"));
    await assert.rejects(resolveSchematicPath("pack1:not-a-file.schem", root), /No compatible/);
    assert.deepEqual(await listSchematicEntries(root), []);
  });
});

test("root-relative filename paths continue to resolve within the schematics root", async () => {
  await withRoot(async (root) => {
    await artifact(root, "legacy.schem");
    assert.equal(await resolveSchematicPath("legacy.schem", root), path.join(root, "legacy.mc1.21.4.schem"));
  });
});
