import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const loaderPath = fileURLToPath(new URL("./commands-loader.js", import.meta.url));

function runChecks() {
  const script = `
    globalThis.__testSettings = { allow_insecure_coding: false, trusted_command_senders: ['Builder'], known_bot_peers: ['Alice'], max_commands: -1, only_chat_with: [] };
    const { setSettings } = await import(${JSON.stringify(new URL("../../src/agent/settings.js", import.meta.url).href)});
    setSettings(globalThis.__testSettings);
    const convoManager = (await import(${JSON.stringify(new URL("../../src/agent/conversation.js", import.meta.url).href)})).default;
    convoManager.updateAgents([{ name: 'Alice', in_game: true }]);
    const { Agent } = await import(${JSON.stringify(new URL("../../src/agent/agent.js", import.meta.url).href)});
    const { getCommandDocs, commandExists, executeCommand } = await import(${JSON.stringify(new URL("../../src/agent/commands/index.js", import.meta.url).href)});
    const { parseAddressedSchematicRequest, parseAddressedChatCommand, dispatchAddressedSchematicRequest, redactCommandFragments } = await import(${JSON.stringify(new URL("../../src/agent/schematic_request.js", import.meta.url).href)});
    const settings = globalThis.__testSettings;
    const results = { actions: [], routes: [], prompts: 0 };
    globalThis.__schematicBuild = async (...args) => { results.actions.push(args); return true; };
    const agent = Object.create(Agent.prototype);
    agent.name = 'Andy';
    agent.blocked_actions = [];
    agent.bot = { output: '', interrupt_code: false, emit() {}, modes: { flushBehaviorLog: () => '' } };
    agent.actions = { runAction: async (_name, fn) => { await fn(); return { message: 'build complete', interrupted: false, timedout: false }; } };
    const historyMessages = [];
    agent.history = { add: (...args) => historyMessages.push(args), save() {}, getHistory: () => [] };
    agent.prompter = { promptConvo: async () => { results.prompts++; return 'No command.'; } };
    agent.coder = { generateCode: async () => 'generated test action' };
    const userCommandLifecycle = [];
    agent.self_prompter = { shouldInterrupt: () => false, isActive: () => false, handleUserPromptedCmd: (...args) => userCommandLifecycle.push(args) };
    agent.shut_up = false;
    agent.routeResponse = async (_to, message) => { results.routes.push(message); };
    agent.clearBotLogs = () => {};
    agent.checkTaskDone = async () => {};
    agent.task = { data: null };

    const incident = await agent.handleMessage('Builder', 'Andy build 01 from group 02 of pack1');
    results.incident = incident;
    results.incidentActions = results.actions.length;
    results.incidentSelector = globalThis.__buildSchematicArgs?.[1];
    results.incidentPrompts = results.prompts;
    results.incidentLifecycle = userCommandLifecycle[0];

    results.addressedOther = await agent.handleMessage('Builder', 'Alice build 01 from group 02 of pack1');
    results.otherAddressActionCount = results.actions.length;
    results.otherAddressPromptCount = results.prompts;
    await agent.handleMessage('Builder', 'Alice !buildSchematic("pack1:02:01")');
    results.otherAddressDirectActionCount = results.actions.length;
    results.addressedCommandParse = parseAddressedChatCommand('Alice !newAction("ignore")', 'Andy', ['Alice']);

    const beforeAliceFragment = results.actions.length;
    const screenshotFragment = ('!newAction ' + 'Alice public output '.repeat(20)).slice(0, 256);
    await agent.handleMessage('Alice', screenshotFragment);
    results.aliceFragmentLength = screenshotFragment.length;
    results.aliceFragmentActionCount = results.actions.length - beforeAliceFragment;
    results.aliceFragmentWasRedacted = historyMessages.some(([, text]) => String(text).includes('[command fragment omitted from peer message]'))
      && !historyMessages.some(([, text]) => String(text).includes('!newAction was given 0 args'));
    results.aliceFragmentPrompts = results.prompts;

    const beforeUntrusted = results.actions.length;
    await agent.handleMessage('Mallory', '!buildSchematic("pack1:02:01")');
    results.untrustedActionCount = results.actions.length - beforeUntrusted;
    results.untrustedNotice = results.routes.at(-1);

    const beforeUnknown = results.actions.length;
    await agent.handleMessage('Builder', 'Andy build id 99 from group 99 of pack1');
    results.missingSelectorActionCount = results.actions.length - beforeUnknown;
    results.missingSelectorPrompts = results.prompts;
    results.missingSelectorNotice = results.routes.at(-1);

    const beforeMalformed = results.actions.length;
    await agent.handleMessage('Builder', 'Andy build from group 02 of pack1');
    results.malformedActionCount = results.actions.length - beforeMalformed;
    results.malformedPromptCount = results.prompts;

    const beforeAmbiguous = results.actions.length;
    await agent.handleMessage('Builder', 'Andy build id 01 from group 02 and group 03 of pack1');
    results.ambiguousActionCount = results.actions.length - beforeAmbiguous;
    results.ambiguousNotice = results.routes.at(-1);

    const beforeEmbedded = results.actions.length;
    await agent.handleMessage('Builder', '!buildSchematic("pack1:02:01") trailing text');
    results.embeddedActionCount = results.actions.length - beforeEmbedded;
    results.embeddedNotice = results.routes.at(-1);

    const malformed = parseAddressedSchematicRequest('Andy build 01 from group two of pack1', 'Andy', ['Alice']);
    const ambiguous = parseAddressedSchematicRequest('Andy build 01 from group 02 of pack1 and group 03', 'Andy', ['Alice']);
    results.malformedError = malformed?.error;
    results.ambiguousError = ambiguous?.error;
    results.unaddressed = parseAddressedSchematicRequest('build 01 from group 02 of pack1', 'Andy', ['Alice']);
    results.unrelated = parseAddressedSchematicRequest('Andy, can you build a house?', 'Andy', ['Alice']);
    results.publicRedaction = redactCommandFragments('Andy used !buildSchematic("pack1:02:01")');

    results.disabledCommandExists = commandExists('!newAction');
    results.disabledCommandDocs = getCommandDocs({ blocked_actions: [] }).includes('!newAction');
    results.disabledForcedResult = await executeCommand(agent, '!newAction("test")');
    settings.allow_insecure_coding = true;
    results.enabledCommandExists = commandExists('!newAction');
    results.enabledCommandDocs = getCommandDocs({ blocked_actions: [] }).includes('!newAction');
    results.enabledForcedResult = await executeCommand(agent, '!newAction("test")');
    settings.allow_insecure_coding = false;

    const directBefore = results.actions.length;
    await agent.handleMessage('Builder', '!buildSchematic("pack1:02:01")');
    results.directActionCount = results.actions.length - directBefore;
    results.directSelector = globalThis.__buildSchematicArgs?.[1];
    console.log(JSON.stringify(results));
  `;
  return spawnSync(process.execPath, ["--experimental-loader", loaderPath, "--input-type=module", "-e", script], { encoding: "utf8" });
}

