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
    const { resolveSchematicPath } = await import(${JSON.stringify(new URL("../../src/utils/schematic/paths.js", import.meta.url).href)});
    const settings = globalThis.__testSettings;
    const results = { actions: [], routes: [], prompts: 0 };
    globalThis.__schematicBuild = async (...args) => { results.actions.push(args); return true; };
    const agent = Object.create(Agent.prototype);
    agent.name = 'Andy';
    agent.blocked_actions = [];
    agent.bot = { version: '1.21.4', output: '', interrupt_code: false, emit() {}, modes: { flushBehaviorLog: () => '' } };
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

    const fileStem = 'Andy build file 02_bee_hot_air_balloon of pack1';
    const filePath = 'Andy build file pack1/02_bee_hot_air_balloon';
    const fileWithExtension = 'Andy build file 02_bee_hot_air_balloon.schem of pack1';
    const filePathWithExtension = 'Andy build file pack1/02_bee_hot_air_balloon.schem';
    results.filenameParses = [fileStem, filePath, fileWithExtension, filePathWithExtension].map(text => parseAddressedSchematicRequest(text, 'Andy', ['Alice']));
    results.filenamePunctuation = parseAddressedSchematicRequest(fileStem + '.', 'Andy', ['Alice']);
    results.naturalExamples = [
      'Andy build amazing house using file 02_bee_hot_air_balloon of pack1',
      'Andy build house via file pack1/02_bee_hot_air_balloon',
      'Andy build thing using offset 01 from group 02 of pack1',
      'Andy build amazing house id 01 from group 02 of pack1',
      'Andy build ID 02 from group 02 of PACK1',
      'Andy build 02 from group 02 of pack1',
      'Andy, could you please build the finest bee balloon using file 02_bee_hot_air_balloon.schem of PACK1',
      'Andy build "id and file group pack1" house id 01 from group 02 of pack1',
    ].map(text => parseAddressedSchematicRequest(text, 'Andy', ['Alice']));
    results.otherSupportedExtensions = ['schematic', 'litematic'].map(extension =>
      parseAddressedSchematicRequest('Andy build file example.' + extension + ' of pack1', 'Andy', ['Alice']));
    results.actualPackFilenameResolve = await resolveSchematicPath('pack1:02_bee_hot_air_balloon.schem');
    results.actualPackStemResolve = await resolveSchematicPath('pack1:02_bee_hot_air_balloon');
    results.knownMappedIdResolve = await resolveSchematicPath('pack1:2:2');
    const filenameBefore = results.actions.length;
    for (const text of [fileStem, filePath, fileWithExtension, filePathWithExtension]) {
      await agent.handleMessage('Builder', text);
      results.filenameSelectors = [...(results.filenameSelectors || []), globalThis.__buildSchematicArgs?.[1]];
    }
    results.filenameActionCount = results.actions.length - filenameBefore;
    results.filenamePrompts = results.prompts;
    results.filenameLifecycle = userCommandLifecycle.slice(1, 5);

    await agent.handleMessage('Builder', 'Andy build id 1 from group 2 of pack1');
    results.explicitIdSelector = globalThis.__buildSchematicArgs?.[1];

    const naturalActionStart = results.actions.length;
    for (const text of [
      'Andy build amazing house using file 02_bee_hot_air_balloon of pack1',
      'Andy build house via file pack1/02_bee_hot_air_balloon',
      'Andy build thing using offset 01 from group 02 of pack1',
      'Andy build amazing house id 01 from group 02 of pack1',
      'Andy build ID 02 from group 02 of PACK1',
      'Andy build 02 from group 02 of pack1',
      'Andy build offset 02 from group 02 of pack1',
    ]) {
      await agent.handleMessage('Builder', text);
    }
    results.naturalActionDelta = results.actions.length - naturalActionStart;
    results.naturalSelectors = results.actions.slice(naturalActionStart).map(args => args[1]);

    const beforeUnrelated = results.prompts;
    await agent.handleMessage('Builder', 'Andy could you build a house?');
    results.unrelatedPromptDelta = results.prompts - beforeUnrelated;
    const beforeOtherBot = results.actions.length;
    await agent.handleMessage('Builder', 'Alice build file pack1/02_bee_hot_air_balloon');
    results.otherBotFilenameActionDelta = results.actions.length - beforeOtherBot;

    const beforeBadName = results.actions.length;
    const promptsBeforeBadName = results.prompts;
    await agent.handleMessage('Builder', 'Andy build file pack1/../outside.schem');
    results.traversalActionDelta = results.actions.length - beforeBadName;
    results.traversalPromptDelta = results.prompts - promptsBeforeBadName;
    results.traversalNotice = results.routes.at(-1);
    const promptsBeforeMissingFilenameArgs = results.prompts;
    await agent.handleMessage('Builder', 'Andy build file');
    results.missingFilenameArgsPromptDelta = results.prompts - promptsBeforeMissingFilenameArgs;
    results.missingFilenameArgsNotice = results.routes.at(-1);
    const promptsBeforeCoordinates = results.prompts;
    await agent.handleMessage('Builder', 'Andy build file 02_bee_hot_air_balloon of pack1 at 1 2 3');
    results.filenameCoordinatesPromptDelta = results.prompts - promptsBeforeCoordinates;
    results.filenameCoordinatesNotice = results.routes.at(-1);
    const beforeUnknownName = results.actions.length;
    await agent.handleMessage('Builder', 'Andy build file 99_not_a_real_schematic of pack1');
    results.unknownFilenameActionDelta = results.actions.length - beforeUnknownName;
    results.unknownFilenameNotice = results.routes.at(-1);

    const beforeUntrustedFilename = results.actions.length;
    await agent.handleMessage('Mallory', 'Andy build file pack1/02_bee_hot_air_balloon');
    results.untrustedFilenameActionDelta = results.actions.length - beforeUntrustedFilename;
    results.untrustedFilenameNotice = results.routes.at(-1);

    const beforeBlacklisted = results.actions.length;
    agent.blocked_actions = ['!buildSchematic'];
    await agent.handleMessage('Builder', fileStem);
    results.blacklistedActionDelta = results.actions.length - beforeBlacklisted;
    results.blacklistedNotice = results.routes.at(-1);
    agent.blocked_actions = [];

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

    const failClosedInputs = [
      'Andy build file bee.schem',
      'Andy build file missing',
      'Andy build a balloon file missing',
      'Andy build a balloon file bee.schem',
      'Andy build a balloon using file bee.schem',
      'Andy build id nope',
      'Andy build a balloon using id nope',
      'Andy build offset nope',
      'Andy build id nope id 01 from group 02 of pack1',
      'Andy build offset nope file 02_bee_hot_air_balloon of pack1',
      'Andy build file missing id 01 from group 02 of pack1',
      'Andy build file #01 from group 02 of pack1',
      'Andy build file 01 from group 02 of pack1',
      'Andy build id 01 from group 02 of pack1 and id 02 from group 02 of pack1',
      'Andy build id 01 from group 02 of pack1 and pack2',
      'Andy build id 01 from group 02 of pack1 group 03',
      'Andy build id 01 from group 02 of pack1 then build a tower',
      'Andy build id 01 from group 02 of pack1; !stop()',
      'Andy build id 0 from group 02 of pack1',
      'Andy build id 01 from group 0 of pack1',
      'Andy build id 999999999999999999999 from group 02 of pack1',
      'Andy build schematic file id 01 from group 02 of pack1 and schema file id 01 from group 02 of pack1',
      'Andy build schema pack1/../secret.schem',
      'Andy build scheme file id 999999999999999999999 from group 02 of pack1',
      'Andy build schem file name 02_bee_hot_air_balloon of pack1 then build a tower',
      'Andy build a cottage schema file',
      'Andy build a cottage via scheme pack1',
    ];
    const failClosedActionStart = results.actions.length;
    const failClosedPromptStart = results.prompts;
    for (const text of failClosedInputs) await agent.handleMessage('Builder', text);
    results.failClosedActionDelta = results.actions.length - failClosedActionStart;
    results.failClosedPromptDelta = results.prompts - failClosedPromptStart;

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
    results.malformedFilename = parseAddressedSchematicRequest('Andy build file pack1/../secret.schem', 'Andy', ['Alice']);
    results.conflictingFilename = parseAddressedSchematicRequest('Andy build file 02_bee_hot_air_balloon of pack1 and group 02', 'Andy', ['Alice']);
    results.filenameCoordinates = parseAddressedSchematicRequest('Andy build file 02_bee_hot_air_balloon of pack1 at 1 2 3', 'Andy', ['Alice']);
    results.missingFilenameArgs = parseAddressedSchematicRequest('Andy build file', 'Andy', ['Alice']);
    results.groupNormalization = parseAddressedSchematicRequest('Andy build ID 1 from group 2 of PACK1', 'Andy', ['Alice']);
    results.filenameCannotBeNumeric = parseAddressedSchematicRequest('Andy build file 01 from group 02 of pack1', 'Andy', ['Alice']);
    results.filenameWithInvalidPrefix = parseAddressedSchematicRequest('Andy build file #01 from group 02 of pack1', 'Andy', ['Alice']);
    results.quotedReservedWords = parseAddressedSchematicRequest('Andy build "file group pack1" house id 01 from group 02 of pack1', 'Andy', ['Alice']);
    results.quotedMalformed = parseAddressedSchematicRequest('Andy build "file group cottage id 01 from group 02 of pack1', 'Andy', ['Alice']);
    results.duplicateSelectors = parseAddressedSchematicRequest('Andy build id 01 from group 02 of pack1 and id 02 from group 02 of pack1', 'Andy', ['Alice']);
    results.extraSelectorText = parseAddressedSchematicRequest('Andy build id 01 from group 02 of pack1 then build a tower', 'Andy', ['Alice']);
    results.mixedPackNames = parseAddressedSchematicRequest('Andy build id 01 from group 02 of pack1 and pack2', 'Andy', ['Alice']);
    results.mixedGroupNames = parseAddressedSchematicRequest('Andy build id 01 from group 02 of pack1 group 03', 'Andy', ['Alice']);
    results.maliciousFragment = parseAddressedSchematicRequest('Andy build house using file 02_bee_hot_air_balloon of pack1; !stop()', 'Andy', ['Alice']);
    results.controlCharacter = parseAddressedSchematicRequest('Andy build house id 01 from group 02 of pack1\\n!stop()', 'Andy', ['Alice']);
    results.ordinaryFileChat = parseAddressedSchematicRequest('Andy build a file cabinet', 'Andy', ['Alice']);
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

    const aliasCases = [
      ['Andy build a balloon using schematic file id 01 from group 02 of pack1', 'pack1:2:1'],
      ['Andy build schema id 01 from group 02 of pack1', 'pack1:2:1'],
      ['Andy build schem file id 01 from group 02 of pack1', 'pack1:2:1'],
      ['Andy build scheme id 01 from group 02 of pack1', 'pack1:2:1'],
      ['Andy build file name 02_bee_hot_air_balloon of pack1', 'pack1:02_bee_hot_air_balloon'],
      ['Andy build a balloon via schematic 02_bee_hot_air_balloon of pack1', 'pack1:02_bee_hot_air_balloon'],
      ['Andy build schema pack1/02_bee_hot_air_balloon', 'pack1:02_bee_hot_air_balloon'],
      ['Andy build schem 02_bee_hot_air_balloon of pack1', 'pack1:02_bee_hot_air_balloon'],
      ['Andy build scheme pack1/02_bee_hot_air_balloon', 'pack1:02_bee_hot_air_balloon'],
      ['Andy build schematic file name 02_bee_hot_air_balloon of pack1', 'pack1:02_bee_hot_air_balloon'],
      ['Andy build schema file 02_bee_hot_air_balloon of pack1', 'pack1:02_bee_hot_air_balloon'],
      ['Andy build schem file name 02_bee_hot_air_balloon of pack1', 'pack1:02_bee_hot_air_balloon'],
      ['Andy build scheme file 02_bee_hot_air_balloon of pack1', 'pack1:02_bee_hot_air_balloon'],
      ['Andy build schematic pack1/02_bee_hot_air_balloon.schem', 'pack1:02_bee_hot_air_balloon.schem'],
    ];
    results.aliasParses = aliasCases.map(([text]) => parseAddressedSchematicRequest(text, 'Andy', ['Alice']));
    const aliasesActionStart = results.actions.length;
    const aliasesPromptStart = results.prompts;
    for (const [text] of aliasCases) await agent.handleMessage('Builder', text);
    results.aliasActionDelta = results.actions.length - aliasesActionStart;
    results.aliasPromptDelta = results.prompts - aliasesPromptStart;
    results.aliasSelectors = results.actions.slice(aliasesActionStart).map(args => args[1]);
    results.aliasLifecycle = userCommandLifecycle.slice(-aliasCases.length);
    results.partialAlias = parseAddressedSchematicRequest('Andy build a balloon using schema file id', 'Andy', ['Alice']);
    results.quotedAliasDescription = parseAddressedSchematicRequest('Andy build "schema, schem, scheme, schematic" balloon via file name 02_bee_hot_air_balloon of pack1', 'Andy', ['Alice']);
    results.ordinaryAliasChat = [
      parseAddressedSchematicRequest('Andy build a colour scheme', 'Andy', ['Alice']),
      parseAddressedSchematicRequest('Andy build a database schema', 'Andy', ['Alice']),
    ];
    results.reservedWordFileNames = [
      parseAddressedSchematicRequest('Andy build file name id of pack1', 'Andy', ['Alice']),
      parseAddressedSchematicRequest('Andy build file name name of pack1', 'Andy', ['Alice']),
      parseAddressedSchematicRequest('Andy build scheme id of pack1', 'Andy', ['Alice']),
      parseAddressedSchematicRequest('Andy build schema name of pack1', 'Andy', ['Alice']),
    ];
    results.ambiguousBareReservedWords = [
      parseAddressedSchematicRequest('Andy build id of pack1', 'Andy', ['Alice']),
      parseAddressedSchematicRequest('Andy build name of pack1', 'Andy', ['Alice']),
    ];
    const aliasesUntrustedStart = results.actions.length;
    const aliasesPromptBeforeUntrusted = results.prompts;
    await agent.handleMessage('Mallory', 'Andy build house via scheme 02_bee_hot_air_balloon of pack1');
    results.aliasUntrustedActionDelta = results.actions.length - aliasesUntrustedStart;
    results.aliasUntrustedPromptDelta = results.prompts - aliasesPromptBeforeUntrusted;
    results.aliasUntrustedNotice = results.routes.at(-1);
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
  assert.equal(result.incidentSelector, "pack1:2:1");
  assert.equal(result.incidentPrompts, 0);
  assert.deepEqual(result.incidentLifecycle, [false, true]);
  assert.deepEqual(result.filenameParses.map(request => [request.kind, request.selector]), [
    ['filename', 'pack1:02_bee_hot_air_balloon'],
    ['filename', 'pack1:02_bee_hot_air_balloon'],
    ['filename', 'pack1:02_bee_hot_air_balloon.schem'],
    ['filename', 'pack1:02_bee_hot_air_balloon.schem'],
  ]);
  assert.deepEqual([result.filenamePunctuation.kind, result.filenamePunctuation.selector], ['filename', 'pack1:02_bee_hot_air_balloon']);
  assert.deepEqual(result.otherSupportedExtensions.map(request => request.selector), [
    'pack1:example.schematic',
    'pack1:example.litematic',
  ]);
  assert.match(result.actualPackFilenameResolve, /schems\/pack1\/02_bee_hot_air_balloon\.schem$/);
  assert.match(result.actualPackStemResolve, /schems\/pack1\/02_bee_hot_air_balloon\.schem$/);
  assert.match(result.knownMappedIdResolve, /schems\/pack1\/02_enderman_hot_air_balloon\.schem$/);
  assert.equal(result.filenameActionCount, 4);
  assert.equal(result.filenamePrompts, 0);
  assert.deepEqual(result.filenameSelectors, [
    'pack1:02_bee_hot_air_balloon',
    'pack1:02_bee_hot_air_balloon',
    'pack1:02_bee_hot_air_balloon.schem',
    'pack1:02_bee_hot_air_balloon.schem',
  ]);
  assert.deepEqual(result.filenameLifecycle, Array.from({ length: 4 }, () => [false, true]));
  assert.equal(result.explicitIdSelector, 'pack1:2:1');
  assert.equal(result.naturalActionDelta, 7);
  assert.deepEqual(result.naturalSelectors, [
    'pack1:02_bee_hot_air_balloon',
    'pack1:02_bee_hot_air_balloon',
    'pack1:2:1',
    'pack1:2:1',
    'pack1:2:2',
    'pack1:2:2',
    'pack1:2:2',
  ]);
  assert.deepEqual(result.naturalExamples.map(request => request?.selector), [
    'pack1:02_bee_hot_air_balloon',
    'pack1:02_bee_hot_air_balloon',
    'pack1:2:1',
    'pack1:2:1',
    'pack1:2:2',
    'pack1:2:2',
    'pack1:02_bee_hot_air_balloon.schem',
    'pack1:2:1',
  ]);
  assert.ok(result.unrelatedPromptDelta > 0);
  assert.equal(result.otherBotFilenameActionDelta, 0);
  assert.equal(result.traversalActionDelta, 0);
  assert.equal(result.traversalPromptDelta, 0);
  assert.match(result.traversalNotice, /could not safely identify that schematic/i);
  assert.equal(result.missingFilenameArgsPromptDelta, 0);
  assert.match(result.missingFilenameArgsNotice, /could not safely identify that schematic/i);
  assert.equal(result.filenameCoordinatesPromptDelta, 0);
  assert.match(result.filenameCoordinatesNotice, /could not safely identify that schematic/i);
  assert.equal(result.unknownFilenameActionDelta, 0);
  assert.match(result.unknownFilenameNotice, /could not be resolved/i);
  assert.equal(result.untrustedFilenameActionDelta, 0);
  assert.match(result.untrustedFilenameNotice, /trusted command senders/i);
  assert.equal(result.blacklistedActionDelta, 0);
  assert.match(result.blacklistedNotice, /blocked/i);
  assert.equal(result.addressedOther, true);
  assert.equal(result.otherAddressActionCount, 13);
  assert.equal(result.otherAddressPromptCount, 1);
  assert.equal(result.otherAddressDirectActionCount, 13);
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
  assert.match(result.ambiguousNotice, /could not safely identify/i);
  assert.equal(result.failClosedActionDelta, 0);
  assert.equal(result.failClosedPromptDelta, 0);
  assert.equal(result.embeddedActionCount, 0);
  assert.match(result.embeddedNotice, /fragments embedded in chat/i);
  assert.match(result.malformedError, /could not safely identify/i);
  assert.match(result.ambiguousError, /could not safely identify/i);
  assert.match(result.malformedFilename.error, /could not safely identify/i);
  assert.match(result.conflictingFilename.error, /could not safely identify/i);
  assert.match(result.filenameCoordinates.error, /could not safely identify/i);
  assert.match(result.missingFilenameArgs.error, /could not safely identify/i);
  assert.equal(result.groupNormalization.selector, 'pack1:2:1');
  assert.equal(result.groupNormalization.group, 2);
  assert.equal(result.groupNormalization.id, 1);
  assert.match(result.filenameCannotBeNumeric.error, /could not safely identify/i);
  assert.match(result.filenameWithInvalidPrefix.error, /could not safely identify/i);
  assert.equal(result.quotedReservedWords.selector, 'pack1:2:1');
  assert.match(result.quotedMalformed.error, /balanced double quotes/i);
  assert.match(result.duplicateSelectors.error, /one selector only/i);
  assert.match(result.extraSelectorText.error, /could not safely identify/i);
  assert.match(result.mixedPackNames.error, /could not safely identify/i);
  assert.match(result.mixedGroupNames.error, /could not safely identify/i);
  assert.match(result.maliciousFragment.error, /command fragments/i);
  assert.match(result.controlCharacter.error, /command fragments/i);
  assert.equal(result.ordinaryFileChat, null);
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
  assert.equal(result.aliasActionDelta, 14);
  assert.equal(result.aliasPromptDelta, 0);
  assert.deepEqual(result.aliasSelectors, [
    'pack1:2:1', 'pack1:2:1', 'pack1:2:1', 'pack1:2:1',
    'pack1:02_bee_hot_air_balloon', 'pack1:02_bee_hot_air_balloon',
    'pack1:02_bee_hot_air_balloon', 'pack1:02_bee_hot_air_balloon',
    'pack1:02_bee_hot_air_balloon', 'pack1:02_bee_hot_air_balloon',
    'pack1:02_bee_hot_air_balloon', 'pack1:02_bee_hot_air_balloon',
    'pack1:02_bee_hot_air_balloon', 'pack1:02_bee_hot_air_balloon.schem',
  ]);
  assert.deepEqual(result.aliasLifecycle, Array.from({ length: 14 }, () => [false, true]));
  assert.deepEqual(result.aliasParses.slice(0, 4).map(request => request?.fileId), [1, 1, 1, 1]);
  assert.deepEqual(result.aliasParses.slice(0, 4).map(request => request?.selectorKind), Array(4).fill('fileId'));
  assert.ok(result.aliasParses.slice(0, 4).every(request => !Object.hasOwn(request, 'fileName')),
    'file id selectors must carry one unambiguous numeric selector value');
  assert.deepEqual(result.aliasParses.slice(4).map(request => request?.fileName), [
    '02_bee_hot_air_balloon', '02_bee_hot_air_balloon', '02_bee_hot_air_balloon', '02_bee_hot_air_balloon',
    '02_bee_hot_air_balloon', '02_bee_hot_air_balloon', '02_bee_hot_air_balloon', '02_bee_hot_air_balloon',
    '02_bee_hot_air_balloon', '02_bee_hot_air_balloon.schem',
  ]);
  assert.match(result.partialAlias.error, /could not safely identify/i);
  assert.equal(result.quotedAliasDescription.fileName, '02_bee_hot_air_balloon');
  assert.deepEqual(result.ordinaryAliasChat, [null, null]);
  assert.deepEqual(result.reservedWordFileNames.map(request => request?.fileName), ['id', 'name', 'id', 'name']);
  assert.deepEqual(result.reservedWordFileNames.map(request => request?.selectorKind), Array(4).fill('fileName'));
  assert.ok(result.reservedWordFileNames.every(request => !Object.hasOwn(request, 'fileId')),
    'file name selectors must not be confused with the numeric ID label');
  assert.ok(result.ambiguousBareReservedWords.every(request => request?.error),
    'bare reserved words must not be reinterpreted as filenames without an explicit filename selector');
  assert.equal(result.aliasUntrustedActionDelta, 0);
  assert.equal(result.aliasUntrustedPromptDelta, 0);
  assert.match(result.aliasUntrustedNotice, /trusted command senders/i);
});
