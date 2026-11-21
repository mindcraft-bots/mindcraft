import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const loaderPath = fileURLToPath(new URL("./commands-loader.js", import.meta.url));

function runCommandChecks() {
  const script = `
    import { executeCommand, getCommandDocs, isAction, parseCommandMessage } from ${JSON.stringify(new URL("../../src/agent/commands/index.js", import.meta.url).href)};
    const results = {};
    results.existingValid = parseCommandMessage('!goToPlayer("Alex", 2)');
    results.existingMissing = parseCommandMessage('!goToPlayer("Alex")');
    results.existingExtra = parseCommandMessage('!goToPlayer("Alex", 2, 3)');
    results.stayExponent = parseCommandMessage('!stay(1e2)');
    results.stayNegativeExponent = parseCommandMessage('!stay(1e-2)');
    results.stayDecimal = parseCommandMessage('!stay(1.5)');
    results.buildNear = parseCommandMessage('!buildSchematic("house.schem")');
    results.buildIndexedSelector = parseCommandMessage('!buildSchematic("pack1:02:01")');
    results.buildIndexedSelectorUnpadded = parseCommandMessage('!buildSchematic("pack1:2:1")');
    results.buildPackBeeFilename = parseCommandMessage('!buildSchematic("pack1:02_bee_hot_air_balloon")');
    results.buildPackFilename = parseCommandMessage('!buildSchematic("pack1:01_wardrobe_nether_portal")');
    results.buildNulls = parseCommandMessage('!buildSchematic("house.schem", null, null, null)');
    results.buildCoordinates = parseCommandMessage('!buildSchematic("house.schem", -1.25, 64, "2e1")');
    results.buildExponents = parseCommandMessage('!buildSchematic("house.schem", 1e2, -2.5e-1, 3E+1)');
    results.buildQuotedExponents = parseCommandMessage('!buildSchematic("house.schem", "1e2", "-2.5e-1", "3E+1")');
    results.buildPartial = parseCommandMessage('!buildSchematic("house.schem", 1)');
    results.buildBadCoordinate = parseCommandMessage('!buildSchematic("house.schem", "12junk", 64, 2)');
    results.buildNonFinite = parseCommandMessage('!buildSchematic("house.schem", "1e999", 64, 2)');
    results.docs = getCommandDocs({ blocked_actions: [] });
    const { getCommand: getQueryCommand } = await import(${JSON.stringify(new URL("../../src/agent/commands/index.js", import.meta.url).href)});
    results.listSchematicsRegistered = Boolean(getQueryCommand('!listSchematics'));
    const listCommand = getQueryCommand('!listSchematics');
    results.listSchematicsIsAction = isAction('!listSchematics');
    globalThis.__schematicListSchematics = async () => ['zeta.schem', 'alpha.schematic', 'house.litematic'];
    results.listPopulated = await listCommand.perform({});
    globalThis.__schematicListSchematicEntries = async () => [{ pack: 'pack1', group: 1, fileId: 1, fileName: '01_wardrobe_nether_portal.schem', id: 1, filename: '01_wardrobe_nether_portal.schem' }];
    results.listPackEntry = await listCommand.perform({});
    globalThis.__schematicListSchematics = async () => [];
    globalThis.__schematicListSchematicEntries = undefined;
    results.listEmpty = await listCommand.perform({});
    globalThis.__schematicListSchematics = async () => { throw new Error('EACCES: permission denied'); };
    results.listError = await listCommand.perform({});
    const calls = [];
    const agent = { bot: {}, actions: { runAction: async (name, fn, options) => { calls.push({ name, options }); await fn(); return { message: 'wrapped' }; } } };
    results.executionResult = await executeCommand(agent, '!buildSchematic("house.schem", null, null, null)');
    results.executionArgs = globalThis.__buildSchematicArgs;
    results.executionPackResult = await executeCommand(agent, '!buildSchematic("pack1:01_wardrobe_nether_portal", null, null, null)');
    results.executionPackArgs = globalThis.__buildSchematicArgs;
    results.executionIndexedResult = await executeCommand(agent, '!buildSchematic("pack1:02:01", null, null, null)');
    results.executionIndexedArgs = globalThis.__buildSchematicArgs;
    results.invalidExecutionResult = await executeCommand(agent, '!buildSchematic("house.schem", "12junk", 64, 2)');
    results.actionCalls = calls;
    console.log(JSON.stringify(results));
  `;
  return spawnSync(process.execPath, [
    "--experimental-loader", loaderPath,
    "--input-type=module",
    "-e", script,
  ], { encoding: "utf8" });
}

