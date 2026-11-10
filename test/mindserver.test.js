import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { io } from 'socket.io-client';
import { createMindServer, registerAgent } from '../src/mindcraft/mindserver.js';

test('MindServer handles unavailable agents and keeps relaying after reconnect', { timeout: 10_000 }, async (t) => {
    const senderName = 'relay-sender';
    const receiverName = 'relay-receiver';
    registerAgent({ profile: { name: senderName } }, 3000);
    registerAgent({ profile: { name: receiverName } }, 3001);

    const server = createMindServer(false, 0);
    const clients = [];
    t.after(async () => {
        for (const client of clients) client.disconnect();
        await new Promise(resolve => server.close(resolve));
    });
    await once(server, 'listening', { signal: AbortSignal.timeout(2000) });
    const { address, port, family } = server.address();
    const url = `http://${family === 'IPv6' ? `[${address}]` : address}:${port}`;

    async function connect(name) {
        const accepted = once(server, 'connection', { signal: AbortSignal.timeout(2000) });
        const client = io(url, { transports: ['websocket'], reconnection: false });
        clients.push(client);
        await once(client, 'connect', { signal: AbortSignal.timeout(2000) });
        const [connection] = await accepted;
        client.emit('login-agent', name);
        const response = await client.timeout(2000).emitWithAck('get-settings', name);
        assert.equal(response.settings.profile.name, name);
        return { client, connection };
    }

    async function disconnect({ client, connection }) {
        const closed = once(connection, 'close', { signal: AbortSignal.timeout(2000) });
        client.disconnect();
        await closed;
    }

    const { client: sender } = await connect(senderName);
    sender.emit('chat-message', receiverName, { message: 'Recipient not connected yet' });
    sender.emit('restart-agent', 'unknown-agent');
    sender.emit('restart-agent', receiverName);
    const updatedSettings = { profile: { name: receiverName }, init_message: 'Keep this change' };
    sender.emit('set-agent-settings', receiverName, updatedSettings);
    const offline = await sender.timeout(2000).emitWithAck('get-settings', receiverName);
    assert.deepEqual(offline.settings, updatedSettings);

    const oldReceiver = await connect(receiverName);
    const receiver = await connect(receiverName);
    await disconnect(oldReceiver);

    const message = { message: 'Delivered after reconnect' };
    const relayed = once(receiver.client, 'chat-message', { signal: AbortSignal.timeout(2000) });
    sender.emit('chat-message', receiverName, message);
    assert.deepEqual(await relayed, [senderName, message]);

    const restarted = once(receiver.client, 'restart-agent', { signal: AbortSignal.timeout(2000) });
    sender.emit('restart-agent', receiverName);
    await restarted;

    await disconnect(receiver);
    sender.emit('chat-message', receiverName, { message: 'Recipient disconnected again' });
    const afterDisconnect = await sender.timeout(2000).emitWithAck('get-settings', receiverName);
    assert.deepEqual(afterDisconnect.settings, updatedSettings);
});
