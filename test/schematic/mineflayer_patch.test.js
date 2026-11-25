import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers';
import test from 'node:test';

const require = createRequire(import.meta.url);
const injectDigging = require('mineflayer/lib/plugins/digging');
const injectPlacement = require('mineflayer/lib/plugins/place_block');
const injectInventory = require('mineflayer/lib/plugins/inventory');
const { Vec3 } = require('vec3');
const minecraftData = require('minecraft-data');
const Block = require('prismarine-block')('1.21.4');

function diggingBot(version = '1.21.4') {
    const bot = new EventEmitter();
    Object.assign(bot, {
        version, game: { gameMode: 'survival' },
        entity: { position: new Vec3(0, 10, 0), eyeHeight: 1.62, onGround: true, effects: {} },
        heldItem: { type: minecraftData('1.21.4').itemsByName.iron_pickaxe.id, enchants: [] },
        inventory: { slots: [] }, getEquipmentDestSlot: () => 5,
        blockAt: () => ({ name: 'air' }),
    });
    injectDigging(bot);
    return bot;
}

test('version-bounded pickaxe correction preserves the original block and tool rules', () => {
    const bot = diggingBot();
    const ore = Block.fromStateId(minecraftData('1.21.4').blocksByName.iron_ore.defaultState, 0);
    assert.equal(ore.material, 'incorrect_for_wooden_tool');
    const upstream = ore.digTime(bot.heldItem.type, false, false, false, [], {});
    const corrected = bot.digTime(ore);
    assert.ok(corrected < upstream, `${corrected} should be faster than ${upstream}`);
    assert.equal(ore.material, 'incorrect_for_wooden_tool');
    bot.heldItem = null;
    assert.equal(bot.digTime(ore), ore.digTime(null, false, false, false, [], {}));
    bot.version = '1.21.5';
    bot.heldItem = { type: minecraftData('1.21.4').itemsByName.iron_pickaxe.id, enchants: [] };
    assert.equal(bot.digTime(ore), upstream);
    const unknown = Object.assign(Object.create(ore), { name: 'unreviewed_block' });
    bot.version = '1.21.4';
    assert.equal(bot.digTime(unknown), upstream);
});

test('digging uses eye-level water and respects aqua affinity, ground and creative mode', () => {
    const bot = diggingBot();
    const ore = Block.fromStateId(minecraftData('1.21.4').blocksByName.iron_ore.defaultState, 0);
    const dry = bot.digTime(ore);
    bot.blockAt = pos => { assert.ok(Math.abs(pos.y - 11.62) < 1e-9); return { name: 'water' }; };
    const wet = bot.digTime(ore);
    assert.ok(wet > dry * 4, `${wet} vs ${dry}`);
    bot.inventory.slots[5] = { enchants: [{ name: 'aqua_affinity', lvl: 1 }] };
    assert.equal(bot.digTime(ore), dry);
    bot.entity.onGround = false;
    assert.ok(bot.digTime(ore) > dry * 4);
    bot.game.gameMode = 'creative';
    assert.equal(bot.digTime(ore), 0);
});

test('item-use packet retains upstream yaw and pitch conversion', () => {
    const bot = new EventEmitter();
    const client = new EventEmitter();
    let packet;
    client.write = (name, data) => { packet = { name, data }; };
    Object.assign(bot, { _client: client, registry: minecraftData('1.21.4'), version: '1.21.4',
        entity: { yaw: Math.PI / 2, pitch: Math.PI / 4 },
        supportFeature: feature => feature === 'useItemWithOwnPacket' });
    injectInventory(bot, { hideErrors: false });
    bot.activateItem(true);
    assert.equal(packet.name, 'use_item');
    assert.equal(packet.data.hand, 1);
    assert.equal(packet.data.rotation.x, 90);
    assert.equal(packet.data.rotation.y, -45);
});

test('placement ignores stale updates, accepts a delayed reply, and rejects acknowledged refusal', async () => {
    const bot = new EventEmitter();
    const ref = { position: new Vec3(0, 0, 0) };
    const face = new Vec3(1, 0, 0);
    const dest = ref.position.plus(face);
    const air = { type: 0, name: 'air' };
    const stone = { type: 1, name: 'stone' };
    Object.assign(bot, { blockAt: () => air, heldItem: { name: 'stone' }, _genericPlace: async () => {} });
    injectPlacement(bot);
    let settled = false;
    const placing = bot.placeBlock(ref, face).finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    bot.emit(`blockUpdate:${dest}`, air, air);
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(settled, false);
    bot.emit(`blockUpdate:${ref.position}`, stone, stone);
    bot.emit(`blockUpdate:${dest}`, air, stone);
    await placing;
    const refused = bot.placeBlock(ref, face);
    await new Promise(resolve => setImmediate(resolve));
    bot.emit(`blockUpdate:${ref.position}`, stone, stone);
    bot.emit(`blockUpdate:${dest}`, air, air);
    await assert.rejects(refused, /Server refused to place/);
    assert.equal(bot.listenerCount(`blockUpdate:${dest}`), 0);
    assert.equal(bot.listenerCount(`blockUpdate:${ref.position}`), 0);
});
