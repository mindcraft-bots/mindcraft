import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const loaderPath = fileURLToPath(new URL("./commands-loader.js", import.meta.url));

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function readBytes(relativePath) {
  return readFile(path.join(root, relativePath));
}

function runDocumentedSelectorChecks() {
  const script = `
    import { parseAddressedSchematicRequest } from ${JSON.stringify(new URL("../../src/agent/schematic_request.js", import.meta.url).href)};
    import { parseCommandMessage } from ${JSON.stringify(new URL("../../src/agent/commands/index.js", import.meta.url).href)};
    import { resolveSchematicPath } from ${JSON.stringify(new URL("../../src/utils/schematic/paths.js", import.meta.url).href)};
    const human = [
      'Andy build id 01 from group 02 of pack1',
      'Andy build a balloon using schematic file id 01 from group 02 of pack1',
      'Andy build file id 01 from group 02 of pack1',
      'Andy build 01 from group 02 of pack1',
      'Andy build offset 1 from group 2 of pack1',
      'Andy build file name 02_bee_hot_air_balloon of pack1',
      'Andy build file 02_bee_hot_air_balloon of pack1',
      'Andy build file pack1/02_bee_hot_air_balloon',
      'Andy build house via scheme 02_bee_hot_air_balloon of pack1',
      'Andy build schema pack1/02_bee_hot_air_balloon',
      'Andy build schem 02_bee_hot_air_balloon of pack1',
      'Andy build schematic pack1/02_bee_hot_air_balloon.schem',
      'Andy build schema file name 02_bee_hot_air_balloon of pack1',
      'Andy build schem file 02_bee_hot_air_balloon of pack1',
      'Andy build scheme file name 02_bee_hot_air_balloon of pack1',
      'Andy build file 02_bee_hot_air_balloon.schem of pack1',
      'Andy build a "file group pack1" cottage via file 02_bee_hot_air_balloon of pack1!',
      'Andy build a cozy cottage using id 1 from group 2 of pack1.',
    ].map(message => parseAddressedSchematicRequest(message, 'Andy', ['Alice']));
    const invalidEscape = parseAddressedSchematicRequest('Andy build "cottage \\\\q" using file 02_bee_hot_air_balloon of pack1', 'Andy', ['Alice']);
    const slash = String.fromCharCode(92);
    const validEscape = parseAddressedSchematicRequest('Andy build "quoted ' + slash + '"file' + slash.repeat(2) + 'name" using file 02_bee_hot_air_balloon of pack1', 'Andy', ['Alice']);
    const scripts = [
      '!buildSchematic("pack1:02:01")',
      '!buildSchematic("pack1:02_bee_hot_air_balloon")',
      '!buildSchematic("schems/pack1/02_bee_hot_air_balloon.schem")',
      '!buildSchematic("pack1:02:01", 100, 64, -20)',
    ].map(parseCommandMessage);
    const resolved = [];
    for (const request of human) {
      if (!request || request.error) throw new Error(JSON.stringify(request));
      resolved.push(await resolveSchematicPath(request.selector));
    }
    for (const command of scripts) {
      if (typeof command !== 'object' || !command.args) throw new Error(JSON.stringify(command));
      resolved.push(await resolveSchematicPath(command.args[0]));
    }
    console.log(JSON.stringify({ human, invalidEscape, validEscape, scripts, resolved }));
  `;
  return spawnSync(process.execPath, [
    "--experimental-loader", loaderPath,
    "--input-type=module", "-e", script,
  ], { cwd: root, encoding: "utf8" });
}

test("documented human and script selectors resolve through the real parsers", async () => {
  const result = runDocumentedSelectorChecks();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const data = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.deepEqual(data.human.map(({ selector }) => selector), [
    "pack1:2:1",
    "pack1:2:1",
    "pack1:2:1",
    "pack1:2:1",
    "pack1:2:1",
    "pack1:02_bee_hot_air_balloon",
    "pack1:02_bee_hot_air_balloon",
    "pack1:02_bee_hot_air_balloon",
    "pack1:02_bee_hot_air_balloon",
    "pack1:02_bee_hot_air_balloon",
    "pack1:02_bee_hot_air_balloon",
    "pack1:02_bee_hot_air_balloon.schem",
    "pack1:02_bee_hot_air_balloon",
    "pack1:02_bee_hot_air_balloon",
    "pack1:02_bee_hot_air_balloon",
    "pack1:02_bee_hot_air_balloon.schem",
    "pack1:02_bee_hot_air_balloon",
    "pack1:2:1",
  ]);
  assert.ok(data.invalidEscape.error, "unsupported quoted escapes must fail safely");
  assert.equal(data.validEscape.selector, "pack1:02_bee_hot_air_balloon");
  assert.deepEqual(data.scripts.map(({ args }) => args[0]), [
    "pack1:02:01",
    "pack1:02_bee_hot_air_balloon",
    "schems/pack1/02_bee_hot_air_balloon.schem",
    "pack1:02:01",
  ]);
  assert.equal(data.human[1].fileId, 1);
  assert.equal(data.human[2].fileId, 1);
  assert.equal(data.human[5].fileName, "02_bee_hot_air_balloon");
  assert.equal(data.resolved.length, data.human.length + data.scripts.length);
  assert.ok(data.resolved.every((resolved) => resolved.endsWith(".schem")));
});

