import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("schematic guide links and generated per-build selectors agree with structured mappings", async () => {
  const guide = await read("schematics/README.md");
  const rootReadme = await read("README.md");
  const prompts = await Promise.all([
    read("schematics/tooling/prompts/001-learn-mindcraft-bots-to-build-buildings-via-schemes.md"),
    read("schematics/tooling/prompts/002-4-create-schemas-from-pictures.md"),
    read("schematics/tooling/prompts/003-voxel-architect-mode-instructions.md"),
  ]);
  assert.match(rootReadme, /npm run test:schematic/);
  assert.ok(prompts.every((prompt) => /packN.*group.*id|pack.*group.*id/i.test(prompt)));
  assert.ok(prompts.every((prompt) => /trusted|sender/i.test(prompt)));
  assert.ok(prompts.every((prompt) => /file id.*id.*file name.*file/is.test(prompt)));
  for (const alias of ["schema", "schem", "scheme", "schematic"]) {
    assert.ok(prompts.every((prompt) => new RegExp(`\\b${alias}\\b`, "i").test(prompt)), `missing ${alias} in active prompts`);
  }
  assert.match(prompts[1], /python3 schematics\/tooling\/audit_batch\.py --pack <packN>/);
  assert.match(prompts[2], /npm run test:schematic/);
  for (const [, target] of guide.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    // Pack-specific evidence links are checked by the relevant scoped suite.
    if (/^(?:[a-z]+:|#)/i.test(target) || /(?:^|\/)pack[1-9][0-9]*(?:_originals)?(?:\/|#|$)/i.test(target)) continue;
    const localPath = target.replace(/:\d+(?:-\d+)?$/, "").split("#", 1)[0];
    if (!localPath) continue;
    assert.ok(await import("node:fs/promises").then(({ access }) => access(path.resolve(path.dirname(path.join(root, "schematics/README.md")), localPath)).then(() => true, () => false)),
      `broken guide link: ${target}`);
  }

  const generator = await read("schematics/tooling/audit_batch.py");
  assert.match(generator, /item\.get\("group"\)/);
  assert.match(generator, /item\.get\("id"\)/,
    "the audit generator must use the manifest's separate group and id fields");

  const generatorCheck = spawnSync("python3", ["-B", "-c", `
import sys
sys.path.insert(0, 'schematics/tooling')
import audit_batch
audit = {'builds': [{'blueprint': {'path': 'schematics/blueprints/pack3/garden.json'},
    'schematic': {'path': 'schematics/schems/pack3/garden.schem'},
    'group': 7, 'id': 4, 'dimensions': [2, 1, 1], 'folder': '07',
    'non_air_count': 2, 'title': 'Garden',
    'checks': {'production_reader': {'result': 'PASS', 'compared_voxels': 2},
               'binary': {'result': 'PASS'},
               'deterministic_regeneration': {'result': 'PASS', 'exit_code': 0}}}]}
print(audit_batch.make_rows(audit, 'pack3')[0])
`], { cwd: root, encoding: "utf8" });
  assert.equal(generatorCheck.status, 0, generatorCheck.stderr || generatorCheck.stdout);
  assert.match(generatorCheck.stdout, /!buildSchematic\("pack3:7:4"\)/);
});
