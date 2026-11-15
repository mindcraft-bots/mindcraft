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
    globalThis.__schematicListSchematics = async () => [];
    results.listEmpty = await listCommand.perform({});
    globalThis.__schematicListSchematics = async () => { throw new Error('EACCES: permission denied'); };
    results.listError = await listCommand.perform({});
    const calls = [];
    const agent = { bot: {}, actions: { runAction: async (name, fn, options) => { calls.push({ name, options }); await fn(); return { message: 'wrapped' }; } } };
    results.executionResult = await executeCommand(agent, '!buildSchematic("house.schem", null, null, null)');
    results.invalidExecutionResult = await executeCommand(agent, '!buildSchematic("house.schem", "12junk", 64, 2)');
    results.executionArgs = globalThis.__buildSchematicArgs;
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
  assert.deepEqual(results.buildNulls.args, ["house.schem", null, null, null]);
  assert.deepEqual(results.buildCoordinates.args, ["house.schem", -1.25, 64, 20]);
  assert.deepEqual(results.buildExponents.args, ["house.schem", 100, -0.25, 30]);
  assert.deepEqual(results.buildQuotedExponents.args, ["house.schem", 100, -0.25, 30]);
  assert.match(results.buildPartial, /must be provided together/);
  assert.match(results.buildBadCoordinate, /finite number or null/);
  assert.match(results.buildNonFinite, /finite number or null/);

  assert.match(results.docs, /!buildSchematic: Build a schematic file from the schematics folder/);
  assert.match(results.docs, /!listSchematics: List supported schematic files in the schematics folder/);
  assert.equal(results.listSchematicsRegistered, true);
  assert.equal(results.listSchematicsIsAction, false);
  assert.ok(results.listPopulated.indexOf('- alpha.schematic') < results.listPopulated.indexOf('- house.litematic'));
  assert.ok(results.listPopulated.indexOf('- house.litematic') < results.listPopulated.indexOf('- zeta.schem'));
  assert.match(results.listEmpty, /No schematic files found/);
  assert.match(results.listEmpty, /Add a \.schem, \.schematic, or \.litematic file/);
  assert.match(results.listError, /Unable to list schematics because of a filesystem error: EACCES: permission denied/);
  assert.match(results.docs, /x: \(number or null\) \(optional\)/);
  assert.equal(results.executionResult, "wrapped");
  assert.match(results.invalidExecutionResult, /finite number or null/);
  assert.deepEqual(results.executionArgs, [{}, "house.schem", null, null, null]);
  assert.deepEqual(results.actionCalls, [{ name: "action:buildSchematic", options: { timeout: -1, resume: false } }]);
});
