import test from 'node:test';
import assert from 'node:assert/strict';
import * as ms from '../src/mindcraft/mindserver.js';

function fakeChild() {
    const child = {
        killed: false,
        exitCode: null,
        signalCode: null,
        killCalls: [],
        kill(signal) { this.killCalls.push(signal); this.killed = true; },
    };
    return child;
}

function sleep(msDelay) {
    return new Promise((resolve) => setTimeout(resolve, msDelay));
}

test('watchdog kills a disconnected agent whose fake child stays running', async () => {
    const name = 'hung-agent';
    const child = fakeChild();
    ms.registerAgent({ profile: { name } }, 3000, child);
    const conn = ms.getAgentConnections()[name];
    conn.socket = null;
    ms.startAgentWatchdog(name, child, 20);
    await sleep(60);
    assert.equal(child.killCalls.length, 1);
    assert.equal(child.killCalls[0], 'SIGKILL');
});

test('watchdog does not kill when agent reconnects before timeout', async () => {
    const name = 'reconnect-agent';
    const child = fakeChild();
    ms.registerAgent({ profile: { name } }, 3001, child);
    const conn = ms.getAgentConnections()[name];
    conn.socket = null;
    ms.startAgentWatchdog(name, child, 50);
    conn.socket = { id: 'new-socket' };
    await sleep(80);
    assert.equal(child.killCalls.length, 0);
});

test('watchdog does not kill when fake child exits before timeout', async () => {
    const name = 'exited-agent';
    const child = fakeChild();
    ms.registerAgent({ profile: { name } }, 3002, child);
    const conn = ms.getAgentConnections()[name];
    conn.socket = null;
    ms.startAgentWatchdog(name, child, 50);
    child.exitCode = 0;
    await sleep(80);
    assert.equal(child.killCalls.length, 0);
});

test('watchdog does not kill when agent is replaced before timeout', async () => {
    const name = 'replaced-agent';
    const child = fakeChild();
    ms.registerAgent({ profile: { name } }, 3003, child);
    const conn = ms.getAgentConnections()[name];
    conn.socket = null;
    ms.startAgentWatchdog(name, child, 50);
    const newChild = fakeChild();
    ms.registerAgent({ profile: { name } }, 3003, newChild);
    const newConn = ms.getAgentConnections()[name];
    newConn.socket = null;
    await sleep(80);
    assert.equal(child.killCalls.length, 0);
});