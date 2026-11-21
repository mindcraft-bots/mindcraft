import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SCHEMATICS_DIR,
  listSchematicEntries,
  resolveSchematicPath,
} from "../../src/utils/schematic/paths.js";

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
  const expected = path.join(SCHEMATICS_DIR, "schems", "pack1", filename);
  assert.equal(await resolveSchematicPath("pack1:1:1"), expected);
  assert.equal(await resolveSchematicPath("pack1:01:01"), expected);
  assert.equal(await resolveSchematicPath("pack1:01_wardrobe_nether_portal"), expected);
  assert.equal(await resolveSchematicPath(`pack1:${filename}`), expected);

  const index = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(SCHEMATICS_DIR, "schems", "pack1", "index.json"), "utf8"));
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.groups["1"]["1"], filename);
  assert.equal(Object.hasOwn(index, "ids"), false);
});

test("manifest JSON strings preserve spaces, delimiters, quotes, and escapes in literal filenames", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    const filenames = ['a house.schem', 'a,b.schem', 'a]b.schem', 'a}b.schem', 'a"b.schem'];
    const ids = {};
    for (const [index, filename] of filenames.entries()) {
      await writeFile(path.join(pack, filename), 'fixture');
      ids[index + 1] = filename;
    }
    await writeManifest(pack, { 1: ids });
    for (const [index, filename] of filenames.entries()) {
      assert.equal(await resolveSchematicPath(`pack1:1:${index + 1}`, root), path.join(pack, filename));
      assert.equal(await resolveSchematicPath(`pack1:${filename}`, root), path.join(pack, filename));
    }
    assert.deepEqual((await listSchematicEntries(root)).map(entry => entry.filename), filenames);
  });
});

test("numeric keys resolve independently, including sparse and wide values", async () => {
  await withRoot(async (root) => {
    const first = await createPack(root, "pack1");
    const second = await createPack(root, "pack2");
    await writeFile(path.join(first, "first-entry.schematic"), "one");
    await writeFile(path.join(first, "unmapped-automated-addition.schem"), "two");
    await writeManifest(first, { "2": { "7": "first-entry.schematic" } });
    await writeFile(path.join(second, "wide-entry.litematic"), "three");
    await writeFile(path.join(second, "maximum-id-entry.schem"), "four");
    await writeManifest(second, {
      "100": { "9007199254740991": "maximum-id-entry.schem" },
      "9007199254740991": { "3": "wide-entry.litematic" },
    });

    assert.equal(await resolveSchematicPath("pack1:02:007", root), path.join(first, "first-entry.schematic"));
    assert.equal(await resolveSchematicPath("pack2:100:9007199254740991", root), path.join(second, "maximum-id-entry.schem"));
    assert.equal(await resolveSchematicPath("pack2:9007199254740991:3", root), path.join(second, "wide-entry.litematic"));
    const entries = await listSchematicEntries(root);
    assert.deepEqual(entries, [
      { pack: "pack1", group: 2, fileId: 7, fileName: "first-entry.schematic", id: 7, filename: "first-entry.schematic" },
      { pack: "pack1", group: null, fileId: null, fileName: "unmapped-automated-addition.schem", id: null, filename: "unmapped-automated-addition.schem" },
      { pack: "pack2", group: 100, fileId: 9007199254740991, fileName: "maximum-id-entry.schem", id: 9007199254740991, filename: "maximum-id-entry.schem" },
      { pack: "pack2", group: 9007199254740991, fileId: 3, fileName: "wide-entry.litematic", id: 3, filename: "wide-entry.litematic" },
    ]);
  });
});

test("manifest mappings do not depend on filename prefixes or directory ordering", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await writeFile(path.join(pack, "z-last-by-name.schem"), "one");
    await writeFile(path.join(pack, "02_added_later.schem"), "two");
    await writeManifest(pack, { "11": { "4": "z-last-by-name.schem" } });

    assert.equal(await resolveSchematicPath("pack1:11:4", root), path.join(pack, "z-last-by-name.schem"));
    const entries = await listSchematicEntries(root);
    assert.deepEqual(entries.map(({ group, fileId, fileName }) => ({ group, fileId, fileName })), [
      { group: 11, fileId: 4, fileName: "z-last-by-name.schem" },
      { group: null, fileId: null, fileName: "02_added_later.schem" },
    ]);
  });
});

test("literal hyphenated filenames remain filenames and ambiguous stems fail closed", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await writeFile(path.join(pack, "west-wing.schem"), "literal");
    await writeFile(path.join(pack, "shared.schem"), "one");
    await writeFile(path.join(pack, "shared.schematic"), "two");
    await writeManifest(pack, { "4": { "1": "west-wing.schem" } });

    assert.equal(await resolveSchematicPath("pack1:west-wing", root), path.join(pack, "west-wing.schem"));
    assert.equal(await resolveSchematicPath("pack1:west-wing.schem", root), path.join(pack, "west-wing.schem"));
    await assert.rejects(resolveSchematicPath("pack1:shared", root), /Ambiguous schematic name shared/);
  });
});

test("reserved-word filenames resolve only through explicit filename forms and extensions", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await writeFile(path.join(pack, "id.schem"), "id fixture");
    await writeFile(path.join(pack, "name.schem"), "name fixture");
    await writeManifest(pack, {});

    assert.equal(await resolveSchematicPath("pack1:id", root), path.join(pack, "id.schem"));
    assert.equal(await resolveSchematicPath("pack1:name.schem", root), path.join(pack, "name.schem"));
    assert.equal(await resolveSchematicPath("pack1:id.schem", root), path.join(pack, "id.schem"));
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

test("duplicate JSON keys and missing manifest targets are rejected", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await writeFile(path.join(pack, "index.json"), '{"schemaVersion":2,"schemaVersion":2,"groups":{}}');
    await assert.rejects(resolveSchematicPath("pack1:anything.schem", root), /duplicate JSON object key/i);

    await writeManifest(pack, { "2": { "1": "missing.schem" } });
    await assert.rejects(resolveSchematicPath("pack1:anything.schem", root), /ENOENT|no such file/i);
    await assert.rejects(listSchematicEntries(root), /ENOENT|no such file/i);
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
    await assert.rejects(resolveSchematicPath("pack1:4:1", root), /resolves outside its pack directory/);
    await assert.rejects(listSchematicEntries(root), /resolves outside its pack directory/);
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
    await assert.rejects(resolveSchematicPath("pack1:not-a-file.schem", root), /not a regular file/);
    await assert.rejects(listSchematicEntries(root), /not a regular file/);
  });
});

test("root-relative filename paths continue to resolve within the schematics root", async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, "legacy.schem"), "legacy");
    assert.equal(await resolveSchematicPath("legacy.schem", root), path.join(root, "legacy.schem"));
  });
});
