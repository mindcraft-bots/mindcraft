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

async function writeIndex(directory, ids) {
  await writeFile(path.join(directory, "index.json"), JSON.stringify({ _comment: "test", ids }, null, 2));
}

test("pack1 explicit manifest maps the actual wardrobe asset, and filename selectors accept both extensions", async () => {
  const filename = "01_wardrobe_nether_portal.schem";
  const expected = path.join(SCHEMATICS_DIR, "schems", "pack1", filename);
  assert.equal(await resolveSchematicPath("pack1:01:01"), expected);
  assert.equal(await resolveSchematicPath("pack1:1:1"), expected);
  await assert.rejects(resolveSchematicPath("pack1:01-01"), /Dash-form schematic IDs are unsupported/);
  assert.equal(await resolveSchematicPath("pack1:01_wardrobe_nether_portal"), expected);
  assert.equal(await resolveSchematicPath(`pack1:${filename}`), expected);

  const pack = path.join(SCHEMATICS_DIR, "schems", "pack1");
  const index = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(pack, "index.json"), "utf8"));
  assert.equal(index.ids["01-01"], filename);
});

test("IDs are stable per existing NN group and multiple same-group files use explicit alphabetical IDs", async () => {
  const pack = path.join(SCHEMATICS_DIR, "schems", "pack1");
  assert.equal(await resolveSchematicPath("pack1:02:01"), path.join(pack, "02_bee_hot_air_balloon.schem"));
  assert.equal(await resolveSchematicPath("pack1:2:1"), path.join(pack, "02_bee_hot_air_balloon.schem"));
  assert.equal(await resolveSchematicPath("pack1:02:02"), path.join(pack, "02_enderman_hot_air_balloon.schem"));
  assert.equal(await resolveSchematicPath("pack1:02:03"), path.join(pack, "02_pig_hot_air_balloon.schem"));
  for (const selector of ["pack1:02-01", "pack1:02-02", "pack1:02-03", "pack1:11-01"]) {
    await assert.rejects(resolveSchematicPath(selector), /Dash-form schematic IDs are unsupported/, selector);
  }
  await assert.rejects(resolveSchematicPath("pack1:01:02"), /No schematic with group 01 and file ID 02/);
});

test("pack IDs and filename lookup work independently across arbitrary packs", async () => {
  await withRoot(async (root) => {
    const first = await createPack(root, "pack1");
    const second = await createPack(root, "pack2");
    await writeFile(path.join(first, "legacy_group_name.schematic"), "one");
    await writeFile(path.join(first, "first_overlap.schem"), "one-and-a-half");
    await writeIndex(first, { "02-01": "first_overlap.schem", "07-03": "legacy_group_name.schematic" });
    await writeFile(path.join(second, "03-04_direct_indexed.schem"), "two");
    await writeFile(path.join(second, "historic_group_100.schem"), "three");
    await writeFile(path.join(second, "overlapping_tuple.schem"), "four");
    await writeIndex(second, { "02-01": "overlapping_tuple.schem", "03-04": "03-04_direct_indexed.schem", "100-03": "historic_group_100.schem" });

    assert.equal(await resolveSchematicPath("pack1:7:3", root), path.join(first, "legacy_group_name.schematic"));
    await assert.rejects(resolveSchematicPath("pack1:07-03", root), /Dash-form schematic IDs are unsupported/);
    assert.equal(await resolveSchematicPath("pack1:02:01", root), path.join(first, "first_overlap.schem"));
    assert.equal(await resolveSchematicPath("pack2:02:01", root), path.join(second, "overlapping_tuple.schem"));
    assert.equal(await resolveSchematicPath("pack2:3:4", root), path.join(second, "03-04_direct_indexed.schem"));
    assert.equal(await resolveSchematicPath("pack2:03-04_direct_indexed", root), path.join(second, "03-04_direct_indexed.schem"));
    assert.equal(await resolveSchematicPath("pack2:03-04_direct_indexed.schem", root), path.join(second, "03-04_direct_indexed.schem"));
    assert.equal(await resolveSchematicPath("pack2:100:3", root), path.join(second, "historic_group_100.schem"));
    await assert.rejects(resolveSchematicPath("pack2:03-04", root), /Dash-form schematic IDs are unsupported/);
  });
});

test("dash-shaped selectors resolve only when they are literal filenames or stems, never through the index", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await writeFile(path.join(pack, "mapped-file.schem"), "mapped");
    await writeFile(path.join(pack, "02-01.schem"), "literal");
    await writeIndex(pack, { "02-01": "mapped-file.schem" });

    assert.equal(await resolveSchematicPath("pack1:02:01", root), path.join(pack, "mapped-file.schem"));
    assert.equal(await resolveSchematicPath("pack1:02-01", root), path.join(pack, "02-01.schem"));
    assert.equal(await resolveSchematicPath("pack1:02-01.schem", root), path.join(pack, "02-01.schem"));

    await rm(path.join(pack, "02-01.schem"));
    await assert.rejects(resolveSchematicPath("pack1:02-01", root), /Dash-form schematic IDs are unsupported/);
  });
});

