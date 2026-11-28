/* global process */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test, { before, after } from 'node:test';

if (!process.env.MINDCRAFT_SETTINGS_TEST_LOADER) {
    test('settings preservation through editor, socket API, restart snapshot and command trust', () => {
        const env = { ...process.env, MINDCRAFT_SETTINGS_TEST_LOADER: '1' };
        // A nested --test invocation must not inherit the parent's IPC context.
        delete env.NODE_TEST_CONTEXT;
        const child = spawnSync(process.execPath, [
            '--experimental-loader', fileURLToPath(new URL('./settings_preservation_loader.js', import.meta.url)),
            '--test', fileURLToPath(import.meta.url),
        ], {
            encoding: 'utf8', timeout: 30000,
            env,
        });
        assert.equal(child.status, 0, child.stderr + child.stdout);
        assert.match(child.stdout, /real UI placement edit preserves restrictive trust/);
        assert.match(child.stdout, /# tests 13\b/);
        assert.match(child.stdout, /# pass 13\b/);
        assert.match(child.stdout, /# fail 0/);
        console.log(child.stdout);
    });
} else {
    let connect, createMindServer, registerAgent, getIO, runtimeSettings, setSettings, Agent;
    const schema = JSON.parse(readFileSync(new URL('../../src/mindcraft/public/settings_spec.json', import.meta.url)));
    const html = readFileSync(new URL('../../src/mindcraft/public/index.html', import.meta.url), 'utf8');
    let server, client;
    const emit = (...args) => client.timeout(3000).emitWithAck(...args);
    const snapshot = async name => (await emit('get-settings', name)).settings;
    const malformedTrust = [false, true, 'Builder', '', 0, {}, { Builder: true },
        [false], [null], [42], [{}], [['Builder']], [''], ['   '], ['Builder', false]];

    before(async () => {
        ({ io: connect } = await import('socket.io-client'));
        ({ createMindServer, registerAgent, getIO } = await import('../../src/mindcraft/mindserver.js'));
        ({ default: runtimeSettings, setSettings } = await import('../../src/agent/settings.js'));
        ({ Agent } = await import('../../src/agent/agent.js'));
        server = createMindServer(false, 0);
        await once(server, 'listening');
        client = connect(`http://localhost:${server.address().port}`, { reconnection: false });
        await once(client, 'connect');
    });
    after(async () => {
        client?.disconnect();
        if (server) await new Promise(resolve => getIO().close(resolve));
    });

    function editor(settings) {
        // Execute the real editor functions with a minimal DOM, including discard.
        const elements = new Map();
        const element = () => ({
            style: {}, value: '', checked: false,
            add() {}, addEventListener() {},
            appendChild(child) { if (child.id) elements.set(child.id, child); },
        });
        const form = element();
        const context = vm.createContext({
            settingsSpec: schema,
            originalAgentSettings: structuredClone(settings), currentAgentName: settings.profile.name,
            agentSettingsForm: form, applyBtn: {},
            document: { createElement: element, getElementById: id => elements.get(id) },
            Option: function () {},
            discardBtn: { addEventListener: (_event, callback) => { context.discard = callback; } },
        });
        const functions = html.slice(html.indexOf('        function buildAgentSettingsForm('), html.indexOf('        function closeAgentSettings('));
        // openAgentSettings only defines a callback and window property here.
        context.window = {};
        vm.runInContext(functions, context);
        const discard = html.slice(html.indexOf("        discardBtn.addEventListener('click'"), html.indexOf("        applyBtn.addEventListener('click'"));
        vm.runInContext(discard, context);
        context.buildAgentSettingsForm(settings);
        return {
            input: key => elements.get(`agent-setting-${key}`),
            read: () => JSON.parse(JSON.stringify(context.getEditedAgentSettings())),
            discard: () => context.discard(),
        };
    }

    async function assertUntrustedDenied(saved) {
        // init_agent/serverProxy loads this complete get-settings snapshot with
        // setSettings; do the same before running the real message trust check.
        setSettings(saved);
        const routes = [];
        const agent = Object.create(Agent.prototype);
        Object.assign(agent, {
            name: saved.profile.name,
            checkTaskDone: async () => {},
            routeResponse: (_source, message) => routes.push(message),
        });
        assert.equal(await agent.handleMessage('UntrustedPlayer', '!stop'), false);
        assert.match(routes.at(-1), /restricted to configured trusted command senders/);
    }

    test('real UI placement edit preserves restrictive trust and all hidden settings through restart loading', async t => {
        const original = {
            ...(await import('../../settings.js')).default,
            profile: { name: 'PreservedUI', extra: { prompt: 'keep' } },
            future_security_option: { enabled: true, nested: ['opaque'] },
            future_null: null, future_false: false,
        };
        registerAgent(original, 3010);
        client.emit('connect-agent-process', original.profile.name);
        const loaded = await snapshot(original.profile.name);
        const form = editor(loaded);
        form.input('schematic_placement_mode').value = 'raise';
        const outgoing = form.read();
        t.diagnostic(`Editor retained hidden allowlist: ${Object.hasOwn(outgoing, 'trusted_command_senders')}`);
        assert.deepEqual(outgoing.trusted_command_senders, original.trusted_command_senders);
        assert.deepEqual(outgoing.future_security_option, original.future_security_option);
        const restarted = once(client, 'restart-agent');
        assert.deepEqual(await emit('set-agent-settings', original.profile.name, outgoing), { success: true });
        await restarted;
        const saved = await snapshot(original.profile.name);
        assert.equal(saved.schematic_placement_mode, 'raise');
        for (const key of ['profile', 'trusted_command_senders', 'future_security_option', 'future_null', 'future_false']) {
            assert.deepEqual(saved[key], original[key], key);
        }
        await assertUntrustedDenied(saved);
        assert.equal(original.schematic_placement_mode, 'delicate', 'editor did not mutate original');
    });

    test('schema-only and partial API updates preserve hidden fields; validate merged settings atomically', async t => {
        const name = 'PreservedAPI';
        const original = {
            profile: { name }, trusted_command_senders: ['Builder'],
            future: { restriction: true }, schematic_balanced_radius: 7,
        };
        registerAgent(original, 3011);
        client.emit('connect-agent-process', name);
        const schemaOnly = { profile: { name }, schematic_placement_mode: 'balanced' };
        assert.deepEqual(await emit('set-agent-settings', name, schemaOnly), { success: true });
        let saved = await snapshot(name);
        t.diagnostic(`Server retained omitted allowlist: ${Object.hasOwn(saved, 'trusted_command_senders')}`);
        assert.deepEqual(saved.trusted_command_senders, ['Builder']);
        assert.deepEqual(saved.future, original.future);
        assert.equal(saved.schematic_balanced_radius, 7);
        await assertUntrustedDenied(saved);
        assert.deepEqual(await emit('set-agent-settings', name, { schematic_balanced_threshold: 12 }), { success: true });
        saved = await snapshot(name);
        assert.equal(saved.schematic_balanced_threshold, 12);
        assert.equal(saved.schematic_placement_mode, 'balanced');
        assert.equal((await emit('set-agent-settings', name, { schematic_balanced_strategy: 'bisect', schematic_balanced_step: 16,
            schematic_balanced_policy: 'exhaustive', schematic_balanced_bisect_depth: 0 })).success, true);
        saved = await snapshot(name);
        assert.equal(saved.schematic_balanced_strategy, 'bisect');
        assert.equal(saved.schematic_balanced_step, 16);
        assert.equal(saved.schematic_balanced_policy, 'exhaustive');
        assert.equal(saved.schematic_balanced_bisect_depth, 0);
        let restarts = 0;
        const onRestart = () => restarts++;
        client.on('restart-agent', onRestart);
        const invalidMode = await emit('set-agent-settings', name, { schematic_placement_mode: 'unknown-mode' });
        assert.equal(invalidMode.success, false);
        assert.match(invalidMode.error, /schematic_placement_mode.*delicate.*raise.*balanced.*destructive/i);
        assert.deepEqual(await snapshot(name), saved);
        const rejected = await emit('set-agent-settings', name, { schematic_balanced_radius: 999, trusted_command_senders: null });
        assert.equal(rejected.success, false);
        assert.deepEqual(await snapshot(name), saved, 'invalid update must not partially change settings');
        for (const invalid of [{ schematic_balanced_strategy: 'other' }, { schematic_balanced_step: 0 },
            { schematic_balanced_policy: 'other' }, { schematic_balanced_bisect_depth: 4 }]) {
            assert.equal((await emit('set-agent-settings', name, { ...invalid, trusted_command_senders: null })).success, false);
            assert.deepEqual(await snapshot(name), saved);
        }
        assert.equal(restarts, 0);
        client.off('restart-agent', onRestart);
    });

    test('explicit API replacements, empty lists, null reset and falsy/unknown values remain intentional', async () => {
        const name = 'ExplicitValues';
        registerAgent({ profile: { name }, trusted_command_senders: ['Builder'],
            schematic_placement_mode: 'raise', future: { old: true } }, 3012);
        client.emit('connect-agent-process', name);
        assert.equal((await emit('set-agent-settings', name, {
            trusted_command_senders: [], schematic_placement_mode: null,
            future: { replacement: true }, enabled_future: false, zero_future: 0,
        })).success, true);
        let saved = await snapshot(name);
        assert.deepEqual(saved.trusted_command_senders, []);
        assert.equal(saved.schematic_placement_mode, null);
        assert.deepEqual(saved.future, { replacement: true }, 'explicit object replaces, not deep merges');
        assert.equal(saved.enabled_future, false);
        assert.equal(saved.zero_future, 0);
        await assertUntrustedDenied(saved);
        assert.equal((await emit('set-agent-settings', name, { trusted_command_senders: ['OtherBuilder'] })).success, true);
        assert.deepEqual((await snapshot(name)).trusted_command_senders, ['OtherBuilder']);
        // Existing policy treats explicit null as no allowlist. Preserve that
        // supported API value; omission alone must never create this state.
        assert.equal((await emit('set-agent-settings', name, { trusted_command_senders: null, future: null })).success, true);
        saved = await snapshot(name);
        assert.equal(saved.trusted_command_senders, null);
        assert.equal(saved.future, null);
        setSettings(saved);
        const { agent, calls } = routingAgent();
        await agent.handleMessage('UntrustedPlayer', '!stop');
        assert.equal(calls.commands, 1, 'explicit API null reset retains legacy unrestricted commands after reload');
    });

    test('new-agent API retains supplied hidden fields while schema defaults and required fields still work', async () => {
        assert.equal((await emit('create-agent', {})).success, false);
        const name = 'CreatedRestricted';
        assert.equal((await emit('create-agent', {
            profile: { name }, trusted_command_senders: ['Builder'],
            future: { restriction: true }, schematic_placement_mode: 'raise',
        })).success, true);
        const saved = await snapshot(name);
        assert.deepEqual(saved.trusted_command_senders, ['Builder']);
        assert.deepEqual(saved.future, { restriction: true });
        assert.equal(saved.schematic_placement_mode, 'raise');
        assert.equal(saved.schematic_balanced_radius, schema.schematic_balanced_radius.default);
        await assertUntrustedDenied(saved);
        // A newly created agent may not have connected its process yet.
        assert.equal((await emit('set-agent-settings', name, { schematic_placement_mode: null })).success, true);
        assert.deepEqual((await snapshot(name)).trusted_command_senders, ['Builder']);

        assert.equal((await emit('create-agent', { profile: { name: 'CreatedDefaults' } })).success, true);
        const defaults = await snapshot('CreatedDefaults');
        assert.equal(Object.hasOwn(defaults, 'trusted_command_senders'), false, 'do not introduce a new trust default');
        assert.equal(defaults.schematic_placement_mode, 'delicate');
        assert.equal(defaults.schematic_balanced_radius, 4);
        assert.equal(defaults.schematic_balanced_threshold, 9);
        assert.equal(defaults.schematic_balanced_strategy, 'stepped');
        assert.equal(defaults.schematic_balanced_step, 2);
        assert.equal(defaults.schematic_balanced_policy, 'first_valid');
        assert.equal(defaults.schematic_balanced_bisect_depth, 2);
        assert.equal((await emit('create-agent', {
            profile: { name: 'InvalidCreate' }, schematic_balanced_radius: 999,
        })).success, false);
        assert.equal((await emit('get-settings', 'InvalidCreate')).settings, undefined);
    });

    test('discard restores visible fields without losing hidden settings; runtime snapshots still replace/reset', () => {
        const original = { profile: { name: 'Discard' }, trusted_command_senders: ['Builder'],
            future: { enabled: true }, schematic_placement_mode: null };
        const form = editor(original);
        form.input('schematic_placement_mode').value = 'destructive';
        form.discard();
        const restored = form.read();
        assert.equal(restored.schematic_placement_mode, 'delicate');
        assert.deepEqual(restored.trusted_command_senders, ['Builder']);
        assert.deepEqual(restored.future, original.future);
        setSettings(original);
        setSettings({ profile: { name: 'FreshSnapshot' } });
        assert.equal(Object.hasOwn(runtimeSettings, 'trusted_command_senders'), false);
        assert.equal(Object.hasOwn(runtimeSettings, 'future'), false);
        setSettings({});
        assert.deepEqual(runtimeSettings, {});
    });

    test('malformed trust API updates reject atomically without restarting or losing the original list', async t => {
        const name = 'TrustAtomic';
        registerAgent({ profile: { name }, trusted_command_senders: ['Builder'],
            future: { keep: true }, schematic_placement_mode: 'raise' }, 3013);
        client.emit('connect-agent-process', name);
        const original = await snapshot(name);
        let restarts = 0;
        const onRestart = () => restarts++;
        client.on('restart-agent', onRestart);
        try {
            for (const value of malformedTrust) {
                const result = await emit('set-agent-settings', name, {
                    trusted_command_senders: value, future: null, schematic_placement_mode: 'balanced',
                });
                t.diagnostic(`trust update ${JSON.stringify(value)}: success=${result.success}`);
                assert.equal(result.success, false);
                assert.match(result.error, /trusted_command_senders/);
                assert.deepEqual(await snapshot(name), original);
                await assertUntrustedDenied(await snapshot(name));
            }
            assert.equal(restarts, 0);
        } finally {
            client.off('restart-agent', onRestart);
        }
    });

    test('malformed trust creation is rejected by both socket API and direct startup creation', async () => {
        const { createAgent } = await import('../../src/mindcraft/mindcraft.js');
        for (const [index, value] of malformedTrust.entries()) {
            for (const direct of [false, true]) {
                const name = `InvalidTrust${index}${direct}`;
                const settings = { profile: { name }, trusted_command_senders: value };
                const result = direct ? await createAgent(settings) : await emit('create-agent', settings);
                assert.equal(result.success, false, JSON.stringify(value));
                assert.match(result.error, /trusted_command_senders/);
                assert.equal(await snapshot(name), undefined);
            }
        }
        // JSON would normalize these to null: direct config must be checked first.
        for (const value of [NaN, Infinity, new Array(1)]) {
            const result = await createAgent({ profile: { name: 'InvalidBeforeSerialization' }, trusted_command_senders: value });
            assert.equal(result.success, false);
            assert.match(result.error, /trusted_command_senders/);
            assert.equal(await snapshot('InvalidBeforeSerialization'), undefined);
        }
    });

    test('runtime snapshot validation rejects malformed trust before changing any existing setting', () => {
        const original = { profile: { name: 'RuntimeAtomic' }, trusted_command_senders: ['Builder'], future: false };
        setSettings(original);
        const originalList = runtimeSettings.trusted_command_senders;
        for (const value of [...malformedTrust, new Array(1), ['Builder', undefined]]) {
            assert.throws(() => setSettings({ trusted_command_senders: value, future: true }), /trusted_command_senders/);
            assert.deepEqual(runtimeSettings, original);
            assert.equal(runtimeSettings.trusted_command_senders, originalList);
        }
    });

    function routingAgent() {
        const calls = { commands: 0, prompts: 0, routes: [] };
        const agent = Object.create(Agent.prototype);
        Object.assign(agent, {
            name: 'TrustRuntime', blocked_actions: [],
            checkTaskDone: async () => {}, clearBotLogs() {},
            routeResponse: (_source, message) => calls.routes.push(message),
            actions: { stop: () => calls.commands++, cancelResume() {} },
            bot: { emit() {}, modes: { flushBehaviorLog: () => '' } },
            self_prompter: { handleUserPromptedCmd() {}, isActive: () => false, shouldInterrupt: () => false },
            history: { add() {}, save() {}, getHistory: () => [] },
            prompter: { promptConvo: () => { calls.prompts++; return '!stop'; } },
        });
        return { agent, calls };
    }

    test('runtime mutation cannot grant malformed trust access through direct, addressed, typed or inferred commands', async () => {
        for (const value of [...malformedTrust, new Array(1), ['UntrustedPlayer', null]]) {
            setSettings({ max_commands: 1 });
            // Defense in depth: bypass validated imports just as a direct in-process mutation could.
            runtimeSettings.trusted_command_senders = value;
            const { agent, calls } = routingAgent();
            for (const message of ['!stop', 'TrustRuntime !stop', 'TrustRuntime build file id 01 from group 02 of pack2']) {
                await agent.handleMessage('UntrustedPlayer', message);
                assert.match(calls.routes.at(-1), /trusted command senders/i);
            }
            assert.equal(calls.commands, 0);
            assert.equal(calls.prompts, 0, 'direct untrusted commands must not fall through to inference');
            await agent.handleMessage('UntrustedPlayer', 'hello');
            assert.equal(calls.prompts, 1);
            assert.equal(calls.commands, 0, 'model-generated commands remain denied');
        }
    });

    test('valid lists, empty lists, explicit null and missing runtime resets preserve command semantics', async () => {
        for (const [settings, allowed] of [
            [{ trusted_command_senders: ['Builder'] }, true],
            [{ trusted_command_senders: ['OtherBuilder'] }, false],
            [{ trusted_command_senders: [] }, false],
            [{ trusted_command_senders: null }, true], [{}, true],
        ]) {
            setSettings({ ...settings, max_commands: 1 });
            const { agent, calls } = routingAgent();
            await agent.handleMessage('Builder', '!stop');
            assert.equal(calls.commands, Number(allowed));
        }
        for (const value of [[], null]) {
            const name = value === null ? 'CreatedNullTrust' : 'CreatedEmptyTrust';
            assert.equal((await emit('create-agent', { profile: { name }, trusted_command_senders: value })).success, true);
            setSettings(await snapshot(name));
            const { agent, calls } = routingAgent();
            await agent.handleMessage('UntrustedPlayer', '!stop');
            assert.equal(calls.commands, value === null ? 1 : 0);
        }
    });

    test('hidden prototype-shaped fields remain inert through create, update and runtime loading', async () => {
        const payload = JSON.parse('{"__proto__":{"trusted_command_senders":null,"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
        const name = 'PrototypeTrust';
        assert.equal((await emit('create-agent', { ...payload, profile: { name }, trusted_command_senders: ['Builder'] })).success, true);
        assert.equal((await emit('set-agent-settings', name, payload)).success, true);
        const saved = await snapshot(name);
        await assertUntrustedDenied(saved);
        assert.equal(Object.getPrototypeOf(runtimeSettings), Object.prototype);
        assert.equal(Object.hasOwn(runtimeSettings, '__proto__'), true);
        assert.deepEqual(runtimeSettings.__proto__, payload.__proto__);
        assert.equal(runtimeSettings.polluted, undefined);
        assert.equal({}.polluted, undefined);
        setSettings({});
        assert.equal(Object.getPrototypeOf(runtimeSettings), Object.prototype);
    });

    test('real runtime proxy rejects invalid startup snapshots and accepts a null reset', async () => {
        const { serverProxy } = await import('../../src/agent/mindserver_proxy.js');
        const original = { profile: { name: 'ProxyTrust' }, trusted_command_senders: ['Builder'] };
        registerAgent(original, 3014);
        setSettings({ trusted_command_senders: ['Existing'] });
        try {
            for (const value of malformedTrust) {
                // Simulate a legacy/external server snapshot that bypassed API validation.
                original.trusted_command_senders = value;
                await assert.rejects(serverProxy.connect('ProxyTrust', server.address().port), /trusted_command_senders/);
                assert.deepEqual(runtimeSettings.trusted_command_senders, ['Existing']);
                serverProxy.socket.disconnect();
                serverProxy.connected = false;
            }
            original.trusted_command_senders = null;
            await serverProxy.connect('ProxyTrust', server.address().port);
            assert.equal(runtimeSettings.trusted_command_senders, null);
        } finally {
            serverProxy.socket?.disconnect();
            serverProxy.connected = false;
        }
    });

    test('main startup rejects malformed imported or environment trust before opening a server', () => {
        for (const fromEnvironment of [false, true]) {
            const child = spawnSync(process.execPath, [
                '--experimental-loader', fileURLToPath(new URL('./settings_preservation_loader.js', import.meta.url)),
                fileURLToPath(new URL('../../main.js', import.meta.url)),
            ], {
                encoding: 'utf8', timeout: 5000,
                env: { ...process.env, MINDCRAFT_TEST_STARTUP_TRUST: fromEnvironment ? 'null' : 'false',
                    SETTINGS_JSON: fromEnvironment ? '{"trusted_command_senders":"Builder"}' : '{}' },
            });
            assert.equal(child.status, 1, child.stderr + child.stdout);
            assert.match(child.stderr, /trusted_command_senders/);
            assert.doesNotMatch(child.stdout, /MindServer running/);
        }
    });
}
