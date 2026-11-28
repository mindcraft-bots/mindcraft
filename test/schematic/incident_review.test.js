import { createRoutingFixture } from "./routing_fixture.js";
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const url = path => JSON.stringify(new URL(path, root).href);
const fixtureRoot = createRoutingFixture();
const loader = fileURLToPath(new URL('./commands-loader.js', import.meta.url));

function check(body) {
    const script = `
        import assert from 'node:assert/strict';
        const settings = globalThis.__testSettings = {
            allow_insecure_coding: false, trusted_command_senders: ['Sunny26639'],
            known_bot_peers: ['Alice'], max_commands: 1, only_chat_with: [], chat_ingame: true,
        };
        const { setSettings } = await import(${url('src/agent/settings.js')});
        const syncSettings = () => setSettings(settings);
        syncSettings();
        const { Agent } = await import(${url('src/agent/agent.js')});
        const commands = await import(${url('src/agent/commands/index.js')});
        const router = await import(${url('src/agent/schematic_request.js')});
        const convo = (await import(${url('src/agent/conversation.js')})).default;
        const calls = { builds: 0, prompts: 0, generated: 0, history: [], routes: [], chat: [], whisper: [], lifecycle: [] };
        const agent = Object.create(Agent.prototype);
        Object.assign(agent, {
            name: 'Andy', blocked_actions: [], shut_up: false, task: { data: null },
            bot: { version: '1.21.4', output: '', interrupt_code: false, emit() {}, on() {}, autoEat: {},
                modes: { flushBehaviorLog: () => '' },
                chat: text => calls.chat.push(text), whisper: (...args) => calls.whisper.push(args) },
            actions: { runAction: async (_name, fn) => { await fn(); return { message: 'done' }; } },
            history: { add: (...args) => calls.history.push(args), save() {}, getHistory: () => [] },
            prompter: { promptConvo: async () => { calls.prompts++; return 'No command.'; } },
            coder: { generateCode: async () => { calls.generated++; return 'generated'; } },
            self_prompter: { shouldInterrupt: () => false, isActive: () => false,
                handleUserPromptedCmd: (...args) => calls.lifecycle.push(args) },
            routeResponse: async (_to, message) => calls.routes.push(message),
            checkTaskDone: async () => {},
        });
        globalThis.__schematicBuild = async () => { calls.builds++; };
        ${body}
    `;
    const child = spawnSync(process.execPath, ['--experimental-loader', loader, '--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, MINDCRAFT_SCHEMATIC_FIXTURE_ROOT: fixtureRoot } });
    assert.equal(child.status, 0, child.stderr + child.stdout);
}

test('explicit and malformed continuation never fall back to inference', () => check(`
    const continuation = 'Andy continue schematic file name gazebo of pack2 at 120 64 -30 facing east';
    const parsed = router.parseAddressedSchematicRequest(continuation, 'Andy');
    assert.equal(parsed.selector, 'pack2:gazebo');
    assert.deepEqual(parsed.coordinates, [120, 64, -30]);
    assert.equal(parsed.orientation, 'east');
    for (const message of ['Andy continue schematic file name gazebo of pack2', 'Andy finish building id 1 from group 2 of pack2', 'Andy build to continue id 1 from group 2 of pack2']) {
        assert.match(router.parseAddressedSchematicRequest(message, 'Andy').error, /Continuation requires/);
        await agent.handleMessage('Sunny26639', message);
    }
    assert.equal(calls.builds, 0);
    assert.equal(calls.prompts, 0);
    assert.match(calls.routes.join(' '), /Continuation requires/i);
    assert.equal(router.parseAddressedSchematicRequest('Andy continue the story', 'Andy'), null);
    assert.equal(router.parseAddressedSchematicRequest('Andy build new schematic file name gazebo of pack2', 'Andy').selector, 'pack2:gazebo');
`));

test('unified settings authorize only the observed human, preserving security values and blacklist', async () => {
    const settings = (await import(new URL('settings.js', root))).default;
    assert.deepEqual(settings.profiles, ['./alice.json', './andy.json']);
    assert.deepEqual(settings.trusted_command_senders, ['Sunny26639']);
    assert.equal(settings.allow_insecure_coding, true);
    assert.equal(settings.auth, 'offline');
    assert.deepEqual(settings.known_bot_peers, ['Alice', 'Andy']);
    assert.deepEqual(settings.blocked_actions, ['!checkBlueprint', '!checkBlueprintLevel', '!getBlueprint', '!getBlueprintLevel']);
});

test('all explicitly peer-addressed chat is ignored before command extraction or inference', () => check(`
    convo.updateAgents([{ name: 'DynamicPeer', in_game: true }]);
    for (const message of ['Alice build a house', 'Alice: please build id 01 from group 02 of pack2',
        'Alice:!buildSchematic("pack2:02:01")', '@alice!stop', 'Alice, hello', 'DynamicPeer build a house']) {
        await agent.handleMessage('Sunny26639', message);
    }
    assert.equal(calls.builds, 0);
    assert.equal(calls.prompts, 0);
    assert.equal(calls.routes.length, 0);
`));

test('real Andy/Alice settings permit the observed human and deny peers and other players in the handler', () => check(`
    agent.prompter.promptConvo = async () => { calls.prompts++; return '!newAction("untrusted")'; };
    for (const name of ['Andy', 'Alice']) {
        const actual = (await import(new URL('settings.js', ${url('')}))).default;
        Object.assign(settings, actual); syncSettings();
        agent.name = name;
        agent.blocked_actions = actual.blocked_actions;
        const before = calls.builds;
        await agent.handleMessage('Sunny26639', name + ' build 01 from group 02 of pack2');
        await agent.handleMessage('Sunny26639', '!buildSchematic("pack2:02:01")');
        for (const sender of [...actual.known_bot_peers.filter(peer => peer !== name), 'OtherPlayer']) {
            await agent.handleMessage(sender, name + ' build 01 from group 02 of pack2');
            await agent.handleMessage(sender, '!buildSchematic("pack2:02:01")');
        }
        assert.equal(calls.builds - before, 2);
        assert.equal(calls.generated, 0);
    }
`));

test('malformed, contradictory, and additional schematic input fails closed rather than partially matching', () => check(`
    for (const text of ['build id 01.5 from group 02 of pack2', 'build id 01 from group 02.5 of pack2',
        'build id 01junk from group 02 of pack2', 'build 02 id 01 from group 02 of pack2',
        'build id -01 from group 02 of pack2', 'build id 01 from group -02 of pack2',
        'build id 01 from group 02 of pack2 at 100 64 100',
        'please build id 01 from group two of pack2', 'build id 01 from group 02 of pack0',
        'build id 01 from group 02 of pack2 !stop', 'build schematic']) {
        const request = router.parseAddressedSchematicRequest('Andy ' + text, 'Andy', ['Alice']);
        assert.ok(request?.error, text + ' must be rejected');
        await agent.handleMessage('Sunny26639', 'Andy ' + text);
    }
    assert.equal(calls.builds, 0);
    assert.equal(calls.prompts, 0);
`));

test('mode suffixes reach the build boundary without inference', () => check(`
    const { buildSchematic } = await import(${url('src/utils/schematic/build_schematic.js')});
    const failures = [];
    globalThis.__schematicBuild = async (bot, filename, x, y, z, options) => {
        calls.builds++;
        assert.ok(Object.isFrozen(options));
        const result = await buildSchematic(bot, filename, x, y, z, {
            placementOptions: options, writeLog: message => failures.push(message),
            resolvePath: () => { throw new Error('must not resolve'); },
        });
        assert.equal(result, false);
    };
    for (const mode of ['delicate', 'balanced', 'raise', 'destructive']) {
        for (const connector of ['using', 'via']) {
            for (const options of mode === 'balanced' ? ['', ' radius=6 threshold=12'] : ['']) {
                const text = 'Andy build id 01 from group 02 of pack2 ' + connector + ' ' + mode + ' mode' + options;
                assert.equal(router.parseAddressedSchematicRequest(text, 'Andy').placementOverrides.mode, mode);
                await agent.handleMessage('Sunny26639', text);
                if (mode === 'destructive') {
                    assert.match(calls.routes.at(-1), /explicitly listed human sender/);
                    continue;
                }
                assert.equal(globalThis.__buildSchematicArgs[5].mode, mode);
                assert.equal(globalThis.__buildSchematicArgs[5].radius, options ? 6 : 4);
                assert.equal(globalThis.__buildSchematicArgs[5].threshold, options ? 12 : 9);
                assert.match(failures.at(-1), /Could not read schematic.*must not resolve/);
            }
        }
    }
    assert.equal(calls.builds, 8);
    assert.equal(calls.prompts, 0);
    assert.equal(calls.lifecycle.length, 8);
    for (const text of [
        'Andy build id 01 from group 02 of pack2 !stop using raise mode',
        'Andy build id 01 from group 02 of pack2 using raise mode !stop',
        'Andy build id 01 from group 02 of pack2 using raise mode extra',
    ]) assert.ok(router.parseAddressedSchematicRequest(text, 'Andy')?.error, text);
`));

test('orientation clauses reach the real handler once, and ambiguous tails fail closed', () => check(`
    const base = 'Andy build id 1 from group 2 of pack2';
    for (const suffix of ['facing south', 'oriented south', 'rotated south', 'rotated to south',
        'rotated to face south', 'rotated towards south', 'and rotate it south', 'then rotate to face south',
        'rotating south', 'rotate south', 'oriented to face south', 'FACING S', 'RoTaTeD To FaCe SoUtH']) {
        const message = base + ' ' + suffix;
        const before = calls.builds;
        assert.ok(!router.parseAddressedSchematicRequest(message, 'Andy').error, message);
        await agent.handleMessage('Sunny26639', message);
        assert.equal(calls.builds, before + 1, message);
        assert.equal(globalThis.__buildSchematicArgs[5].orientation, 'south', message);
        assert.ok(Object.isFrozen(globalThis.__buildSchematicArgs[5]));
    }
    for (const [direction, canonical] of [['N', 'north'], ['e', 'east'], ['W', 'west']]) {
        await agent.handleMessage('Sunny26639', base + ' facing ' + direction);
        assert.equal(globalThis.__buildSchematicArgs[5].orientation, canonical);
    }
    for (const suffix of ['facing east using balanced mode radius=6 threshold=12',
        'via balanced mode threshold=12 radius=6 then rotate to face east']) {
        await agent.handleMessage('Sunny26639', base + ' ' + suffix);
        assert.deepEqual(globalThis.__buildSchematicArgs[5], { mode: 'balanced', radius: 6, threshold: 12, orientation: 'east', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 });
    }
    const before = calls.builds, prompts = calls.prompts;
    for (const suffix of ['facing south facing south', 'facing south rotated north', 'facing south east',
        'rotated', 'rotated to', 'rotate it', 'facing northeast', 'facing 90', 'facing south extra',
        'facing south; !stop()', 'facing south !stop()', 'facing south\\nusing raise mode',
        'facing south using unknown mode', 'using raise mode facing south using balanced mode',
        'facing south via balanced mode radius=1.5', 'facing south via balanced mode radius=999']) {
        const message = base + ' ' + suffix;
        assert.ok(router.parseAddressedSchematicRequest(message, 'Andy')?.error, message);
        await agent.handleMessage('Sunny26639', message);
    }
    assert.equal(calls.builds, before); assert.equal(calls.prompts, prompts);
    for (const message of ['Andy build facing south id 1 from group 2 of pack2',
        'Andy build rotated north id 1 from group 2 of pack2 facing south']) {
        assert.ok(router.parseAddressedSchematicRequest(message, 'Andy')?.error, message);
        await agent.handleMessage('Sunny26639', message);
    }
    assert.equal(calls.builds, before); assert.equal(calls.prompts, prompts);
    for (const text of ['Andy build "facing south" id 1 from group 2 of pack2',
        'Andy build file name facing_south.schem of pack2']) {
        const parsed = router.parseAddressedSchematicRequest(text, 'Andy');
        assert.ok(!parsed.error, text); assert.equal(parsed.placementOverrides, undefined);
    }
    assert.equal(router.parseAddressedSchematicRequest('Andy what is facing south?', 'Andy'), null);
    await agent.handleMessage('Sunny26639', 'Alice build id 1 from group 2 of pack2 facing south');
    await agent.handleMessage('Mallory', base + ' facing south');
    agent.blocked_actions = ['!buildSchematic'];
    await agent.handleMessage('Sunny26639', base + ' facing south');
    assert.equal(calls.builds, before); assert.equal(calls.prompts, prompts);
`));

test('direct direction is strict and resolved with the complete settings', () => check(`
    const prefix = '!buildSchematic("pack2:2:1", null, null, null, null, null, null, ';
    const literal = commands.parseCommandMessage('!buildSchematic("facing south.schem")');
    assert.equal(literal.args[0], 'facing south.schem');
    assert.equal(literal.args[7], null);
    for (const [input, expected] of [['"E"', 'east'], ['"SoUtH"', 'south'], ['null', 'north']]) {
        const command = prefix + input + ')';
        assert.equal(typeof commands.parseCommandMessage(command), 'object');
        await agent.handleMessage('Sunny26639', command);
        assert.equal(globalThis.__buildSchematicArgs[5].orientation, expected);
    }
    const before = calls.builds, prompts = calls.prompts;
    for (const input of ['"northeast"', '"90"', '90', 'true', '"east west"', '"east" trailing', '"east", "west"']) {
        const command = prefix + input + ')';
        assert.equal(typeof commands.parseCommandMessage(command), 'string', command);
        await agent.handleMessage('Sunny26639', command);
    }
    await agent.handleMessage('Sunny26639', '!buildSchematic("pack2:2:1", 1, null, 3, null, null, null, "east")');
    (await import(${url('src/agent/settings.js')})).default.schematic_balanced_radius = -1;
    await agent.handleMessage('Sunny26639', prefix + '"east")');
    assert.equal(calls.builds, before); assert.equal(calls.prompts, prompts);
`));

test('mode parsing, overrides, trusted routing and malformed requests fail closed', () => check(`
    settings.schematic_placement_mode = 'balanced';
    settings.schematic_balanced_radius = 3;
    settings.schematic_balanced_threshold = 15;
    syncSettings();
    for (const connector of ['USING', 'ViA']) for (const mode of ['DELICATE', 'RAISE', 'DESTRUCTIVE', 'BALANCED']) {
        const text = 'Andy build file pack2/09_garden ' + connector + ' ' + mode + ' MoDe';
        assert.equal(router.parseAddressedSchematicRequest(text, 'Andy').placementOverrides.mode, mode.toLowerCase());
        await agent.handleMessage('Sunny26639', text);
        if (mode === 'DESTRUCTIVE') {
            assert.match(calls.routes.at(-1), /explicitly listed human sender/);
            continue;
        }
        assert.deepEqual(globalThis.__buildSchematicArgs[5], { mode: mode.toLowerCase(), radius: 3, threshold: 15, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 });
    }
    for (const [suffix, radius, threshold] of [['radius=0', 0, 15], ['threshold=4097', 3, 4097], ['threshold=12 radius=16', 16, 12]]) {
        await agent.handleMessage('Sunny26639', 'Andy build id 1 from group 2 of pack2 using balanced mode ' + suffix);
        assert.deepEqual(globalThis.__buildSchematicArgs[5], { mode: 'balanced', radius, threshold, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 });
    }
    const builds = calls.builds, prompts = calls.prompts;
    const unknownMode = 'Andy build id 1 from group 2 of pack2 using unknown mode';
    assert.match(router.parseAddressedSchematicRequest(unknownMode, 'Andy').error, /placement mode|valid schematic selector/i);
    await agent.handleMessage('Sunny26639', unknownMode);
    assert.equal(calls.builds, builds);
    for (const suffix of ['using balanced mode radius=17', 'via balanced mode radius=-1', 'using balanced mode threshold=0',
        'using balanced mode threshold=4098', 'using balanced mode radius=1.5', 'using balanced mode radius=2 radius=3',
        'using balanced mode threshold=2 threshold=3', 'using raise mode radius=2', 'via destructive mode threshold=2',
        'using magic mode', 'using balanced mode radius=', 'using balanced mode extra',
        'using raise mode via balanced mode', 'using balanced mode; !stop()', 'via balanced mode radius=6 !stop()',
        'using balanced mode\\n radius=6', 'using\\tbalanced mode']) {
        const message = 'Andy build id 1 from group 2 of pack2 ' + suffix;
        assert.ok(router.parseAddressedSchematicRequest(message, 'Andy')?.error, message);
        await agent.handleMessage('Sunny26639', message);
    }
    assert.ok(router.parseAddressedSchematicRequest('Andy build using raise mode id 1 from group 2 of pack2 via balanced mode', 'Andy').error);
    for (const text of ['Andy build a house using balanced', 'Andy build a house via raise mod', 'Andy build a house using mystery mode']) {
        assert.ok(router.parseAddressedSchematicRequest(text, 'Andy')?.error, text);
        await agent.handleMessage('Sunny26639', text);
    }
    await agent.handleMessage('OtherPlayer', 'Andy build id 1 from group 2 of pack2 using raise mode');
    await agent.handleMessage('Sunny26639', 'Alice build id 1 from group 2 of pack2 using raise mode');
    assert.equal(calls.builds, builds);
    assert.equal(calls.prompts, prompts);
`));

test('direct mode commands validate entire input and carry effective options', () => check(`
    const { buildSchematic } = await import(${url('src/utils/schematic/build_schematic.js')});
    const failures = [];
    globalThis.__schematicBuild = async (bot, filename, x, y, z, options) => {
        calls.builds++;
        assert.equal(await buildSchematic(bot, filename, x, y, z, {
            placementOptions: options, writeLog: message => failures.push(message),
            resolvePath: () => { throw new Error('must not resolve'); },
        }), false);
    };
    settings.schematic_placement_mode = 'balanced';
    settings.schematic_balanced_radius = 5;
    settings.schematic_balanced_threshold = 10;
    syncSettings();
    for (const [command, expected] of [
        ['!buildSchematic("pack2:2:1")', { mode: 'balanced', radius: 5, threshold: 10, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 }],
        ['!buildSchematic("pack2:2:1", null, null, null, "delicate")', { mode: 'delicate', radius: 5, threshold: 10, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 }],
        ['!buildSchematic("pack2:2:1", 1, 2, 3, "RAISE")', { mode: 'raise', radius: 5, threshold: 10, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 }],
        ['!buildSchematic("pack2:2:1", null, null, null, "balanced", 6, 12)', { mode: 'balanced', radius: 6, threshold: 12, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 }],
        ['!buildSchematic("pack2:2:1", null, null, null, null, null, 1)', { mode: 'balanced', radius: 5, threshold: 1, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 }],
    ]) {
        await agent.handleMessage('Sunny26639', command);
        assert.deepEqual(globalThis.__buildSchematicArgs[5], expected);
        assert.ok(Object.isFrozen(globalThis.__buildSchematicArgs[5]));
        assert.match(failures.at(-1), /Could not read schematic.*must not resolve/);
    }
    const builds = calls.builds, prompts = calls.prompts;
    const unknownMode = '!buildSchematic("pack2:2:1", null, null, null, "unknown")';
    await agent.handleMessage('Sunny26639', unknownMode);
    assert.match(calls.routes.at(-1), /must be quoted delicate, raise, balanced, or destructive/i);
    assert.equal(calls.builds, builds);
    for (const command of [
        '!buildSchematic("pack2:2:1", 1, null, 3, "raise")',
        '!buildSchematic("pack2:2:1", null, null, null, "raise", 2)',
        '!buildSchematic("pack2:2:1", null, null, null, "balanced", 17)',
        '!buildSchematic("pack2:2:1", null, null, null, "balanced", 1.2)',
        '!buildSchematic("pack2:2:1", null, null, null, "balanced", "6")',
        '!buildSchematic("pack2:2:1", null, null, null, "null")',
        '!buildSchematic("pack2:2:1", null, null, null, "unknown")',
        '!buildSchematic("pack2:2:1", null, null, null, "balanced", 6, 12, 7)',
        '!buildSchematic("pack2:2:1", null, null, null, "raise") trailing',
        '!buildSchematic("pack2:2:1", null, null, null, "raise"; !stop())',
    ]) {
        await agent.handleMessage('Sunny26639', command);
        assert.equal(calls.builds, builds, command);
    }
    assert.equal(calls.prompts, prompts);
`));

test('balanced search overrides reach both command routes and malformed suffixes fail closed', () => check(`
    settings.schematic_placement_mode = 'balanced';
    settings.schematic_balanced_strategy = 'all';
    settings.schematic_balanced_step = 5;
    settings.schematic_balanced_policy = 'exhaustive';
    settings.schematic_balanced_bisect_depth = 1;
    syncSettings();
    const base = 'Andy build id 1 from group 2 of pack2';
    for (const suffix of [
        'FACING EAST USING BALANCED MODE POLICY=first_valid BISECT_DEPTH=0 STEP=16 STRATEGY=bisect',
        'via balanced mode strategy=bisect step=16 bisect_depth=0 policy=first_valid facing east',
    ]) {
        await agent.handleMessage('Sunny26639', base + ' ' + suffix);
        assert.deepEqual(globalThis.__buildSchematicArgs[5], { mode: 'balanced', radius: 4, threshold: 9, orientation: 'east', strategy: 'bisect', step: 16, policy: 'first_valid', bisectDepth: 0 });
        assert.ok(Object.isFrozen(globalThis.__buildSchematicArgs[5]));
    }
    const direct = '!buildSchematic("pack2:2:1", null, null, null, "BALANCED", null, null, "W", "all", 1, "exhaustive", 3)';
    await commands.executeCommand(agent, direct);
    assert.deepEqual(globalThis.__buildSchematicArgs[5], { mode: 'balanced', radius: 4, threshold: 9, orientation: 'west', strategy: 'all', step: 1, policy: 'exhaustive', bisectDepth: 3 });
    await agent.handleMessage('Sunny26639', direct);
    assert.equal(globalThis.__buildSchematicArgs[5].bisectDepth, 3);
    await agent.handleMessage('Sunny26639', base + ' using balanced mode step=2');
    assert.deepEqual(globalThis.__buildSchematicArgs[5], { mode: 'balanced', radius: 4, threshold: 9, orientation: 'north', strategy: 'all', step: 2, policy: 'exhaustive', bisectDepth: 1 });
    for (const strategy of ['all', 'stepped', 'bisect']) for (const policy of ['first_valid', 'exhaustive']) {
        const message = base + ' USING BALANCED MODE STRATEGY=' + strategy + ' POLICY=' + policy;
        await agent.handleMessage('Sunny26639', message);
        assert.equal(globalThis.__buildSchematicArgs[5].strategy, strategy, message);
        assert.equal(globalThis.__buildSchematicArgs[5].policy, policy, message);
        const command = '!buildSchematic("pack2:2:1", null, null, null, "BALANCED", null, null, "E", "' + strategy + '", null, "' + policy + '")';
        await agent.handleMessage('Sunny26639', command);
        assert.equal(globalThis.__buildSchematicArgs[5].strategy, strategy, command);
        assert.equal(globalThis.__buildSchematicArgs[5].policy, policy, command);
    }
    const before = calls.builds, prompts = calls.prompts;
    for (const suffix of ['using balanced mode strategy=none', 'using balanced mode strategy=',
        'using balanced mode strategy=ALL', 'using balanced mode strategy=STEPPED', 'using balanced mode STRATEGY=BiSeCt facing EAST',
        'FACING EAST VIA BALANCED MODE POLICY=FIRST_VALID', 'using balanced mode policy=Exhaustive',
        'using balanced mode strategy=all strategy=bisect', 'using balanced mode step=0',
        'using balanced mode step=17', 'using balanced mode step=1.5', 'using balanced mode bisect_depth=-1',
        'using balanced mode bisect_depth=4', 'using balanced mode policy=unknown',
        'using balanced mode policy=first_valid policy=exhaustive', 'using raise mode strategy=all',
        'using balanced mode strategy=all; !stop()', 'using balanced mode strategy=all extra']) {
        const message = base + ' ' + suffix;
        assert.ok(router.parseAddressedSchematicRequest(message, 'Andy')?.error, message);
        await agent.handleMessage('Sunny26639', message);
    }
    for (const command of [
        '!buildSchematic("pack2:2:1", null, null, null, "balanced", null, null, null, "ALL")',
        '!buildSchematic("pack2:2:1", null, null, null, "balanced", null, null, null, "BiSeCt")',
        '!buildSchematic("pack2:2:1", null, null, null, "balanced", null, null, null, null, null, "FIRST_VALID")',
        '!buildSchematic("pack2:2:1", null, null, null, "balanced", null, null, null, null, null, "Exhaustive")',
        '!buildSchematic("pack2:2:1", null, null, null, "balanced", null, null, null, "unknown")',
        '!buildSchematic("pack2:2:1", null, null, null, "balanced", null, null, null, "all", 0)',
        '!buildSchematic("pack2:2:1", null, null, null, "balanced", null, null, null, null, null, "bad")',
        '!buildSchematic("pack2:2:1", null, null, null, "balanced", null, null, null, null, null, null, 4)',
        '!buildSchematic("pack2:2:1", null, null, null, "raise", null, null, null, "all")',
    ]) {
        await agent.handleMessage('Sunny26639', command);
        assert.match(await commands.executeCommand(agent, command), /error/i);
    }
    assert.equal(calls.builds, before); assert.equal(calls.prompts, prompts);
`));

test('managed resume retains the original resolved options when settings change', () => check(`
    settings.schematic_balanced_radius = 6;
    settings.schematic_balanced_strategy = 'bisect';
    settings.schematic_balanced_step = 4;
    settings.schematic_balanced_policy = 'exhaustive';
    settings.schematic_balanced_bisect_depth = 3;
    syncSettings();
    const seen = [];
    let resume, session;
    agent.actions = {
        lastInterruption: { interruptedLabel: 'action:buildSchematic', byActionLabel: 'mode:self_defense' },
        runAction: async (_name, fn) => { await fn(); return { interrupted: true, timedout: false }; },
        registerResume: (_name, fn, options) => { resume = fn; assert.equal(options.guard(), true); },
    };
    globalThis.__schematicBuild = async (_bot, _name, _x, _y, _z, options) => {
        seen.push(options);
        session.context = { placementOptions: options };
        session.resumeEligible = true;
        session.isWorldValid = () => true;
    };
    // The loader does not implement session tracking, so retain the managed context here.
    // Capture the context through the stubbed session bridge.
    globalThis.__setSchematicSession = value => { session = value; };
    await commands.executeCommand(agent, '!buildSchematic("pack2:2:1", null, null, null, null, null, null, "E")');
    settings.schematic_balanced_radius = 12;
    settings.schematic_balanced_strategy = 'all';
    settings.schematic_balanced_step = 1;
    settings.schematic_balanced_policy = 'first_valid';
    settings.schematic_balanced_bisect_depth = 0;
    syncSettings();
    await resume();
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1]);
    assert.equal(seen[1].radius, 6);
    assert.equal(seen[1].orientation, 'east');
    assert.equal(seen[1].strategy, 'bisect');
    assert.equal(seen[1].step, 4);
    assert.equal(seen[1].policy, 'exhaustive');
    assert.equal(seen[1].bisectDepth, 3);
    assert.ok(Object.isFrozen(seen[1]));
`));

test('complete own-addressed schematic request dispatches exactly once, including polite forms', () => check(`
    for (const prefix of ['Andy ', 'Andy: ', '@ANDY, please ', 'Andy, could you please ']) {
        await agent.handleMessage('Sunny26639', prefix + 'build id 01 from group 02 of pack2');
    }
    assert.equal(calls.builds, 4);
    assert.equal(calls.prompts, 0);
    assert.equal(calls.lifecycle.length, 4);
    assert.equal(globalThis.__buildSchematicArgs[1], 'pack2:2:1');
`));

test('addressed requests reject unknown or too-old engines before dispatch', () => check(`
    for (const version of [undefined, 'unknown-release', '1.20.6']) {
        agent.bot.version = version;
        await agent.handleMessage('Sunny26639', 'Andy build id 01 from group 02 of pack2');
        assert.match(calls.routes.at(-1), /could not be resolved/i);
    }
    assert.equal(calls.builds, 0);
`));

test('known/dynamic peers and unknown senders cannot obtain model-generated commands', () => check(`
    settings.allow_insecure_coding = true;
    syncSettings();
    convo.updateAgents([{ name: 'DynamicPeer', in_game: true }]);
    for (const sender of ['Alice', 'DynamicPeer', 'UnknownPeer']) {
        agent.prompter.promptConvo = async () => { calls.prompts++; return '!newAction("build a house")'; };
        await agent.handleMessage(sender, 'please help build');
        await agent.handleMessage(sender, '!buildSchematic("pack2:02:01")');
    }
    assert.equal(calls.generated, 0);
    assert.equal(calls.builds, 0);
    assert.equal(calls.lifecycle.length, 0);
`));

test('direct command quotations and incomplete fragments never execute or reach inference', () => check(`
    for (const message of ['the example is !buildSchematic("pack2:02:01")',
        '!buildSchematic("pack2:02:01"', '!stop(', '!stop() trailing',
        '!buildSchematic("pack2:02:01") !stop', 'Andy: !buildSchematic("pack2:02:01") trailing']) {
        await agent.handleMessage('Sunny26639', message);
    }
    assert.equal(calls.builds, 0);
    assert.equal(calls.prompts, 0);
`));

test('agent-specific blacklist is enforced at dispatch, including model output', () => check(`
    agent.blocked_actions = ['!buildSchematic'];
    const result = await commands.executeCommand(agent, '!buildSchematic("pack2:02:01")');
    assert.match(result, /blocked|unavailable/i);
    agent.prompter.promptConvo = async () => '!buildSchematic("pack2:02:01")';
    await agent.handleMessage('Sunny26639', 'build something');
    await agent.handleMessage('Sunny26639', 'Andy build id 01 from group 02 of pack2');
    assert.equal(calls.builds, 0);
`));

test('disabled insecure coding is absent from docs and examples and cannot be dispatched', () => check(`
    const { Examples } = await import(${url('src/utils/examples.js')});
    const examples = new Examples(null, 10);
    const original = [[{ role: 'assistant', content: '!newAction("test")' }], [{ role: 'assistant', content: '!stats' }]];
    await examples.load(original);
    assert.doesNotMatch(await examples.createExampleMessage([]), /!newAction/);
    assert.equal(original.length, 2);
    assert.equal(commands.commandExists('!newAction'), false);
    assert.doesNotMatch(commands.getCommandDocs(agent), /!newAction/);
    await commands.executeCommand(agent, '!newAction("test")');
    agent.prompter.promptConvo = async () => '!newAction("test")';
    await agent.handleMessage('Sunny26639', 'build something');
    assert.equal(calls.generated, 0);
    settings.allow_insecure_coding = true;
    syncSettings();
    await examples.load(original);
    assert.match(await examples.createExampleMessage([]), /!newAction/);
    const { readFileSync } = await import('node:fs');
    const defaults = JSON.parse(readFileSync(${url('profiles/defaults/_default.json')}.replace('file://', ''), 'utf8'));
    assert.doesNotMatch(defaults.bot_responder, /!newAction/);
    settings.allow_insecure_coding = false; syncSettings();
    await examples.load(defaults.conversation_examples);
    assert.ok(examples.examples.length > 0);
    assert.doesNotMatch(JSON.stringify(examples.examples), /!newAction/);
`));

test('model-generated incomplete zero-argument command does not cancel an action', () => check(`
    let stops = 0;
    agent.actions.stop = async () => { stops++; };
    for (const fragment of ['!stop(', '!stop("unfinished', '!stop(garbage)']) {
        agent.prompter.promptConvo = async () => fragment;
        await agent.handleMessage('Sunny26639', 'hello');
    }
    assert.equal(stops, 0);
`));

test('real event handlers preserve public-chat suppression, whisper delivery, and peer/user filters', () => check(`
    const handlers = {};
    agent.bot.on = (event, handler) => { handlers[event] = handler; };
    await agent._setupEventHandlers(null, null);
    const message = 'Andy build 01 from group 02 of pack2';
    globalThis.__numOtherAgents = 1;
    handlers.chat('Sunny26639', message);
    assert.equal(calls.builds, 0);
    await handlers.whisper('Sunny26639', message);
    assert.equal(calls.builds, 1);
    globalThis.__numOtherAgents = 0;
    handlers.chat('Sunny26639', message);
    for (let i = 0; i < 100 && calls.builds < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls.builds, 2);
    await handlers.whisper('Alice', '!buildSchematic("pack2:02:01")');
    await handlers.whisper('Mallory', '!buildSchematic("pack2:02:01")');
    await handlers.whisper('system', '!buildSchematic("pack2:02:01")');
    settings.only_chat_with = ['SomeoneElse']; syncSettings();
    await handlers.whisper('Sunny26639', 'Andy build 01 from group 02 of pack2');
    assert.equal(calls.builds, 2);
    assert.equal(calls.prompts, 0);
`));

test('direct and routed builds use the real ActionManager and trusted stop cleans up without duplicate dispatch', () => check(`
    const { ActionManager } = await import(${url('src/agent/action_manager.js')});
    agent.actions = new ActionManager(agent);
    for (const message of ['Andy build 01 from group 02 of pack2', '!buildSchematic("pack2:02:01")']) {
        let started, release;
        const start = new Promise(resolve => { started = resolve; });
        const pending = new Promise(resolve => { release = resolve; });
        globalThis.__schematicBuild = async () => { calls.builds++; started(); await pending; };
        agent.requestInterrupt = () => { agent.bot.interrupt_code = true; release(); };
        const build = agent.handleMessage('Sunny26639', message);
        await start;
        assert.equal(agent.actions.executing, true);
        assert.equal(agent.actions.currentActionLabel, 'action:buildSchematic');
        agent.actions.resume_func = () => {};
        await agent.handleMessage('Sunny26639', '!stop');
        await build;
        assert.equal(agent.actions.executing, false);
        assert.equal(agent.actions.currentActionLabel, '');
        assert.equal(agent.actions.resume_func, null);
    }
    assert.equal(calls.builds, 2);
    assert.equal(calls.prompts, 0);
    assert.equal(calls.lifecycle.length, 4);
`));

test('public and private output redact complete and incomplete command tokens', () => check(`
    for (const message of ['!newAction("test")', '!newAction(', '!newAction', 'used !stop']) {
        await Agent.prototype.openChat.call(agent, message);
        settings.only_chat_with = ['Sunny26639']; syncSettings();
        await Agent.prototype.openChat.call(agent, message);
        settings.only_chat_with = []; syncSettings();
    }
    assert.equal(calls.chat.length, 4);
    assert.equal(calls.whisper.length, 4);
    for (const text of [...calls.chat, ...calls.whisper.map(([, text]) => text)]) assert.doesNotMatch(text, /!\\w+/);
`));

test('Docker copies the mandatory postinstall verifier before dependency installation', () => {
    const dockerfile = readFileSync(new URL('Dockerfile', root), 'utf8');
    assert.ok(dockerfile.indexOf('COPY scripts/verify_patch.js ./scripts/') >= 0);
    assert.ok(dockerfile.indexOf('COPY scripts/verify_patch.js ./scripts/') < dockerfile.indexOf('RUN npm install'));
});

test('all five incident requests parse and equivalent synthetic requests dispatch once without replacement', () => check(`
    const incidents = [
        'Alice build id 1 from 3 group of pack1 instead of this unfinished building',
        'Alice build id 1 from 3 group of pack1',
        'Alice build file id 1 from 3 group of pack1',
        'Alice build id 01 from 03 group of pack1',
        'Alice build file id 01 from 03 group of pack1',
    ];
    for (const [index, message] of incidents.entries()) {
        const parsed = router.parseAddressedSchematicRequest(message, 'Alice', ['Andy']);
        assert.equal(parsed?.selector, 'pack1:3:1', message);
        assert.equal(parsed.selectorKind, 'fileId', message);
        assert.equal(parsed.inertReplacementPhrase === true, index === 0, message);
        const synthetic = message.replace('Alice', 'Andy').replace(/from 0?3 group/, 'from 02 group').replace('pack1', 'pack2');
        const before = calls.builds;
        const routesBefore = calls.routes.length;
        await agent.handleMessage('Sunny26639', synthetic);
        assert.equal(calls.builds, before + 1, synthetic);
        assert.equal(globalThis.__buildSchematicArgs[1], 'pack2:2:1', synthetic);
        assert.deepEqual(globalThis.__buildSchematicArgs.slice(2), [null, null, null, { mode: 'delicate', radius: 4, threshold: 9, orientation: 'north', strategy: 'stepped', step: 2, policy: 'first_valid', bisectDepth: 2 }], synthetic);
        assert.deepEqual(calls.lifecycle.at(-1), [false, true], synthetic);
        if (index === 0) assert.match(calls.routes.slice(routesBefore).join(' '), /does not remove or replace.*normal nearby placement/i);
    }
    assert.equal(calls.prompts, 0);
    assert.equal(calls.generated, 0);
`));

test('both numeric group orders compose with existing labels, aliases, hashes, and the exact inert suffix', () => check(`
    for (const alias of ['', 'schema ', 'schem ', 'scheme ', 'schematic ']) {
        for (const label of ['file id ', 'id ', 'file offset ', 'offset ', '']) {
            for (const group of ['group #02', '#02 group']) {
                for (const suffix of ['', ' instead of this unfinished building.', ' INSTEAD OF THIS UNFINISHED BUILDING!']) {
                    const message = 'Andy build a cottage using ' + alias + label + '01 from ' + group + ' of PACK2' + suffix;
                    const parsed = router.parseAddressedSchematicRequest(message, 'Andy');
                    assert.equal(parsed?.selector, 'pack2:2:1', message);
                    assert.equal(parsed.inertReplacementPhrase === true, suffix !== '', message);
                    const before = calls.builds;
                    await agent.handleMessage('Sunny26639', message);
                    assert.equal(calls.builds, before + 1, message);
                }
            }
        }
    }
    assert.equal(calls.prompts, 0);
    assert.equal(calls.generated, 0);
`));

test('alternate numeric order and inert suffix fail closed on malformed, ambiguous, and unsafe requests', () => check(`
    const suffix = ' instead of this unfinished building';
    const valid = 'id 1 from 2 group of pack2';
    const invalid = [
        'id 0 from 2 group of pack2', 'id 1 from 0 group of pack2',
        'id 9007199254740992 from 2 group of pack2', 'id 1 from 9007199254740992 group of pack2',
        'id -1 from 2 group of pack2', 'id 1 from -2 group of pack2',
        'id 1.5 from 2 group of pack2', 'id 1 from 2.5 group of pack2',
        'id 1 from 2junk group of pack2', 'id 1 from two group of pack2',
        '1 from 2 group of pack0', '1 from 2.5 group of pack0', '1 from two group of pack0',
        'id 1 from 2 group 3 of pack2',
        'id 1 from group 2 group of pack2', 'id 1 from 2 group of pack2/../outside',
        valid + ' and id 1 from 2 group of pack2' + suffix,
        'id 1 from group 2 of pack2 and ' + valid + suffix,
        'file pack2/../outside.schem and ' + valid + suffix,
        valid + suffix + ' and id 1 from 2 group of pack2',
        valid + suffix + ' then build a tower', valid + suffix + ' at 1 2 3',
        valid + suffix + '; !stop()', valid + suffix + '/../../outside',
        valid + ' instead of this unfinished building 2',
        valid + ' instead of this unfinished house',
        valid + ' instead of this unfinished building and remove it',
        'file name 09_garden of pack2' + suffix,
        valid + ' "instead of this unfinished building"',
        '"' + valid + suffix + '"',
    ];
    for (const target of invalid) {
        const message = 'Andy build ' + target;
        assert.ok(router.parseAddressedSchematicRequest(message, 'Andy')?.error, message);
        const before = [calls.builds, calls.prompts, calls.generated, calls.lifecycle.length];
        await agent.handleMessage('Sunny26639', message);
        assert.deepEqual([calls.builds, calls.prompts, calls.generated, calls.lifecycle.length], before, message);
    }
    for (const source of ['Mallory', 'Alice']) {
        await agent.handleMessage(source, 'Andy build ' + valid + suffix);
        assert.match(calls.routes.at(-1), /trusted command senders/);
    }
    agent.blocked_actions = ['!buildSchematic'];
    await agent.handleMessage('Sunny26639', 'Andy build ' + valid + suffix);
    assert.match(calls.routes.at(-1), /blocked/);
    agent.blocked_actions = [];
    await agent.handleMessage('Sunny26639', 'Alice build ' + valid + suffix);
    await agent.handleMessage('Sunny26639', 'Andy build id 999 from 2 group of pack2' + suffix);
    assert.match(calls.routes.at(-1), /could not be resolved/);
    agent.bot.version = 'unknown-release';
    await agent.handleMessage('Sunny26639', 'Andy build ' + valid + suffix);
    assert.match(calls.routes.at(-1), /could not be resolved/);
    assert.equal(calls.builds, 0);
    assert.equal(calls.prompts, 0);
`));

test('unsupported replacement wording is rejected with explicit nearby-build guidance', () => check(`
    const message = 'Andy build id 1 from 2 group of pack2 instead of this unfinished barn';
    const parsed = router.parseAddressedSchematicRequest(message, 'Andy');
    assert.match(parsed.error, /cannot replace an existing building/i);
    assert.match(parsed.error, /bare selector.*ordinary nearby build.*not a replacement/i);
    const before = [calls.builds, calls.prompts, calls.generated, calls.lifecycle.length];
    await agent.handleMessage('Sunny26639', message);
    assert.deepEqual([calls.builds, calls.prompts, calls.generated, calls.lifecycle.length], before);
    assert.match(calls.routes.at(-1), /cannot replace an existing building/i);
    assert.equal(router.parseAddressedSchematicRequest('Andy build id 1 from 2 group of pack2 instead of this unfinished building', 'Andy').inertReplacementPhrase, true);
`));

test('replacement intent before or after every selector form fails closed without commands or inference', () => check(`
    const repro = router.parseAddressedSchematicRequest('Alice build instead of this unfinished barn id 1 from group 3 of pack1', 'Alice');
    assert.match(repro?.error ?? '', /cannot replace an existing building/i);
    const selectors = [
        'id 1 from group 2 of pack2', 'file id 01 from 02 group of pack2',
        'offset 1 from group 2 of pack2', '1 from 2 group of pack2',
        'schematic id 1 from group 2 of pack2', 'schema file id 1 from 2 group of pack2',
        'file name 09_garden of pack2', 'file pack2/09_garden',
        'schem 09_garden of pack2', 'scheme pack2/09_garden.schem',
    ];
    const intents = [
        'instead of this unfinished barn', 'instead of this unfinished building',
        'instead of the old house', 'in place of that structure',
        'as a replacement for our unfinished barn', 'to replace this barn',
        'replacement of the old barn', 'demolition of this unfinished barn',
        'a replacement of our old house', 'after demolition of that structure',
        'replacing the old house', 'replace the ugly red barn',
        'to demolish this building', 'after demolishing the old barn',
        'after tearing down that barn', 'knock down the old house',
        'remove the existing structure', 'clear this building',
        'build over the old barn', 'on top of this unfinished house',
        'instead of it', 'to replace it', 'a replacement for the barn',
        'instead of unfinished barn', 'replace existing barn', 'demolish old barn',
        'in place of the unfinished construction', 'rebuild this cabin',
        'rather than this unfinished barn', 'over this unfinished barn',
        'tear this old barn down', 'take the old house down',
        'clear away this structure', 'get rid of this building',
        'INSTEAD OF THIS UNFINISHED BARN',
        'a cottage "instead of this unfinished barn"',
        "instead of 'this unfinished barn'", 'instead of: this unfinished barn',
        'replace-this-barn', 'instead of this, unfinished barn',
    ];
    for (const selector of selectors) {
        for (const intent of intents) {
            for (const target of [intent + ' using ' + selector, selector + ' ' + intent]) {
                // Only the already-supported exact numeric trailing phrase remains inert.
                if (intent === 'instead of this unfinished building' && target === selector + ' ' + intent
                    && !selector.includes('09_garden')) continue;
                const message = 'Andy build ' + target + '.';
                const parsed = router.parseAddressedSchematicRequest(message, 'Andy');
                assert.match(parsed?.error ?? '', /cannot replace an existing building/i, message);
                const before = [calls.builds, calls.prompts, calls.generated, calls.lifecycle.length];
                const routesBefore = calls.routes.length;
                await agent.handleMessage('Sunny26639', message);
                assert.deepEqual([calls.builds, calls.prompts, calls.generated, calls.lifecycle.length], before, message);
                assert.equal(calls.routes.length, routesBefore + 1, message);
                assert.match(calls.routes.at(-1), /not a replacement/i, message);
            }
        }
    }
`));

test('audit noun-form repros and selector-free replacement requests never reach ordinary dispatch or inference', () => check(`
    const messages = [
        'Andy build replacement of the old barn id 1 from group 2 of pack2',
        'Andy build demolition of this unfinished barn id 1 from group 2 of pack2',
        'Andy build replace this unfinished barn',
    ];
    for (const intent of [
        'replace this unfinished barn', 'replacement of the old barn',
        'demolish this unfinished barn', 'demolition of this unfinished barn',
        'rebuild the old house', 'remove this building', 'tear the old barn down',
    ]) {
        for (const prefix of ['Andy build ', '@Andy: could you please build ', 'Andy ', 'Andy please ']) {
            // Noun-led descriptions alone are not clear imperative requests.
            if (!prefix.includes('build') && /^(?:replacement|demolition) of/.test(intent)) continue;
            for (const selector of ['', ' id 1 from group 2 of pack2', ' using file name 09_garden of pack2']) {
                messages.push(prefix + intent + selector);
            }
        }
    }
    for (const message of [...messages,
        'Andy build "replacement of the old barn"',
        'Andy build a cottage "demolition of this unfinished barn"',
        'Andy build instead of this unfinished building',
    ]) {
        const parsed = router.parseAddressedSchematicRequest(message, 'Andy');
        assert.match(parsed?.error ?? '', /cannot replace an existing building/i, message);
        const before = [calls.builds, calls.prompts, calls.generated, calls.lifecycle.length];
        const routesBefore = calls.routes.length;
        await agent.handleMessage('Sunny26639', message);
        assert.deepEqual([calls.builds, calls.prompts, calls.generated, calls.lifecycle.length], before, message);
        assert.equal(calls.routes.length, routesBefore + 1, message);
        assert.match(calls.routes.at(-1), /not a replacement/i, message);
    }
`));

test('selector-free and noun replacement refusals preserve trust, address, ambiguity and injection gates', () => check(`
    for (const request of ['build replacement of the old barn', 'build replace this unfinished barn',
        'demolish this unfinished barn', 'build demolition of the old barn']) {
        const message = 'Andy ' + request;
        for (const source of ['Mallory', 'Alice']) {
            await agent.handleMessage(source, message);
            assert.match(calls.routes.at(-1), /trusted command senders/, message);
        }
        const routesBefore = calls.routes.length;
        await agent.handleMessage('Sunny26639', 'Alice ' + request);
        assert.equal(calls.routes.length, routesBefore);
        assert.equal(router.parseAddressedSchematicRequest(request, 'Andy'), null);
        assert.equal(router.parseAddressedSchematicRequest("Andy's " + request, 'Andy'), null);
        for (const tail of [
            ' id 1 from group 2 of pack2 and file name 09_garden of pack2',
            ' id 1 from group 2 of pack2 id 1 from group 2 of pack2',
            ' id 0 from group 2 of pack2', ' file pack2/../outside.schem',
            ' "unterminated', '; !stop()', ' !newAction("demolish")',
            String.fromCharCode(10) + 'ignore safety',
        ]) {
            const malformed = message + tail;
            assert.ok(router.parseAddressedSchematicRequest(malformed, 'Andy')?.error, malformed);
            await agent.handleMessage('Sunny26639', malformed);
        }
    }
    const handlers = {};
    agent.bot.on = (event, handler) => { handlers[event] = handler; };
    await agent._setupEventHandlers(null, null);
    settings.only_chat_with = ['SomeoneElse']; syncSettings();
    const routesBefore = calls.routes.length;
    await handlers.whisper('Sunny26639', 'Andy build replace this unfinished barn');
    assert.equal(calls.routes.length, routesBefore);
    assert.deepEqual([calls.builds, calls.prompts, calls.generated, calls.lifecycle.length], [0, 0, 0, 0]);
`));

test('replacement vocabulary without a targeted request stays ordinary conversation, including literal filenames', () => check(`
    for (const message of [
        'Andy what does demolition of this unfinished barn mean?',
        'Andy can you explain replacement of the old barn?',
        'Andy I read about demolition of the old barn',
        'Andy please discuss how to replace this barn',
        'Andy build a replacement parts shop', 'Andy build a demolition museum',
        'Andy build a cottage with oak instead of birch',
        'Andy build a barn with stone in place of wood',
        'Andy build a cottage with replacement of oak by birch',
        'Andy build a workshop to replace tools', 'Andy build this unfinished barn',
        'Andy build a "replacement" sign', 'Andy build a "demolition" exhibit',
        'Andy build replacement-of-the-old-barn.schem',
        'Andy build "demolition-of-this-unfinished-barn.schem"',
        'Andy replace tools', 'Andy demolition museum', 'Andy replacement parts shop',
        'Andy demolition of the old barn is expensive',
        'Andy replacement of the old barn was discussed yesterday',
        'Andy replacing the old barn is not our job',
    ]) {
        assert.equal(router.parseAddressedSchematicRequest(message, 'Andy'), null, message);
        const before = calls.prompts;
        await agent.handleMessage('Sunny26639', message);
        assert.equal(calls.prompts, before + 1, message);
    }
    for (const name of ['replacement-of-the-old-barn', 'demolition-of-this-unfinished-barn.schem']) {
        for (const selector of ['file name ' + name + ' of pack2', 'file pack2/' + name]) {
            const parsed = router.parseAddressedSchematicRequest('Andy build ' + selector, 'Andy');
            assert.equal(parsed?.selector, 'pack2:' + name);
            assert.equal(parsed.error, undefined);
            // A filename alone cannot turn a non-build directive into a build.
            assert.equal(router.parseAddressedSchematicRequest('Andy replace ' + selector, 'Andy'), null);
        }
    }
    assert.deepEqual([calls.builds, calls.generated, calls.lifecycle.length], [0, 0, 0]);
`));

test('the exact inert suffix cannot whitelist replacement prefixes or malformed and ambiguous selectors', () => check(`
    const valid = 'id 1 from group 2 of pack2';
    const suffix = ' instead of this unfinished building';
    for (const target of [
        'instead of this unfinished barn ' + valid + suffix,
        'replace this building using ' + valid + suffix,
        'replacement of the old barn ' + valid + suffix,
        'demolition of this unfinished barn ' + valid + suffix,
        '"instead of this unfinished building" ' + valid + suffix,
        valid + suffix + ' and remove it', valid + suffix + ' 2',
        'instead of this barn id 0 from group 2 of pack2',
        'instead of this barn id 1 from two group of pack2',
        'instead of this barn id 1 from group 2 of pack0',
        'instead of this barn file pack2/../outside.schem',
        'instead of this barn file pack2/09_garden and ' + valid,
        valid + ' and ' + valid + suffix,
        'instead of this barn "unterminated ' + valid,
        'instead of this barn ' + valid + '; !stop()',
    ]) {
        const message = 'Andy build ' + target;
        assert.ok(router.parseAddressedSchematicRequest(message, 'Andy')?.error, message);
        const before = [calls.builds, calls.prompts, calls.generated, calls.lifecycle.length];
        await agent.handleMessage('Sunny26639', message);
        assert.deepEqual([calls.builds, calls.prompts, calls.generated, calls.lifecycle.length], before, message);
    }
`));

test('benign building descriptions and material alternatives remain inert, and filenames are not instructions', () => check(`
    for (const description of [
        'a barn', 'this unfinished barn', 'an old house', 'an existing building design',
        'a cottage with oak instead of birch', 'a barn with stone in place of wood',
        'a workshop to replace tools', 'a demolition museum', 'a replacement parts shop',
        'a cottage with replacement of oak by birch',
        'a lookout over a barn', 'a tower on top of a cottage',
        'a "replace" sign on a barn', 'a "file id schema scheme" cottage',
    ]) {
        for (const selector of ['id 1 from group 2 of pack2', 'file name 09_garden of pack2']) {
            const message = 'Andy build ' + description + ' using ' + selector;
            assert.ok(router.parseAddressedSchematicRequest(message, 'Andy')?.selector, message);
            const before = calls.builds;
            await agent.handleMessage('Sunny26639', message);
            assert.equal(calls.builds, before + 1, message);
        }
    }
    for (const name of ['replace', 'demolish', 'replacement_barn', 'instead-of-this-unfinished-barn']) {
        const message = 'Andy build file name ' + name + ' of pack2';
        assert.equal(router.parseAddressedSchematicRequest(message, 'Andy')?.selector, 'pack2:' + name, message);
    }
    assert.equal(calls.prompts, 0);
    assert.equal(calls.generated, 0);
`));

test('replacement rejection preserves sender and addressee gates and the exact warning precedes dispatch', () => check(`
    const rejected = 'Andy build instead of this barn id 1 from group 2 of pack2';
    for (const source of ['Mallory', 'Alice']) {
        await agent.handleMessage(source, rejected);
        assert.match(calls.routes.at(-1), /trusted command senders/);
    }
    const routesBefore = calls.routes.length;
    await agent.handleMessage('Sunny26639', rejected.replace('Andy', 'Alice'));
    assert.equal(calls.routes.length, routesBefore);
    const handlers = {};
    agent.bot.on = (event, handler) => { handlers[event] = handler; };
    await agent._setupEventHandlers(null, null);
    settings.only_chat_with = ['SomeoneElse']; syncSettings();
    await handlers.whisper('Sunny26639', rejected);
    assert.equal(calls.routes.length, routesBefore);
    assert.equal(calls.builds, 0);
    assert.equal(calls.lifecycle.length, 0);
    settings.only_chat_with = []; syncSettings();
    globalThis.__schematicBuild = async () => {
        assert.ok(calls.routes.some(text => /does not remove or replace.*normal nearby placement/i.test(text)));
        calls.builds++;
    };
    await agent.handleMessage('Sunny26639', 'Andy build a barn id 1 from 2 group of pack2 instead of this unfinished building!');
    assert.equal(calls.builds, 1);
    assert.equal(calls.lifecycle.length, 1);
    assert.equal(calls.prompts, 0);
`));

test('every schematic alias composes with full/short labels, filename layouts, and inert descriptions in the real handler', () => check(`
    const stem = '09_garden';
    let count = 0;
    for (const alias of ['', 'schema ', 'schem ', 'scheme ', 'schematic ']) {
        const targets = [
            ...['file id ', 'id ', 'file offset ', 'offset ', ''].map(label =>
                [label + '01 from group 02 of PACK2', 'pack2:2:1', 'fileId']),
            ...['file name ', 'file '].flatMap(label => [
                [label + stem + ' of PACK2', 'pack2:' + stem, 'fileName'],
                [label + 'PACK2/' + stem + '.schem', 'pack2:' + stem + '.schem', 'fileName'],
            ]),
            ...(alias ? [[stem + ' of PACK2', 'pack2:' + stem, 'fileName'],
                ['PACK2/' + stem, 'pack2:' + stem, 'fileName'],
                ['name ' + stem + ' of PACK2', 'pack2:' + stem, 'fileName'],
                ['name PACK2/' + stem, 'pack2:' + stem, 'fileName']] : []),
        ];
        for (const description of ['', 'a balloon ', 'a balloon using ', 'a balloon via ', 'a "file id schema scheme" balloon ']) {
            for (const [target, selector, selectorKind] of targets) {
                const message = 'Andy build ' + description + alias + target;
                const parsed = router.parseAddressedSchematicRequest(message, 'Andy');
                assert.equal(parsed?.selector, selector, message);
                assert.equal(parsed.selectorKind, selectorKind, message);
                if (selectorKind === 'fileId') {
                    assert.equal(parsed.fileId, 1);
                    assert.equal(parsed.id, parsed.fileId);
                    assert.equal(Object.hasOwn(parsed, 'fileName'), false);
                } else {
                    assert.equal(parsed.fileName, parsed.filename);
                    assert.equal(Object.hasOwn(parsed, 'fileId'), false);
                }
                const before = calls.builds;
                await agent.handleMessage('Sunny26639', message);
                assert.equal(calls.builds, before + 1, message);
                assert.equal(globalThis.__buildSchematicArgs[1], selector, message);
                assert.deepEqual(calls.lifecycle.at(-1), [false, true], message);
                count++;
            }
        }
    }
    assert.equal(count, 305);
    for (const target of ['file id #01 from group #02 of pack2', 'id #01 from group 02 of pack2',
        'file offset #01 from group #02 of pack2', 'offset #01 from group 02 of pack2',
        '01 from group #02 of pack2', 'schema #01 from group #02 of pack2']) {
        const message = 'Andy build ' + target;
        assert.equal(router.parseAddressedSchematicRequest(message, 'Andy')?.selector, 'pack2:2:1', message);
        const before = calls.builds;
        await agent.handleMessage('Sunny26639', message);
        assert.equal(calls.builds, before + 1, message);
    }
    const beforeBareHash = calls.builds;
    await agent.handleMessage('Sunny26639', 'Andy build #01 from group 02 of pack2');
    assert.equal(calls.builds, beforeBareHash);
    assert.equal(calls.prompts, 0);
    assert.equal(calls.generated, 0);
`));

test('aliases fail closed for overlapping selectors, bad boundaries, missing files, and injection without model fallback', () => check(`
    for (const alias of ['schema', 'schem', 'scheme', 'schematic']) {
        const invalid = [
            alias, alias + ' file', alias + ' file name', alias + ' file id nope',
            alias + ' file id 0 from group 2 of pack2',
            alias + ' file id 1 from group 0 of pack2',
            alias + ' file id 9007199254740992 from group 2 of pack2',
            alias + ' file id 1 from group 2 of pack0',
            alias + ' file id 1 from group 2 of pack2 then build a tower',
            alias + ' file id 1 from group 2 of pack2 and file id 1 from group 2 of pack2',
            alias + ' file name 09_garden of pack2 and id 1 from group 2 of pack2',
            alias + ' file file name 09_garden of pack2',
            alias + ' file id id 1 from group 2 of pack2',
            alias + 'x file id 1 from group 2 of pack2 trailing',
            '-' + alias + ' file name 09_garden of pack2',
            alias + ' pack2/../outside.schem',
            alias + ' file name 09_garden of pack2; !stop()',
            alias + ' file name 09_garden of pack2 at 1 2 3',
            alias + ' file name 02_BEE_hot_air_balloon.schem of pack2',
            alias + ' file name 09_garden.SCHEM of pack2',
            alias + ' file name nonexistent.schem of pack2',
            alias + ' file name nonexistent.schematic of pack2',
            alias + ' file name nonexistent.litematic of pack2',
            alias + ' id 999 from group 2 of pack2',
            alias + ' file name pack2/02-01',
        ];
        for (const target of invalid) {
            const message = 'Andy build ' + target;
            assert.ok(router.parseAddressedSchematicRequest(message, 'Andy'), message);
            const before = [calls.builds, calls.prompts, calls.generated, calls.lifecycle.length];
            await agent.handleMessage('Sunny26639', message);
            assert.deepEqual([calls.builds, calls.prompts, calls.generated, calls.lifecycle.length], before, message);
        }
        for (const source of ['Mallory', 'Alice']) {
            for (const target of [alias + ' file id 1 from group 2 of pack2',
                alias + ' file name 09_garden of pack2',
                alias + ' pack2/09_garden']) {
                await agent.handleMessage(source, 'Andy build ' + target);
                assert.match(calls.routes.at(-1), /trusted command senders/);
            }
        }
        agent.blocked_actions = ['!buildSchematic'];
        await agent.handleMessage('Sunny26639', 'Andy build ' + alias + ' id 1 from group 2 of pack2');
        assert.match(calls.routes.at(-1), /blocked/);
        agent.blocked_actions = [];
        await agent.handleMessage('Sunny26639', 'Alice build ' + alias + ' pack2/09_garden');
    }
    assert.equal(calls.builds, 0);
    assert.equal(calls.prompts, 0);
    assert.equal(calls.generated, 0);
`));

test('ordinary color scheme and database schema chat retains inference, not schematic dispatch', () => check(`
    for (const message of ['Andy build a color scheme', 'Andy build a colour scheme for my house',
        'Andy build a database schema', 'Andy build a database schema for my app',
        'Andy build a schema of my database', 'Andy build a schematic of my house',
        'Andy build a file cabinet', 'Andy build an identity monument']) {
        assert.equal(router.parseAddressedSchematicRequest(message, 'Andy'), null, message);
        const before = calls.prompts;
        await agent.handleMessage('Sunny26639', message);
        assert.equal(calls.prompts, before + 1, message);
    }
    assert.equal(calls.builds, 0);
`));

test('reserved filenames, exact case, extensions, and compatibility fields preserve literal/indexed resolution', () => check(`
    const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { resolveSchematicPath, listSchematicEntries, SCHEMATICS_DIR } = await import(${url('src/utils/schematic/paths.js')});
    const { writeFixtureProvenance } = await import(${url('test/schematic/provenance_fixture.js')});
    const { syntheticSponge } = await import(${url('test/schematic/synthetic_sponge.js')});
    const options = { version: '1.21.4', allowNonvalidatedSchematic: true };
    const directory = await mkdtemp(path.join(tmpdir(), 'mindcraft-request-review-'));
    try {
        const pack = path.join(directory, 'schems/pack2');
        await mkdir(pack, { recursive: true });
        for (const fileName of ['id.schem', 'name.schem', 'UPPER.SCHEM', '123.schem', 'legacy.schematic', 'convert.litematic']) {
            await writeFile(path.join(pack, fileName), 'path-only test fixture');
        }
        const bytes = syntheticSponge();
        for (const stem of ['id', 'name', '123']) {
            const file = path.join(pack, stem + '.mc1.21.4.schem');
            await writeFile(file, bytes); writeFixtureProvenance(file, bytes);
        }
        await writeFile(path.join(pack, 'index.json'), JSON.stringify({ schemaVersion: 2, groups: {
            2: { 1: 'name.schem', 7: 'id.schem' },
        } }));
        assert.equal(await resolveSchematicPath('pack2:2:1', directory, options), path.join(pack, 'name.mc1.21.4.schem'));
        assert.equal(await resolveSchematicPath('pack2:02:07', directory, options), path.join(pack, 'id.mc1.21.4.schem'));
        await assert.rejects(resolveSchematicPath('pack2:02-01', directory, options));
        await assert.rejects(resolveSchematicPath('schems/pack2/../pack2/id.schem', directory, options));
        for (const alias of ['', 'schema ', 'schem ', 'scheme ', 'schematic ']) {
            for (const fileName of ['id', 'name', 'UPPER.SCHEM', '123.schem', 'legacy.schematic', 'convert.litematic']) {
                for (const target of ['file name ' + fileName + ' of PACK2', 'file name PACK2/' + fileName]) {
                    const message = 'Andy build ' + alias + target;
                    const parsed = router.parseAddressedSchematicRequest(message, 'Andy');
                    assert.equal(parsed?.fileName, fileName, message);
                    assert.equal(parsed.filename, fileName, message);
                    assert.equal(parsed.selectorKind, 'fileName', message);
                    assert.equal(Object.hasOwn(parsed, 'fileId'), false, message);
                    if (['id', 'name', '123.schem'].includes(fileName)) {
                        const stem = fileName === '123.schem' ? '123' : fileName;
                        assert.equal(await resolveSchematicPath(parsed.selector, directory, options), path.join(pack, stem + '.mc1.21.4.schem'), message);
                    } else await assert.rejects(resolveSchematicPath(parsed.selector, directory, options));
                }
            }
        }
        for (const selector of ['pack2:upper.SCHEM', 'pack2:UPPER.schem', 'pack2:123']) {
            await assert.rejects(resolveSchematicPath(selector, directory, options));
        }
        const entries = await listSchematicEntries(directory, options);
        assert.equal(entries.length, 3);
        assert.deepEqual(entries.slice(0, 2).map(({ fileId, fileName }) => [fileId, fileName]), [[1, 'name.mc1.21.4.schem'], [7, 'id.mc1.21.4.schem']]);
        assert.ok(entries.every(entry => entry.fileId === entry.id && entry.fileName === entry.filename));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
`));

test('non-BMP description characters do not shift quoted escape boundaries in the real handler', () => check(`
    const slash = String.fromCharCode(92);
    for (const description of ['"' + slash + slash + '" cottage',
        '😀😀 "' + slash + slash + '" cottage',
        '😀😀 "a ' + slash + '"file' + slash + '"" cottage']) {
        const message = 'Andy build ' + description + ' file id 1 from group 2 of pack2';
        assert.equal(router.parseAddressedSchematicRequest(message, 'Andy')?.selector, 'pack2:2:1', message);
        const before = calls.builds;
        await agent.handleMessage('Sunny26639', message);
        assert.equal(calls.builds, before + 1, message);
    }
    for (const description of ['"reserved words" ' + slash + ' cottage',
        '😀😀 "reserved words" ' + slash + ' cottage']) {
        const message = 'Andy build ' + description + ' file id 1 from group 2 of pack2';
        assert.match(router.parseAddressedSchematicRequest(message, 'Andy')?.error ?? '', /command fragments/, message);
        const before = calls.builds;
        await agent.handleMessage('Sunny26639', message);
        assert.equal(calls.builds, before, message);
    }
    assert.equal(calls.prompts, 0);
`));