test("schematic incident routes deterministically and keeps peer/user commands separated", () => {
  const child = runChecks();
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
  assert.equal(result.incident, true);
  assert.equal(result.incidentActions, 1);
  assert.equal(result.incidentSelector, "pack1:02:01");
  assert.equal(result.incidentPrompts, 0);
  assert.deepEqual(result.incidentLifecycle, [false, true]);
  assert.equal(result.addressedOther, true);
  assert.equal(result.otherAddressActionCount, 1);
  assert.equal(result.otherAddressPromptCount, 0);
  assert.equal(result.otherAddressDirectActionCount, 1);
  assert.equal(result.addressedCommandParse.addressedTo, 'Alice');
  assert.equal(result.aliceFragmentActionCount, 0);
  assert.equal(result.aliceFragmentLength, 256);
  assert.ok(result.aliceFragmentPrompts > 0);
  assert.equal(result.aliceFragmentWasRedacted, true);
  assert.equal(result.untrustedActionCount, 0);
  assert.match(result.untrustedNotice, /trusted command senders/i);
  assert.equal(result.missingSelectorActionCount, 0);
  assert.match(result.missingSelectorNotice, /could not be resolved/i);
  assert.equal(result.malformedActionCount, 0);
  assert.equal(result.malformedPromptCount, result.missingSelectorPrompts);
  assert.equal(result.ambiguousActionCount, 0);
  assert.match(result.ambiguousNotice, /exactly one numeric group/i);
  assert.equal(result.embeddedActionCount, 0);
  assert.match(result.embeddedNotice, /fragments embedded in chat/i);
  assert.match(result.malformedError, /numeric group/i);
  assert.match(result.ambiguousError, /exactly one numeric group/i);
  assert.equal(result.unaddressed, null);
  assert.equal(result.unrelated, null);
  assert.doesNotMatch(result.publicRedaction, /!buildSchematic/);
  assert.equal(result.disabledCommandExists, false);
  assert.equal(result.disabledCommandDocs, false);
  assert.match(result.disabledForcedResult, /not an available command/i);
  assert.equal(result.enabledCommandExists, true);
  assert.equal(result.enabledCommandDocs, true);
  assert.equal(result.enabledForcedResult, 'generated test action');
  assert.equal(result.directActionCount, 1);
  assert.equal(result.directSelector, "pack1:02:01");
});