test("schematic guide links and generated per-build selectors agree with structured mappings", async () => {
  const guide = await read("schematics/README.md");
  const rootReadme = await read("README.md");
  const prompts = await Promise.all([
    read("schematics/tooling/prompts/001-learn-mindcraft-bots-to-build-buildings-via-schemes.md"),
    read("schematics/tooling/prompts/002-4-create-schemas-from-pictures.md"),
    read("schematics/tooling/prompts/003-voxel-architect-mode-instructions.md"),
  ]);
  assert.match(rootReadme, /npm run test:schematic/);
  assert.match(rootReadme, /python3 schematics\/tooling\/audit_batch\.py --pack pack1/);
  assert.match(rootReadme, /schematics\/tooling\/validation\/pack1\/batch_validation\.json/);
  assert.ok(prompts.every((prompt) => /packN.*group.*id|pack.*group.*id/i.test(prompt)));
  assert.ok(prompts.every((prompt) => /trusted|sender/i.test(prompt)));
  assert.ok(prompts.every((prompt) => /file id.*id.*file name.*file/is.test(prompt)));
  for (const alias of ["schema", "schem", "scheme", "schematic"]) {
    assert.ok(prompts.every((prompt) => new RegExp(`\\b${alias}\\b`, "i").test(prompt)), `missing ${alias} in active prompts`);
  }
  assert.match(prompts[1], /python3 schematics\/tooling\/audit_batch\.py --pack <packN>/);
  assert.match(prompts[2], /npm run test:schematic/);
  for (const [, target] of guide.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^(?:[a-z]+:|#)/i.test(target)) continue;
    const localPath = target.replace(/:\d+(?:-\d+)?$/, "").split("#", 1)[0];
    if (!localPath) continue;
    assert.ok(await import("node:fs/promises").then(({ access }) => access(path.resolve(path.dirname(path.join(root, "schematics/README.md")), localPath)).then(() => true, () => false)),
      `broken guide link: ${target}`);
  }

  const manifest = JSON.parse(await read("schematics/schems/pack1/index.json"));
  assert.equal(manifest.schemaVersion, 2);
  const mappings = Object.entries(manifest.groups).flatMap(([group, ids]) =>
    Object.entries(ids).map(([id, filename]) => ({ group: Number(group), id: Number(id), filename })));
  assert.equal(mappings.length, 30, "all thirty preserved index mappings must remain present");
  assert.ok(mappings.every(({ group, id, filename }) => Number.isSafeInteger(group) && group > 0
    && Number.isSafeInteger(id) && id > 0 && typeof filename === "string" && filename.endsWith(".schem")));
  const tuples = mappings.map(({ group, id }) => `pack1:${group}:${id}`);
  const report = await read("schematics/schems/pack1/batch_report.md");
  const generated = report.split("<!-- BEGIN GENERATED BATCH AUDIT -->")[1].split("<!-- END GENERATED BATCH AUDIT -->")[0];
  const selectors = [...generated.matchAll(/!buildSchematic\("(pack1:[0-9]+:[0-9]+)"\)/g)].map((match) => match[1]);
  const expected = tuples.sort();
  assert.equal(selectors.length, 30, "the generated audit must include all 30 per-build command references");
  assert.deepEqual([...selectors].sort(), expected);

  const validation = JSON.parse(await read("schematics/tooling/validation/pack1/batch_validation.json"));
  assert.equal(validation.schema_version, 2);
  assert.equal(validation.pack_index_schema_version, 2);
  assert.equal(validation.builds.length, 30, "the regenerated machine report must cover all thirty assets");
  assert.deepEqual(validation.builds.map(({ group, id, schematic }) => ({ group, id, filename: path.basename(schematic.path) }))
    .sort((left, right) => left.group - right.group || left.id - right.id),
  [...mappings].sort((left, right) => left.group - right.group || left.id - right.id));
  for (const { group, id, filename } of mappings) {
    const build = validation.builds.find((candidate) => candidate.group === group && candidate.id === id);
    assert.ok(build, `missing generated build record for ${group}:${id}`);
    assert.equal(path.basename(build.schematic.path), filename, `manifest target changed for ${group}:${id}`);
    const actualSha256 = createHash("sha256").update(await readBytes(build.schematic.path)).digest("hex");
    assert.equal(actualSha256, build.schematic.sha256, `schematic asset hash changed for ${filename}`);
  }

  const historicalAudit = JSON.parse(await read("schematics/tooling/validation/pack1/integration_other_pack_audit.json"));
  assert.match(historicalAudit.metadata_migration, /metadata-only conversion/i);
  assert.equal(historicalAudit.audit.builds[0].group, 1);
  assert.equal(historicalAudit.audit.builds[0].id, 1);

  const generator = await read("schematics/tooling/audit_batch.py");
  assert.match(generator, /item\.get\("group"\)/);
  assert.match(generator, /item\.get\("id"\)/,
    "the audit generator must use the manifest's separate group and id fields");

  const generatorCheck = spawnSync("python3", ["-B", "-c", `
import sys
sys.path.insert(0, 'schematics/tooling')
import audit_batch
audit = {'builds': [{'blueprint': {'path': 'schematics/blueprints/pack1/02_bee_hot_air_balloon.json'},
    'schematic': {'path': 'schematics/schems/pack1/02_bee_hot_air_balloon.schem'},
    'group': 2, 'id': 1, 'dimensions': [10, 17, 9], 'folder': '02',
    'non_air_count': 440, 'title': 'Bee balloon',
    'checks': {'production_reader': {'result': 'PASS', 'compared_voxels': 1530},
               'binary': {'result': 'PASS'},
               'deterministic_regeneration': {'result': 'PASS', 'exit_code': 0}}}]}
print(audit_batch.make_rows(audit, 'pack1')[0])
`], { cwd: root, encoding: "utf8" });
  assert.equal(generatorCheck.status, 0, generatorCheck.stderr || generatorCheck.stdout);
  assert.match(generatorCheck.stdout, /!buildSchematic\("pack1:2:1"\)/);
});
