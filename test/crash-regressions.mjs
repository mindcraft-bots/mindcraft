// Focused runtime reproductions for the five crashes in mindcraft issue #858 section A.
// No suite exists in this repository, so run with:
//   node --import ./test/register-crash-loader.mjs test/crash-regressions.mjs
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';

import { ItemGoal } from '../src/agent/npc/item_goal.js';
import convoManager from '../src/agent/conversation.js';
import * as skills from '../src/agent/library/skills.js';
import { createMindServer, registerAgent, getServer, getIO } from '../src/mindcraft/mindserver.js';
import { io as ioClient } from 'socket.io-client';

const uncaught = [];
process.on('uncaughtException', (err) => uncaught.push(err));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function check(name, fn) {
    try {
        await fn();
        console.log(`PASS ${name}`);
        return true;
    } catch (err) {
        console.log(`FAIL ${name}\n${err?.stack || err}`);
        return false;
    }
}

// A1: getItemCraftingRecipes() returns null for an item with no crafting recipe.
async function testItemGoal() {
    const goal = new ItemGoal({});
    const result = await goal.executeNext('uncraftable_item');
    assert.equal(result, false, 'goal with no methods should be invalid, not crash');
}

// A2: a chat message aimed at an agent whose socket is null while it restarts.
async function testMindServer() {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    let socket;
    let server;
    try {
        server = createMindServer(false, 0);
        if (!server.listening) {
            await new Promise((resolve) => server.once('listening', resolve));
        }
        const port = server.address().port;
        registerAgent({ profile: { name: 'Alice' } }, 3000);
        registerAgent({ profile: { name: 'Bob' } }, 3001);

        socket = ioClient(`http://localhost:${port}`);
        await new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('connect_error', reject);
        });
        socket.emit('login-agent', 'Alice');
        await wait(50);

        const errorsBefore = uncaught.length;
        socket.emit('chat-message', 'Bob', { message: 'hello' });
        await wait(100);

        assert.equal(uncaught.length, errorsBefore,
            `chat-message handler threw: ${uncaught[errorsBefore]?.stack}`);
        assert.ok(warnings.some((w) => w.includes('Bob') && w.includes('not connected right now')),
            `message drop warning missing; warnings=${JSON.stringify(warnings)}`);
    } finally {
        console.warn = originalWarn;
        if (socket) socket.close();
        if (getIO()) getIO().close();
        if (server?.listening) await new Promise((resolve) => server.close(resolve));
    }
}

// A3: endConversation() called for an ended convo while activeConversation is null.
function testEndConversation() {
    convoManager.convos['Ghost'] = { end() {} };
    convoManager.activeConversation = null;
    try {
        convoManager.endConversation('Ghost');
    } finally {
        delete convoManager.convos['Ghost'];
        convoManager.activeConversation = null;
    }
}

// A4: mineflayer palette pre-check calls the predicate with a block whose position is null.
async function testCollectBlockPalette() {
    const paletteBlock = { name: 'oak_log', position: null };
    const bot = {
        username: 'Bot',
        output: '',
        entity: { position: { x: 0, y: 0, z: 0 } },
        world: {},
        registry: minecraftData('1.21.8'),
        findBlocks({ matching }) {
            matching(paletteBlock);
            return [];
        },
        blockAt() { return null; },
    };
    await skills.collectBlock(bot, 'oak_log', 1, [{ x: 0, y: 0, z: 0 }]);
}

// A5: wrong-case and unknown player names must reach the existing "Could not find" message.
async function testPlayerLookups() {
    assert.equal(skills.findPlayerName({ players: { Steve: {} } }, 'steve'), 'Steve');
    assert.equal(skills.findPlayerName({ players: { Steve: {} } }, 'Offline'), undefined);

    for (const name of ['goToPlayer', 'followPlayer', 'giveToPlayer']) {
        for (const username of ['steve', 'Offline']) {
            const bot = {
                username: 'Bot',
                output: '',
                players: {},
                modes: { isOn() { return false; }, pause() {}, unpause() {} },
                entity: { position: { x: 0, y: 0, z: 0 } },
            };
            const result = await skills[name](bot, username);
            assert.equal(result, false, `${name}("${username}") should fail cleanly`);
            if (name !== 'followPlayer') {
                assert.match(bot.output, /Could not find/,
                    `${name}("${username}") should keep its existing message`);
            }
        }
    }
}

const checks = [
    ['A1 item_goal null recipes', testItemGoal],
    ['A2 mindserver null socket', testMindServer],
    ['A3 endConversation null active', testEndConversation],
    ['A4 collectBlock palette position null', testCollectBlockPalette],
    ['A5 player name lookup', testPlayerLookups],
];

const results = [];
for (const [name, fn] of checks) {
    results.push(await check(name, fn));
}
console.log(`${results.filter(Boolean).length}/${results.length} crash reproductions pass`);
process.exitCode = results.every(Boolean) ? 0 : 1;
