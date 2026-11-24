import { createRoutingFixture } from "./routing_fixture.js";
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

test('actual Andy/Alice settings authorize only the observed human, preserving security values and blacklist', async () => {
    for (const bot of ['andy', 'alice']) {
        const settings = (await import(new URL(`settings-${bot}.js`, root))).default;
        assert.deepEqual(settings.trusted_command_senders, ['Sunny26639']);
        assert.equal(settings.allow_insecure_coding, true);
        assert.equal(settings.auth, 'offline');
        assert.deepEqual(settings.known_bot_peers, [bot === 'andy' ? 'Alice' : 'Andy']);
        assert.deepEqual(settings.blocked_actions, ['!checkBlueprint', '!checkBlueprintLevel', '!getBlueprint', '!getBlueprintLevel']);
    }
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
        const actual = (await import(new URL('settings-' + name.toLowerCase() + '.js', ${url('')}))).default;
        Object.assign(settings, actual); syncSettings();
        agent.name = name;
        agent.blocked_actions = actual.blocked_actions;
        const before = calls.builds;
        await agent.handleMessage('Sunny26639', name + ' build 01 from group 02 of pack2');
        await agent.handleMessage('Sunny26639', '!buildSchematic("pack2:02:01")');
        for (const sender of [...actual.known_bot_peers, 'OtherPlayer']) {
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
    const handled = [];
    let publicCompletion;
    agent.handleMessage = (...args) => {
        handled.push(args);
        const result = Agent.prototype.handleMessage.apply(agent, args);
        if (publicCompletion) result.then(publicCompletion.resolve, publicCompletion.reject);
        return result;
    };
    agent.bot.on = (event, handler) => { handlers[event] = handler; };
    await agent._setupEventHandlers(null, null);
    const message = 'Andy build 01 from group 02 of pack2';
    globalThis.__numOtherAgents = 1;
    handlers.chat('Sunny26639', message);
    assert.deepEqual(handled, []);
    assert.equal(calls.builds, 0);
    await handlers.whisper('Sunny26639', message);
    assert.equal(calls.builds, 1);
    globalThis.__numOtherAgents = 0;
    let deadline;
    const completed = new Promise((resolve, reject) => {
        publicCompletion = { resolve, reject };
        deadline = setTimeout(() => reject(new Error('Timed out waiting for public-chat message handling')), 5000);
    });
    try {
        handlers.chat('Sunny26639', message);
        await completed;
    } finally {
        clearTimeout(deadline);
        publicCompletion = null;
    }
    assert.equal(calls.builds, 2);
    assert.deepEqual(handled, [['Sunny26639', message], ['Sunny26639', message]]);
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
        assert.deepEqual(globalThis.__buildSchematicArgs.slice(2), [null, null, null], synthetic);
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
    ];
    for (const target of invalid) {
        const message = 'Andy build ' + target;
        assert.ok(router.parseAddressedSchematicRequest(message, 'Andy')?.error, message);
        const before = [calls.builds, calls.prompts, calls.generated, calls.lifecycle.length];
        await agent.handleMessage('Sunny26639', message);
        assert.deepEqual([calls.builds, calls.prompts, calls.generated, calls.lifecycle.length], before, message);
    }
    assert.equal(router.parseAddressedSchematicRequest('Andy build "' + valid + suffix + '"', 'Andy'), null);
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
