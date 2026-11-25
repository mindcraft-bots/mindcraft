import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { syntheticSponge } from './synthetic_sponge.js';
import { writeFixtureProvenance } from './provenance_fixture.js';

test('authenticated player ingress reaches the production engine; absent or untrusted provenance has no effects', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'destructive-ingress-'));
  try {
    const pack = path.join(directory, 'schems/pack2');
    mkdirSync(pack, { recursive: true });
    writeFileSync(path.join(pack, 'index.json'), JSON.stringify({ schemaVersion: 2, groups: { 2: { 1: 'garden.schem' } } }));
    for (const version of ['1.18.2', '1.21.4']) {
      const bytes = syntheticSponge(version, ['minecraft:stone', 'minecraft:air']);
      const file = path.join(pack, `garden.mc${version}.schem`);
      writeFileSync(file, bytes);
      writeFixtureProvenance(file, bytes, 'NONVALIDATED');
    }
    const root = new URL('../../', import.meta.url);
    const url = p => JSON.stringify(new URL(p, root).href);
    const script = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const Vec3 = require('vec3');
      const chatPlugin = require('mineflayer/lib/plugins/chat.js');
      const protocolChatPlugin = require('minecraft-protocol/src/client/chat.js');
      const { concat } = require('minecraft-protocol/src/transforms/binaryStream.js');
      const { generateKeyPairSync, sign } = require('node:crypto');
      const nbt = require('prismarine-nbt');
      const playerKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const { trackAuthenticatedChatConnection } = await import(${url('src/utils/authenticated_chat.js')});
      const { fixture } = await import(${url('test/schematic/destructive_ingress_fixture.js')});
      const { setSettings } = await import(${url('src/agent/settings.js')});
      const settings = globalThis.__testSettings = { trusted_command_senders: ['Builder'], only_chat_with: [],
        known_bot_peers: ['Alice'], max_commands: 1, schematic_placement_mode: 'destructive', chat_ingame: true,
        allow_nonvalidated_schematic_builds: true };
      const sync = () => setSettings(settings); sync();
      const { Agent } = await import(${url('src/agent/agent.js')});
      const commands = await import(${url('src/agent/commands/index.js')});
      const convo = (await import(${url('src/agent/conversation.js')})).default;
      const calls = globalThis.__ingressCalls = [];
      const sender = '11111111-1111-4111-8111-111111111111';
      const botId = '22222222-2222-4222-8222-222222222222';
      const playerSession = '33333333-3333-4333-8333-333333333333';
      let f, agent, routes, actions, prompts, lifecycle, delivery;
      async function setup(version = '1.21.4', { auth = 'microsoft', authenticated = true } = {}) {
        f = fixture(['cobblestone', 'air', 'stone', 'air'], 4, version);
        f.bot.position = new Vec3(-2, 64, -2); f.bot.output = ''; f.bot.autoEat = {};
        f.bot.modes = { flushBehaviorLog: () => '' };
        f.bot.players = {
          Builder: { username: 'Builder', uuid: sender },
          Other: { username: 'Other', uuid: '44444444-4444-4444-8444-444444444444' },
          Alice: { username: 'Alice', uuid: '55555555-5555-4555-8555-555555555555' },
        };
        f.bot.uuidToUsername = Object.fromEntries(Object.values(f.bot.players).map(p => [p.uuid, p.username]));
        // Ordinary server-provided vanilla chat registry and authenticated-login fixtures.
        f.bot.registry = { ...f.bot.registry, chatFormattingById: {
          1: { name: 'minecraft:chat', formatString: '<%s> %s', parameters: ['sender', 'content'] },
          2: { name: 'minecraft:msg_command_incoming', formatString: '%s whispers to you: %s', parameters: ['sender', 'content'] },
        } };
        Object.assign(f.bot._client, { state: 'play', version, uuid: botId, username: 'Andy',
          socket: { destroyed: false },
          session: { selectedProfile: { id: botId.replaceAll('-', ''), name: 'Andy' } },
          serverFeatures: { enforcesSecureChat: true } });
        trackAuthenticatedChatConnection(f.bot, auth);
        f.bot._client.emit('encryption_begin', { shouldAuthenticate: authenticated });
        f.bot._client.cipher = {}; f.bot._client.decipher = {};
        f.bot._client.emit('login', { enforcesSecureChat: true });
        if (version === '1.21.4') protocolChatPlugin(f.bot._client, {});
        chatPlugin(f.bot, {});
        globalThis.__destructiveDependencies = f.dependencies;
        calls.length = 0; routes = []; actions = 0; prompts = 0; lifecycle = 0;
        agent = Object.create(Agent.prototype);
        Object.assign(agent, { name: 'Andy', bot: f.bot, blocked_actions: [], task: { data: null },
          checkTaskDone: async () => {}, routeResponse: async (_source, text) => routes.push(text),
          actions: { cancelManagedResumeForUserCommand() {}, runAction: async (_label, fn) => {
            actions++; await fn(); return { message: f.bot.output }; } },
          self_prompter: { handleUserPromptedCmd: () => lifecycle++, isActive: () => false, shouldInterrupt: () => false },
          history: { add() {}, save() {}, getHistory: () => [] },
          prompter: { promptConvo: async () => { prompts++; return 'none'; } }, openChat: () => {} });
        await agent._setupEventHandlers(null, null);
        for (const event of ['chat', 'whisper']) {
          const handler = f.bot.listeners(event)[0];
          f.bot.removeListener(event, handler);
          f.bot.on(event, (...args) => { delivery = handler(...args); return delivery; });
        }
      }
      async function playerChat(source, text, metadata = {}) {
        const player = f.bot.players?.[source];
        if (!player) return f.bot.listeners('chat')[0](source, text);
        delivery = null;
        f.bot._client.emit('playerChat', { sender: player.uuid, senderName: JSON.stringify({ text: source }),
          plainMessage: text, type: 1, verified: true, ...metadata });
        await delivery;
      }
      async function signedPlayerChat(text) {
        // The fixture player signs its own ordinary message. The installed
        // protocol verifier, not the test, supplies the resulting verified flag.
        const client = f.bot._client;
        client.emit('player_info', { data: [{ uuid: sender, chatSession: {
          uuid: playerSession, publicKey: { keyBytes: playerKeys.publicKey.export({ type: 'spki', format: 'der' }) },
        } }] });
        const timestamp = BigInt(Date.now()), salt = 1n;
        const bytes = concat('i32', 1, 'UUID', sender, 'UUID', playerSession, 'i32', 0,
          'i64', salt, 'i64', timestamp / 1000n, 'i32', Buffer.byteLength(text), 'pstring', text, 'i32', 0);
        let verified;
        client.once('playerChat', data => { verified = data.verified; });
        delivery = null;
        client.emit('player_chat', { senderUuid: sender, plainMessage: text, type: 1,
          networkName: nbt.comp({ text: nbt.string('Builder') }),
          signature: sign('RSA-SHA256', bytes, playerKeys.privateKey), index: 0,
          previousMessages: [], salt, timestamp });
        await delivery;
        assert.equal(verified, true, 'installed protocol verifies the genuine fixture player');
      }
      function noEffects() {
        assert.equal(calls.length, 0); assert.equal(actions, 0); assert.equal(prompts, 0);
        assert.equal(lifecycle, 0); assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []);
      }
      const selector = 'Andy build id 1 from group 2 of pack2';
      const direct = '!buildSchematic("pack2:2:1", 0, 64, 0, "destructive")';
      await setup(); f.world.set('0,64,0', 'air'); f.world.set('2,64,0', 'stone');
      await signedPlayerChat(selector + ' via destructive mode');
      assert.equal(calls.length, 1, routes.join(' | ')); assert.equal(calls[0].options.placementOptions.mode, 'destructive');
      assert.deepEqual(f.writes, [['place', '0,64,0']]);
      assert.match(routes.join(' '), /completed and verified/i);
      await setup(); f.world.set('0,64,0', 'air'); f.world.set('2,64,0', 'stone');
      await signedPlayerChat(direct); assert.equal(calls.length, 1); assert.equal(calls[0].x, 0);
      assert.deepEqual(f.writes, [['place', '0,64,0']]);
      await setup();
      let rotatedCells;
      f.dependencies.onBuilder = build => { rotatedCells = build.cells.map(cell => [cell.name, cell.position.x, cell.position.y, cell.position.z]); };
      const rotatedDirect = '!buildSchematic("pack2:2:1", 0, 64, 0, "destructive", null, null, "E")';
      await signedPlayerChat(rotatedDirect);
      assert.equal(calls.length, 1, routes.join(' | '));
      assert.equal(calls[0].options.placementOptions.orientation, 'east');
      assert.ok(Object.isFrozen(calls[0].options.placementOptions));
      assert.deepEqual(rotatedCells, [['cobblestone', 0, 64, 0], ['air', 0, 64, 1], ['stone', 0, 64, 2], ['air', 0, 64, 3]]);
      assert.equal(f.world.get('0,64,0'), 'cobblestone'); assert.equal(f.world.get('0,64,2'), 'stone');
      assert.match(routes.join(' '), /completed and verified/i);
      await setup();
      f.dependencies.onBuilder = build => { rotatedCells = build.cells.map(cell => [cell.name, cell.position.x, cell.position.z]); };
      await signedPlayerChat(selector + ' then rotate to face east via destructive mode');
      assert.equal(calls.length, 1, routes.join(' | '));
      assert.equal(calls[0].options.placementOptions.orientation, 'east');
      assert.equal(rotatedCells[2][1], rotatedCells[0][1]);
      assert.equal(rotatedCells[2][2] - rotatedCells[0][2], 2);
      await setup(); await f.bot.listeners('chat')[0]('Builder', rotatedDirect); noEffects();
      await setup(); await playerChat('Builder', selector); assert.equal(calls.length, 1);
      assert.equal(calls[0].options.placementOptions.mode, 'destructive');
      await setup(); await playerChat('Builder', '!buildSchematic("pack2:2:1", 0, 64, 0)');
      assert.equal(calls.length, 1); assert.equal(calls[0].options.placementOptions.mode, 'destructive');
      settings.schematic_placement_mode = 'balanced'; sync();
      await setup(); await playerChat('Builder', selector + ' using destructive mode'); assert.equal(calls.length, 1);
      settings.schematic_placement_mode = 'destructive'; sync();
      settings.allow_insecure_coding = true; sync(); await setup();
      await playerChat('Builder', direct); assert.equal(calls.length, 0); assert.equal(actions, 0);
      assert.match(routes.join(' '), /insecure code generation.*disabled/i);
      settings.allow_insecure_coding = false; sync();
      await setup();
      const { markBotExposedToGeneratedCode } = await import(${url('src/utils/schematic/unsafe_code_history.js')});
      markBotExposedToGeneratedCode(f.bot); await playerChat('Builder', direct);
      assert.equal(calls.length, 0); assert.equal(actions, 0); assert.match(routes.join(' '), /restart/i);
      await setup();
      globalThis.__schematicBuild = async (...args) => { globalThis.__balanced = args[5]; };
      await playerChat('Builder', selector + ' using balanced mode');
      assert.equal(calls.length, 0); assert.equal(globalThis.__balanced.mode, 'balanced');
      await setup(); await playerChat('Builder', selector + ' using raise mode');
      assert.equal(actions, 1); assert.equal(globalThis.__balanced.mode, 'raise');

      for (const allow of [null, undefined, [], ['Other'], ['Builder', null]]) {
        await setup(); const store = (await import(${url('src/agent/settings.js')})).default;
        store.trusted_command_senders = allow;
        await playerChat('Builder', direct);
        assert.equal(calls.length, 0); assert.equal(actions, 0); assert.equal(prompts, 0);
      }
      sync(); await setup();
      await agent.handleMessage('Builder', direct, null, { trusted: true, human: true });
      await agent.respondFunc('Builder', direct, { human: true });
      assert.match(routes.join(' '), /explicitly listed human sender/i);
      assert.match(await commands.executeCommand(agent, direct), /explicitly listed human sender/i);
      assert.equal(calls.length, 0); assert.equal(actions, 0); assert.equal(prompts, 0); assert.equal(lifecycle, 0);
      agent.prompter.promptConvo = async () => { prompts++; return direct; };
      await agent.handleMessage('Builder', 'ordinary chat', 3);
      assert.equal(prompts, 1); assert.equal(calls.length, 0); assert.equal(actions, 0); assert.equal(lifecycle, 0);
      prompts = 0;
      await playerChat('Other', direct); await playerChat('Alice', direct); await playerChat('system', direct);
      assert.equal(calls.length, 0); assert.equal(actions, 0);
      agent.blocked_actions = ['!buildSchematic']; await playerChat('Builder', direct);
      assert.equal(calls.length, 0); assert.equal(actions, 0);
      assert.match(routes.join(' '), /blocked/i);
      await setup(); settings.only_chat_with = ['Other']; sync(); await playerChat('Builder', direct);
      assert.equal(calls.length, 0); assert.equal(actions, 0); settings.only_chat_with = []; sync();
      await setup(); convo.updateAgents([{ name: 'Builder', in_game: true }]); await playerChat('Builder', direct);
      assert.equal(calls.length, 0); assert.equal(actions, 0); convo.updateAgents([]);
      await setup();
      agent.actions.runAction = async (_label, fn) => {
        const store = (await import(${url('src/agent/settings.js')})).default;
        store.trusted_command_senders = []; await fn(); return { message: f.bot.output };
      };
      await playerChat('Builder', direct);
      assert.equal(calls.length, 0); assert.deepEqual(f.writes, []);
      assert.match(routes.join(' '), /explicitly listed human sender/i); sync();

      await setup(); f.world.set('0,64,0', 'chest'); await playerChat('Builder', direct);
      assert.equal(calls.length, 1); assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []);
      assert.match(routes.join(' '), /did not complete/i);
      for (const terrain of ['dirt', 'stone']) {
        await setup('1.21.4'); f.world.set('0,64,0', terrain); f.world.set('2,64,0', 'stone');
        const phases = [];
        f.bot.on('schematicEditAuthorization', event => phases.push(event.phase));
        await signedPlayerChat(direct);
        assert.equal(calls.length, 1, routes.join(' | '));
        assert.deepEqual(f.writes, [['dig', '0,64,0'], ['place', '0,64,0']]);
        assert.equal(f.world.get('0,64,0'), 'cobblestone');
        assert.ok(phases.includes('dig-read-permission-and-start-state-confirmed'));
        assert.ok(phases.includes('dig-owned-sequence-processed'));
        assert.ok(phases.includes('dig-authoritative-target-air-observed'));
        assert.match(routes.join(' '), /completed and verified/i);
        assert.deepEqual(f.modes, ['creative', 'survival']);
      }
      await setup('1.21.4'); f.world.set('0,64,0', 'cobblestone'); f.world.set('2,64,0', 'stone');
      await playerChat('Builder', direct);
      assert.equal(calls.length, 1); assert.deepEqual(f.writes, []);
      assert.match(routes.join(' '), /completed and verified/i);
      assert.equal(prompts, 0);

      // Display-only and absent/untrusted provenance fixtures never escalate.
      for (const text of [direct, selector + ' using destructive mode', selector]) {
        for (const event of ['chat', 'whisper']) {
          await setup(); await f.bot.listeners(event)[0]('Builder', text); noEffects();
          assert.match(routes.join(' '), /authenticated player-message provenance/i);
        }
        for (const metadata of [{ sender: null }, { verified: false }, { verified: undefined },
          { type: 2 }, { unsignedContent: JSON.stringify({ text }) }]) {
          await setup(); await playerChat('Builder', text, metadata); noEffects();
        }
        await setup('1.21.4', { auth: 'offline' }); await playerChat('Builder', text); noEffects();
        await setup('1.21.4', { authenticated: false }); await playerChat('Builder', text); noEffects();
        await setup('1.18.2', { auth: 'offline', authenticated: false });
        await f.bot.listeners('chat')[0]('Builder', text); noEffects();
      }
      for (const mutate of [
        bot => { delete bot.players.Builder.uuid; },
        bot => { delete bot.uuidToUsername; },
        bot => { bot.players.Other = { username: 'Other', uuid: sender }; },
        bot => { bot.uuidToUsername[sender] = 'Other'; },
        bot => { bot._client.serverFeatures.enforcesSecureChat = false; },
      ]) {
        await setup(); mutate(f.bot); await playerChat('Builder', direct); noEffects();
      }
      await setup(); globalThis.__numOtherAgents = 1;
      await playerChat('Builder', direct); noEffects(); globalThis.__numOtherAgents = 0;
      await setup();
      agent.actions.runAction = async (_label, fn) => {
        delete f.bot.players.Builder; await fn(); return { message: f.bot.output };
      };
      await playerChat('Builder', direct); assert.equal(calls.length, 0);
      assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []);
      assert.match(routes.join(' '), /authenticated player-message provenance/i);

      // Legacy/nondestructive chat and whisper routes do not need new metadata.
      for (const event of ['chat', 'whisper']) {
        await setup('1.18.2', { auth: 'offline', authenticated: false });
        globalThis.__balanced = null;
        await f.bot.listeners(event)[0]('Builder', selector + ' using balanced mode');
        assert.equal(globalThis.__balanced.mode, 'balanced'); assert.equal(calls.length, 0);
      }
    `;
    const child = spawnSync(process.execPath, ['--experimental-loader', fileURLToPath(new URL('./commands-loader.js', import.meta.url)), '--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, MINDCRAFT_SCHEMATIC_FIXTURE_ROOT: directory, MINDCRAFT_DESTRUCTIVE_INGRESS_FIXTURE: '1' },
    });
    assert.equal(child.status, 0, child.stderr + child.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
