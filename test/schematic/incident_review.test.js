import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const url = path => JSON.stringify(new URL(path, root).href);
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
    const child = spawnSync(process.execPath, ['--experimental-loader', loader, '--input-type=module', '-e', script], { encoding: 'utf8' });
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
    for (const message of ['Alice build a house', 'Alice: please build id 01 from group 02 of pack1',
        'Alice:!buildSchematic("pack1:02:01")', '@alice!stop', 'Alice, hello', 'DynamicPeer build a house']) {
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
        await agent.handleMessage('Sunny26639', name + ' build 01 from group 02 of pack1');
        await agent.handleMessage('Sunny26639', '!buildSchematic("pack1:02:01")');
        for (const sender of [...actual.known_bot_peers, 'OtherPlayer']) {
            await agent.handleMessage(sender, name + ' build 01 from group 02 of pack1');
            await agent.handleMessage(sender, '!buildSchematic("pack1:02:01")');
        }
        assert.equal(calls.builds - before, 2);
        assert.equal(calls.generated, 0);
    }
`));

test('malformed, contradictory, and additional schematic input fails closed rather than partially matching', () => check(`
    for (const text of ['build id 01.5 from group 02 of pack1', 'build id 01 from group 02.5 of pack1',
        'build id 01junk from group 02 of pack1', 'build 02 id 01 from group 02 of pack1',
        'build id -01 from group 02 of pack1', 'build id 01 from group -02 of pack1',
        'build id 01 from group 02 of pack1 at 100 64 100',
        'please build id 01 from group two of pack1', 'build id 01 from group 02 of pack0',
        'build id 01 from group 02 of pack1 !stop', 'build schematic']) {
        const request = router.parseAddressedSchematicRequest('Andy ' + text, 'Andy', ['Alice']);
        assert.ok(request?.error, text + ' must be rejected');
        await agent.handleMessage('Sunny26639', 'Andy ' + text);
    }
    assert.equal(calls.builds, 0);
    assert.equal(calls.prompts, 0);
`));

test('complete own-addressed schematic request dispatches exactly once, including polite forms', () => check(`
    for (const prefix of ['Andy ', 'Andy: ', '@ANDY, please ', 'Andy, could you please ']) {
        await agent.handleMessage('Sunny26639', prefix + 'build id 01 from group 02 of pack1');
    }
    assert.equal(calls.builds, 4);
    assert.equal(calls.prompts, 0);
    assert.equal(calls.lifecycle.length, 4);
    assert.equal(globalThis.__buildSchematicArgs[1], 'pack1:2:1');
`));

test('addressed requests reject unknown or too-old engines before dispatch', () => check(`
    for (const version of [undefined, 'unknown-release', '1.20.6']) {
        agent.bot.version = version;
        await agent.handleMessage('Sunny26639', 'Andy build id 01 from group 02 of pack1');
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
        await agent.handleMessage(sender, '!buildSchematic("pack1:02:01")');
    }
    assert.equal(calls.generated, 0);
    assert.equal(calls.builds, 0);
    assert.equal(calls.lifecycle.length, 0);
`));

test('direct command quotations and incomplete fragments never execute or reach inference', () => check(`
    for (const message of ['the example is !buildSchematic("pack1:02:01")',
        '!buildSchematic("pack1:02:01"', '!stop(', '!stop() trailing',
        '!buildSchematic("pack1:02:01") !stop', 'Andy: !buildSchematic("pack1:02:01") trailing']) {
        await agent.handleMessage('Sunny26639', message);
    }
    assert.equal(calls.builds, 0);
    assert.equal(calls.prompts, 0);
`));

test('agent-specific blacklist is enforced at dispatch, including model output', () => check(`
    agent.blocked_actions = ['!buildSchematic'];
    const result = await commands.executeCommand(agent, '!buildSchematic("pack1:02:01")');
    assert.match(result, /blocked|unavailable/i);
    agent.prompter.promptConvo = async () => '!buildSchematic("pack1:02:01")';
    await agent.handleMessage('Sunny26639', 'build something');
    await agent.handleMessage('Sunny26639', 'Andy build id 01 from group 02 of pack1');
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
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));
    globalThis.__numOtherAgents = 1;
    handlers.chat('Sunny26639', 'Andy build 01 from group 02 of pack1');
    await settle();
    assert.equal(calls.builds, 0);
    await handlers.whisper('Sunny26639', 'Andy build 01 from group 02 of pack1');
    assert.equal(calls.builds, 1);
    globalThis.__numOtherAgents = 0;
    handlers.chat('Sunny26639', 'Andy build 01 from group 02 of pack1');
    await settle();
    assert.equal(calls.builds, 2);
    await handlers.whisper('Alice', '!buildSchematic("pack1:02:01")');
    await handlers.whisper('Mallory', '!buildSchematic("pack1:02:01")');
    await handlers.whisper('system', '!buildSchematic("pack1:02:01")');
    settings.only_chat_with = ['SomeoneElse']; syncSettings();
    await handlers.whisper('Sunny26639', 'Andy build 01 from group 02 of pack1');
    assert.equal(calls.builds, 2);
    assert.equal(calls.prompts, 0);