test("extensionless lookup rejects ambiguous same-stem supported files and reports ID conflicts", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await writeFile(path.join(pack, "double.schem"), "one");
    await writeFile(path.join(pack, "double.schematic"), "two");
    await assert.rejects(resolveSchematicPath("pack1:double", root), /Ambiguous schematic name double/);

    await writeFile(path.join(pack, "other.schem"), "three");
    await writeIndex(pack, { "08-01": "other.schem" });
    await writeFile(path.join(pack, "08-01_direct.schem"), "four");
    await assert.rejects(resolveSchematicPath("pack1:08-01", root), /ID conflict/);
  });
});

test("manifest targets cannot disagree with directly indexed filenames", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await writeFile(path.join(pack, "01-02_claimed.schem"), "direct");
    await writeIndex(pack, { "01-01": "01-02_claimed.schem" });
    await assert.rejects(resolveSchematicPath("pack1:01-01", root), /filename declares 01-02/);
  });
});

test("group/file IDs reject missing, malformed, zero, overflow, and numerically duplicate mappings", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await writeFile(path.join(pack, "named.schem"), "file");
    await writeIndex(pack, { "02-01": "named.schem" });

    for (const selector of ["pack1:2", "pack1:2:", "pack1::1", "pack1:2:1:3", "pack1:0:1", "pack1:2:0", "pack1:9007199254740992:1"]) {
      await assert.rejects(resolveSchematicPath(selector, root), undefined, selector);
    }

    await writeIndex(pack, { "02-01": "named.schem", "2-1": "named.schem" });
    await assert.rejects(resolveSchematicPath("pack1:2:1", root), /duplicate numeric ID/);
  });
});

test("pack entries reject supported-looking directories instead of treating them as schematic files", async () => {
  await withRoot(async (root) => {
    const pack = await createPack(root);
    await mkdir(path.join(pack, "not-a-file.schem"));
    await assert.rejects(resolveSchematicPath("pack1:not-a-file.schem", root), /not a regular file/);
    await assert.rejects(listSchematicEntries(root), /not a regular file/);
  });
});

test("pack listing returns pack, stable ID, and actual filename for indexed and directly indexed files", async () => {
  await withRoot(async (root) => {
    const first = await createPack(root, "pack1");
    const second = await createPack(root, "pack2");
    await writeFile(path.join(first, "01_exact_existing.schem"), "one");
    await writeIndex(first, { "01-01": "01_exact_existing.schem" });
    await writeFile(path.join(first, "unindexed.litematic"), "two");
    await writeFile(path.join(second, "09-02_indexed_name.schematic"), "three");

    assert.deepEqual(await listSchematicEntries(root), [
      { pack: "pack1", id: "01-01", group: "01", fileId: "01", filename: "01_exact_existing.schem" },
      { pack: "pack1", id: null, group: null, fileId: null, filename: "unindexed.litematic" },
      { pack: "pack2", id: "09-02", group: "09", fileId: "02", filename: "09-02_indexed_name.schematic" },
    ]);
  });
});

test("pack lookup rejects absolute, traversal, backslash, NUL, and unsupported selectors", async () => {
  await withRoot(async (root) => {
    await createPack(root);
    for (const selector of [
      "pack1:/tmp/outside.schem",
      "pack1:../outside.schem",
      "pack1:folder\\outside.schem",
      "pack1:bad\0name.schem",
      "pack1:notes.txt",
      "pack0:house.schem",
    ]) {
      await assert.rejects(resolveSchematicPath(selector, root), undefined, selector);
    }
  });
});

test("pack directories, manifest targets, and schematic files cannot escape via symlinks", async () => {
  await withRoot(async (root) => {
    const packs = path.join(root, "schems");
    const pack = await createPack(root);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "escape.schem"), "secret");
    await symlink(outside, path.join(packs, "pack2"), "dir");
    await symlink(path.join(outside, "escape.schem"), path.join(pack, "linked.schem"), "file");

    await assert.rejects(resolveSchematicPath("pack2:escape.schem", root), /outside the schems directory/);
    await assert.rejects(resolveSchematicPath("pack1:linked.schem", root), /No schematic named linked\.schem/);

    await writeIndex(pack, { "04-01": "../outside/escape.schem" });
    await assert.rejects(resolveSchematicPath("pack1:04-01", root), /filename without absolute paths, traversal/);
    await assert.rejects(listSchematicEntries(root), /filename without absolute paths, traversal/);
  });
});

test("legacy root-relative paths continue to resolve as before", async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, "legacy.schem"), "legacy");
    assert.equal(await resolveSchematicPath("legacy.schem", root), path.join(root, "legacy.schem"));
  });
});
