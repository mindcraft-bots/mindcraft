import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('production agent and builder ESM graph loads in either order and rejects forged grants', () => {
  const root = new URL('../../', import.meta.url);
  const url = path => JSON.stringify(new URL(path, root).href);
  for (const order of ['agent-first', 'builder-first']) {
    const script = `
      import assert from 'node:assert/strict';
      const agentUrl = ${url('src/agent/agent.js')};
      const builderUrl = ${url('src/utils/schematic/build_schematic.js')};
      for (const url of ${JSON.stringify(order)} === 'agent-first' ? [agentUrl, builderUrl] : [builderUrl, agentUrl]) await import(url);
      const { continueSchematic } = await import(builderUrl);
      const { setSettings } = await import(${url('src/agent/settings.js')});
      const { resolvePlacementOptions } = await import(${url('src/utils/schematic/placement_options.js')});
      setSettings({ schematic_continuation_policy: 'allow', trusted_command_senders: [] });
      const logs = [];
      const result = await continueSchematic({}, 'test.schem', 0, 64, 0, {
        placementOptions: resolvePlacementOptions(), continuationGrant: {},
        continuationAuthorizationCurrent: () => true, writeLog: message => logs.push(message),
      });
      assert.equal(result, false);
      assert.match(logs.join(' '), /authorization/i);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 30000, env: process.env });
    assert.equal(child.status, 0, `${order}: ${child.error || ''}\n${child.stderr}\n${child.stdout}`);
  }
});

test('unmocked production graph accepts signed ingress for an already complete schematic', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'continuation-production-graph-'));
  try {
    cpSync(path.join(root, 'src'), path.join(directory, 'src'), { recursive: true });
    cpSync(path.join(root, 'schematics/tooling'), path.join(directory, 'schematics/tooling'), { recursive: true });
    for (const name of ['package.json', 'settings.js']) cpSync(path.join(root, name), path.join(directory, name));
    mkdirSync(path.join(directory, 'test/schematic'), { recursive: true });
    for (const name of ['destructive_ingress_fixture.js', 'provenance_fixture.js', 'synthetic_sponge.js']) {
      cpSync(path.join(root, 'test/schematic', name), path.join(directory, 'test/schematic', name));
    }
    symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    const rootUrl = pathToFileURL(`${directory}${path.sep}`);
    const url = name => JSON.stringify(new URL(name, rootUrl).href);
    const script = `
      import assert from 'node:assert/strict';
      import { mkdirSync, writeFileSync } from 'node:fs';
      import path from 'node:path';
      import { createRequire } from 'node:module';
      import { generateKeyPairSync, sign } from 'node:crypto';
      const require = createRequire(${url('package.json')});
      const Vec3 = require('vec3'), nbt = require('prismarine-nbt');
      const chatPlugin = require('mineflayer/lib/plugins/chat.js');
      const protocolChat = require('minecraft-protocol/src/client/chat.js');
      const { concat } = require('minecraft-protocol/src/transforms/binaryStream.js');
      const { syntheticSponge } = await import(${url('test/schematic/synthetic_sponge.js')});
      const { writeFixtureProvenance } = await import(${url('test/schematic/provenance_fixture.js')});
      const { fixture } = await import(${url('test/schematic/destructive_ingress_fixture.js')});
      const { trackAuthenticatedChatConnection } = await import(${url('src/utils/authenticated_chat.js')});
      const { setSettings } = await import(${url('src/agent/settings.js')});
      setSettings({ trusted_command_senders: ['Builder'], only_chat_with: [], known_bot_peers: [],
        schematic_continuation_policy: 'allow', allow_nonvalidated_schematic_builds: true,
        allow_insecure_coding: false, language: 'en', max_commands: 1, chat_ingame: true });
      const { Agent } = await import(${url('src/agent/agent.js')});
      const pack = path.join(${JSON.stringify(directory)}, 'schematics/schems/pack2');
      mkdirSync(pack, { recursive: true });
      writeFileSync(path.join(pack, 'index.json'), JSON.stringify({ schemaVersion: 2, groups: { 2: { 1: 'garden.schem' } } }));
      const file = path.join(pack, 'garden.mc1.21.4.schem'), bytes = syntheticSponge('1.21.4', ['minecraft:stone', 'minecraft:air']);
      writeFileSync(file, bytes); writeFixtureProvenance(file, bytes, 'NONVALIDATED');
      const f = fixture(['stone', 'air'], 2, '1.21.4'), bot = f.bot;
      const sender = '11111111-1111-4111-8111-111111111111', botId = '22222222-2222-4222-8222-222222222222';
      const session = '33333333-3333-4333-8333-333333333333';
      f.world.set('0,64,0', 'stone'); bot.output = ''; bot.autoEat = {}; bot.position = new Vec3(-2, 64, -2);
      bot.modes = { flushBehaviorLog: () => '' };
      bot.players = { Builder: { username: 'Builder', uuid: sender } }; bot.uuidToUsername = { [sender]: 'Builder' };
      bot.registry = { ...bot.registry, chatFormattingById: { 1: { name: 'minecraft:chat', formatString: '<%s> %s', parameters: ['sender', 'content'] } } };
      Object.assign(bot._client, { state: 'play', version: '1.21.4', uuid: botId, username: 'Andy', socket: { destroyed: false },
        session: { selectedProfile: { id: botId.replaceAll('-', ''), name: 'Andy' } }, serverFeatures: { enforcesSecureChat: true } });
      trackAuthenticatedChatConnection(bot, 'microsoft'); bot._client.emit('encryption_begin', { shouldAuthenticate: true });
      bot._client.cipher = {}; bot._client.decipher = {}; bot._client.emit('login', { enforcesSecureChat: true });
      protocolChat(bot._client, {}); chatPlugin(bot, {});
      const routes = [], agent = Object.create(Agent.prototype);
      Object.assign(agent, { name: 'Andy', bot, blocked_actions: [], task: { data: null },
        checkTaskDone: async () => {}, routeResponse: async (_source, text) => routes.push(text),
        actions: { cancelManagedResumeForUserCommand() {}, runAction: async (_label, fn) => { await fn(); return { message: bot.output }; } },
        self_prompter: { handleUserPromptedCmd() {}, isActive: () => false, shouldInterrupt: () => false },
        history: { add() {}, save() {}, getHistory: () => [] }, prompter: { promptConvo: async () => 'none' }, openChat() {} });
      await agent._setupEventHandlers(null, null);
      const handler = bot.listeners('chat')[0]; bot.removeListener('chat', handler);
      let delivery; bot.on('chat', (...args) => { delivery = handler(...args); });
      const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
      bot._client.emit('player_info', { data: [{ uuid: sender, chatSession: { uuid: session,
        publicKey: { keyBytes: keys.publicKey.export({ type: 'spki', format: 'der' }) } } }] });
      const text = 'Andy continue id 1 from group 2 of pack2 at 0 64 0', timestamp = BigInt(Date.now()), salt = 1n;
      const signed = concat('i32', 1, 'UUID', sender, 'UUID', session, 'i32', 0, 'i64', salt, 'i64', timestamp / 1000n,
        'i32', Buffer.byteLength(text), 'pstring', text, 'i32', 0);
      let verified; bot._client.once('playerChat', data => { verified = data.verified; });
      bot._client.emit('player_chat', { senderUuid: sender, plainMessage: text, type: 1,
        networkName: nbt.comp({ text: nbt.string('Builder') }), signature: sign('RSA-SHA256', signed, keys.privateKey),
        index: 0, previousMessages: [], salt, timestamp });
      await delivery;
      assert.equal(verified, true); assert.match(routes.join(' '), /continuation completed and verified/i);
      assert.deepEqual(f.writes, []); assert.deepEqual(f.modes, []);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
      { cwd: directory, encoding: 'utf8', timeout: 30000, env: process.env });
    assert.equal(child.status, 0, `${child.error || ''}\n${child.stderr}\n${child.stdout}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