`));

test('direct and routed builds use the real ActionManager and trusted stop cleans up without duplicate dispatch', () => check(`
    const { ActionManager } = await import(${url('src/agent/action_manager.js')});
    agent.actions = new ActionManager(agent);
    for (const message of ['Andy build 01 from group 02 of pack1', '!buildSchematic("pack1:02:01")']) {
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

test('every schematic alias composes with full/short labels, filename layouts, and inert descriptions in the real handler', () => check(`
    const stem = '02_bee_hot_air_balloon';
    let count = 0;
    for (const alias of ['', 'schema ', 'schem ', 'scheme ', 'schematic ']) {
        const targets = [
            ...['file id ', 'id ', 'file offset ', 'offset ', ''].map(label =>
                [label + '01 from group 02 of PACK1', 'pack1:2:1', 'fileId']),
            ...['file name ', 'file '].flatMap(label => [
                [label + stem + ' of PACK1', 'pack1:' + stem, 'fileName'],
                [label + 'PACK1/' + stem + '.schem', 'pack1:' + stem + '.schem', 'fileName'],
            ]),
            ...(alias ? [[stem + ' of PACK1', 'pack1:' + stem, 'fileName'],
                ['PACK1/' + stem, 'pack1:' + stem, 'fileName'],
                ['name ' + stem + ' of PACK1', 'pack1:' + stem, 'fileName'],
                ['name PACK1/' + stem, 'pack1:' + stem, 'fileName']] : []),
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
    for (const target of ['file id #01 from group #02 of pack1', 'id #01 from group 02 of pack1',
        'file offset #01 from group #02 of pack1', 'offset #01 from group 02 of pack1',
        '01 from group #02 of pack1', 'schema #01 from group #02 of pack1']) {
        const message = 'Andy build ' + target;
        assert.equal(router.parseAddressedSchematicRequest(message, 'Andy')?.selector, 'pack1:2:1', message);
        const before = calls.builds;
        await agent.handleMessage('Sunny26639', message);
        assert.equal(calls.builds, before + 1, message);
    }
    const beforeBareHash = calls.builds;
    await agent.handleMessage('Sunny26639', 'Andy build #01 from group 02 of pack1');
    assert.equal(calls.builds, beforeBareHash);
    assert.equal(calls.prompts, 0);
    assert.equal(calls.generated, 0);
`));

test('aliases fail closed for overlapping selectors, bad boundaries, missing files, and injection without model fallback', () => check(`
    for (const alias of ['schema', 'schem', 'scheme', 'schematic']) {
        const invalid = [
            alias, alias + ' file', alias + ' file name', alias + ' file id nope',
            alias + ' file id 0 from group 2 of pack1',
            alias + ' file id 1 from group 0 of pack1',
            alias + ' file id 9007199254740992 from group 2 of pack1',
            alias + ' file id 1 from group 2 of pack0',
            alias + ' file id 1 from group 2 of pack1 then build a tower',
            alias + ' file id 1 from group 2 of pack1 and file id 1 from group 2 of pack1',
            alias + ' file name 02_bee_hot_air_balloon of pack1 and id 1 from group 2 of pack1',
            alias + ' file file name 02_bee_hot_air_balloon of pack1',
            alias + ' file id id 1 from group 2 of pack1',
            alias + 'x file id 1 from group 2 of pack1 trailing',
            '-' + alias + ' file name 02_bee_hot_air_balloon of pack1',
            alias + ' pack1/../outside.schem',
            alias + ' file name 02_bee_hot_air_balloon of pack1; !stop()',
            alias + ' file name 02_bee_hot_air_balloon of pack1 at 1 2 3',
            alias + ' file name 02_BEE_hot_air_balloon.schem of pack1',
            alias + ' file name 02_bee_hot_air_balloon.SCHEM of pack1',
            alias + ' file name nonexistent.schem of pack1',
            alias + ' file name nonexistent.schematic of pack1',
            alias + ' file name nonexistent.litematic of pack1',
            alias + ' id 999 from group 2 of pack1',
            alias + ' file name pack1/02-01',
        ];
        for (const target of invalid) {
            const message = 'Andy build ' + target;
            assert.ok(router.parseAddressedSchematicRequest(message, 'Andy'), message);
            const before = [calls.builds, calls.prompts, calls.generated, calls.lifecycle.length];
            await agent.handleMessage('Sunny26639', message);
            assert.deepEqual([calls.builds, calls.prompts, calls.generated, calls.lifecycle.length], before, message);
        }
        for (const source of ['Mallory', 'Alice']) {
            for (const target of [alias + ' file id 1 from group 2 of pack1',
                alias + ' file name 02_bee_hot_air_balloon of pack1',
                alias + ' pack1/02_bee_hot_air_balloon']) {
                await agent.handleMessage(source, 'Andy build ' + target);
                assert.match(calls.routes.at(-1), /trusted command senders/);
            }
        }
        agent.blocked_actions = ['!buildSchematic'];
        await agent.handleMessage('Sunny26639', 'Andy build ' + alias + ' id 1 from group 2 of pack1');
        assert.match(calls.routes.at(-1), /blocked/);
        agent.blocked_actions = [];
        await agent.handleMessage('Sunny26639', 'Alice build ' + alias + ' pack1/02_bee_hot_air_balloon');
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
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { resolveSchematicPath, listSchematicEntries } = await import(${url('src/utils/schematic/paths.js')});
    const directory = await mkdtemp(path.join(tmpdir(), 'mindcraft-request-review-'));
    try {
        const pack = path.join(directory, 'schems/pack1');
        await mkdir(pack, { recursive: true });
        for (const fileName of ['id.schem', 'name.schem', 'UPPER.SCHEM', '123.schem', 'legacy.schematic', 'convert.litematic']) {
            await writeFile(path.join(pack, fileName), 'path-only test fixture');
        }
        await writeFile(path.join(pack, 'index.json'), JSON.stringify({ schemaVersion: 2, groups: {
            2: { 1: 'name.schem', 7: 'id.schem' },
        } }));
        assert.equal(await resolveSchematicPath('pack1:2:1', directory), path.join(pack, 'name.schem'));
        assert.equal(await resolveSchematicPath('pack1:02:07', directory), path.join(pack, 'id.schem'));
        await assert.rejects(resolveSchematicPath('pack1:02-01', directory));
        assert.equal(await resolveSchematicPath('schems/pack1/../pack1/id.schem', directory), path.join(pack, 'id.schem'));
        for (const alias of ['', 'schema ', 'schem ', 'scheme ', 'schematic ']) {
            for (const fileName of ['id', 'name', 'UPPER.SCHEM', '123.schem', 'legacy.schematic', 'convert.litematic']) {
                for (const target of ['file name ' + fileName + ' of PACK1', 'file name PACK1/' + fileName]) {
                    const message = 'Andy build ' + alias + target;
                    const parsed = router.parseAddressedSchematicRequest(message, 'Andy');
                    assert.equal(parsed?.fileName, fileName, message);
                    assert.equal(parsed.filename, fileName, message);
                    assert.equal(parsed.selectorKind, 'fileName', message);
                    assert.equal(Object.hasOwn(parsed, 'fileId'), false, message);
                    const expected = path.join(pack, fileName === 'id' || fileName === 'name' ? fileName + '.schem' : fileName);
                    assert.equal(await resolveSchematicPath(parsed.selector, directory), expected, message);
                }
            }
        }
        for (const selector of ['pack1:upper.SCHEM', 'pack1:UPPER.schem', 'pack1:123']) {
            await assert.rejects(resolveSchematicPath(selector, directory));
        }
        const entries = await listSchematicEntries(directory);
        assert.equal(entries.length, 6);
        assert.deepEqual(entries.slice(0, 2).map(({ fileId, fileName }) => [fileId, fileName]), [[1, 'name.schem'], [7, 'id.schem']]);
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
        const message = 'Andy build ' + description + ' file id 1 from group 2 of pack1';
        assert.equal(router.parseAddressedSchematicRequest(message, 'Andy')?.selector, 'pack1:2:1', message);
        const before = calls.builds;
        await agent.handleMessage('Sunny26639', message);
        assert.equal(calls.builds, before + 1, message);
    }
    for (const description of ['"reserved words" ' + slash + ' cottage',
        '😀😀 "reserved words" ' + slash + ' cottage']) {
        const message = 'Andy build ' + description + ' file id 1 from group 2 of pack1';
        assert.match(router.parseAddressedSchematicRequest(message, 'Andy')?.error ?? '', /command fragments/, message);
        const before = calls.builds;
        await agent.handleMessage('Sunny26639', message);
        assert.equal(calls.builds, before, message);
    }
    assert.equal(calls.prompts, 0);
`));