test("command parser preserves fixed arity and supports build schematic coordinates", () => {
  const child = runCommandChecks();
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const results = JSON.parse(child.stdout.trim().split("\n").at(-1));

  assert.deepEqual(results.existingValid.args, ["Alex", 2]);
  assert.match(results.existingMissing, /given 1 args, but requires 2 args/);
  assert.match(results.existingExtra, /given 3 args, but requires 2 args/);
  assert.match(results.stayExponent, /given 0 args, but requires 1 args/);
  assert.match(results.stayNegativeExponent, /given 0 args, but requires 1 args/);
  assert.deepEqual(results.stayDecimal.args, [1]);

  assert.deepEqual(results.buildNear.args, ["house.schem", null, null, null]);
  assert.deepEqual(results.buildIndexedSelector.args, ["pack1:02:01", null, null, null]);
  assert.deepEqual(results.buildIndexedSelectorUnpadded.args, ["pack1:2:1", null, null, null]);
  assert.deepEqual(results.buildPackBeeFilename.args, ["pack1:02_bee_hot_air_balloon", null, null, null]);
  assert.deepEqual(results.buildPackFilename.args, ["pack1:01_wardrobe_nether_portal", null, null, null]);
  assert.deepEqual(results.buildNulls.args, ["house.schem", null, null, null]);
  assert.deepEqual(results.buildCoordinates.args, ["house.schem", -1.25, 64, 20]);
  assert.deepEqual(results.buildExponents.args, ["house.schem", 100, -0.25, 30]);
  assert.deepEqual(results.buildQuotedExponents.args, ["house.schem", 100, -0.25, 30]);
  assert.match(results.buildPartial, /must be provided together/);
  assert.match(results.buildBadCoordinate, /finite number or null/);
  assert.match(results.buildNonFinite, /finite number or null/);

  assert.match(results.docs, /!buildSchematic: Build a conventional schematic by file name or by pack/);
  assert.match(results.docs, /!listSchematics: List supported schematic files/);
  assert.equal(results.listSchematicsRegistered, true);
  assert.equal(results.listSchematicsIsAction, false);
  assert.ok(results.listPopulated.indexOf('- legacy | group — | file id — | file name alpha.schematic') < results.listPopulated.indexOf('- legacy | group — | file id — | file name house.litematic'));
  assert.ok(results.listPopulated.indexOf('- legacy | group — | file id — | file name house.litematic') < results.listPopulated.indexOf('- legacy | group — | file id — | file name zeta.schem'));
  assert.match(results.listPackEntry, /- pack1 \| group 1 \| file id 1 \| file name 01_wardrobe_nether_portal\.schem/);
  assert.match(results.docs, /packN:<group>:<fileId>/);
  assert.match(results.docs, /file IDs are explicit index mappings, not sorted filename positions/i);
  assert.match(results.docs, /Andy build file id 01 from group 02 of pack1/i);
  assert.match(results.docs, /pack1:02:01/);
  assert.match(results.docs, /schema pack1\/02_bee_hot_air_balloon/i);
  assert.match(results.listEmpty, /No schematic files found/);
  assert.match(results.listEmpty, /Add a \.schem, \.schematic, or \.litematic file/);
  assert.match(results.listError, /Unable to list schematics because of a filesystem error: EACCES: permission denied/);
  assert.match(results.docs, /x: \(number or null\) \(optional\)/);
  assert.equal(results.executionResult, "wrapped");
  assert.equal(results.executionPackResult, "wrapped");
  assert.equal(results.executionIndexedResult, "wrapped");
  assert.match(results.invalidExecutionResult, /finite number or null/);
  assert.deepEqual(results.executionArgs, [{}, "house.schem", null, null, null]);
  assert.deepEqual(results.executionPackArgs, [{}, "pack1:01_wardrobe_nether_portal", null, null, null]);
  assert.deepEqual(results.executionIndexedArgs, [{}, "pack1:02:01", null, null, null]);
  assert.deepEqual(results.actionCalls, [
    { name: "action:buildSchematic", options: { timeout: -1, resume: false } },
    { name: "action:buildSchematic", options: { timeout: -1, resume: false } },
    { name: "action:buildSchematic", options: { timeout: -1, resume: false } },
  ]);
});
