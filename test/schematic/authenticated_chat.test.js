import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
    authenticatedChatMessage, authenticatedPlayerName, trackAuthenticatedChatConnection,
} from '../../src/utils/authenticated_chat.js';

const sender = '11111111-1111-4111-8111-111111111111';
const botId = '22222222-2222-4222-8222-222222222222';

function fixture({ auth = 'microsoft', shouldAuthenticate = true, login = true, encrypted = true,
    secureChat = true, track = true, profileId = botId, request = { shouldAuthenticate },
    loginPacket = { enforcesSecureChat: secureChat } } = {}) {
    const client = Object.assign(new EventEmitter(), {
        state: 'play', uuid: botId, username: 'Andy', socket: { destroyed: false },
        session: { selectedProfile: { id: profileId.replaceAll('-', ''), name: 'Andy' } },
        serverFeatures: { enforcesSecureChat: secureChat },
    });
    const bot = {
        _client: client,
        players: { Builder: { username: 'Builder', uuid: sender } },
        uuidToUsername: { [sender]: 'Builder' },
        registry: { chatFormattingById: {
            1: { name: 'minecraft:chat', formatString: '<%s> %s', parameters: ['sender', 'content'] },
            2: { name: 'minecraft:msg_command_incoming', formatString: '%s whispers to you: %s', parameters: ['sender', 'content'] },
        } },
    };
    if (track) trackAuthenticatedChatConnection(bot, auth);
    client.emit('encryption_begin', request);
    if (encrypted) { client.cipher = {}; client.decipher = {}; }
    if (login) client.emit('login', loginPacket);
    const message = { sender, verified: true, plainMessage: 'ordinary player message', type: { chatType: 1 } };
    return { bot, client, message };
}

test('authenticated ordinary player metadata resolves an independent canonical identity', () => {
    const { bot, message } = fixture();
    assert.equal(authenticatedPlayerName(bot, sender), 'Builder');
    assert.deepEqual(authenticatedChatMessage(bot, message), {
        source: 'Builder', sender, client: bot._client, message: message.plainMessage,
    });
    assert.equal(authenticatedChatMessage(bot, { ...message, type: 1 }).source, 'Builder');
});

test('absent or unsupported deployment authentication fails closed', () => {
    for (const options of [
        { auth: 'offline' }, { auth: null },
        { shouldAuthenticate: false }, { request: {} }, { request: { shouldAuthenticate: 1 } },
        { login: false }, { loginPacket: {} }, { loginPacket: { enforcesSecureChat: 1 } },
        { encrypted: false }, { secureChat: false }, { secureChat: null },
        { track: false }, { profileId: sender },
    ]) {
        const { bot, message } = fixture(options);
        assert.equal(authenticatedChatMessage(bot, message), null, JSON.stringify(options));
    }
    for (const event of ['end', 'error']) {
        const { bot, client, message } = fixture();
        client.emit(event);
        assert.equal(authenticatedChatMessage(bot, message), null, event);
    }
});

test('late observations or changed settings cannot upgrade an unauthenticated connection', () => {
    const { bot, client, message } = fixture({ auth: 'offline' });
    trackAuthenticatedChatConnection(bot, 'microsoft');
    client.emit('encryption_begin', { shouldAuthenticate: true });
    client.emit('login', {});
    assert.equal(authenticatedChatMessage(bot, message), null);
    const late = fixture({ track: false });
    trackAuthenticatedChatConnection(late.bot, 'microsoft');
    assert.equal(authenticatedChatMessage(late.bot, late.message), null);
});

test('senderless, unverified and unsupported provenance never resolve an identity', () => {
    const { bot, message } = fixture();
    for (const patch of [
        { sender: null }, { sender: undefined }, { sender: '' }, { sender: 'not-a-uuid' },
        { sender: '00000000-0000-0000-0000-000000000000' },
        { sender: '33333333-3333-4333-8333-333333333333' },
        { verified: false }, { verified: undefined }, { verified: 1 },
        { type: undefined }, { type: 2 }, { type: 999 },
        { plainMessage: undefined }, { unsignedContent: 'ordinary player message' },
        { formattedMessage: 'ordinary player message' },
    ]) assert.equal(authenticatedChatMessage(bot, { ...message, ...patch }), null, JSON.stringify(patch));
    assert.equal(authenticatedChatMessage(bot, null), null);
    assert.equal(authenticatedChatMessage(bot, {}), null);
});

test('missing, inconsistent and ambiguous canonical player mappings fail closed', () => {
    const mutations = [
        bot => { delete bot.players; },
        bot => { delete bot.uuidToUsername; },
        bot => { delete bot.players.Builder.uuid; },
        bot => { bot.players.Builder.username = 'Other'; },
        bot => { bot.uuidToUsername[sender] = 'Other'; },
        bot => { bot.players.Other = { username: 'Other', uuid: sender }; },
        bot => { bot.uuidToUsername[sender.replaceAll('-', '')] = 'Builder'; },
        bot => { bot._client.state = 'configuration'; },
        bot => { bot._client.socket.destroyed = true; },
        bot => { delete bot._client.socket; },
        bot => { bot._client.session.selectedProfile.id = sender; },
        bot => { bot._client.serverFeatures.enforcesSecureChat = false; },
    ];
    for (const mutate of mutations) {
        const { bot, message } = fixture();
        mutate(bot);
        assert.equal(authenticatedChatMessage(bot, message), null, mutate.toString());
    }
    const { bot, message } = fixture();
    const originalClient = bot._client;
    bot._client = { ...originalClient };
    assert.equal(authenticatedChatMessage(bot, message), null);
    assert.equal(authenticatedPlayerName(bot, sender, originalClient), null);
});

test('custom or unreviewed message formatting cannot expand the allowed provenance type', () => {
    for (const patch of [
        { name: 'minecraft:system' }, { name: 'custom:chat' },
        { formatString: '%s: %s' }, { parameters: ['content', 'sender'] },
        { parameters: ['sender', 'content', 'target'] }, { parameters: undefined },
    ]) {
        const { bot, message } = fixture();
        Object.assign(bot.registry.chatFormattingById[1], patch);
        assert.equal(authenticatedChatMessage(bot, message), null);
    }
});
