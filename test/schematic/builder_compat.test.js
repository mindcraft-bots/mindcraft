import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

import { beginCreativeSupply, loadSchematicBuilder } from '../../src/utils/schematic/builder_compat.js';
import { serializeCreativeSlotWrite } from '../../src/utils/creative_slot.js';

const require = createRequire(import.meta.url);
const schematicPlugin = require('mineflayer-schem').builder;
const { pathfinder: pathfinderPlugin, goals } = require('mineflayer-pathfinder');
const injectPluginLoader = require('mineflayer/lib/plugin_loader');
const minecraftData = require('minecraft-data');
const prismarineItem = require('prismarine-item');
const realCreativePlugin = require('mineflayer/lib/plugins/creative');
const { Vec3 } = require('vec3');
const VERSION = '1.20.4';
const registry = minecraftData(VERSION);
const Item = prismarineItem(VERSION);
const Block = require('prismarine-block')(registry);

function fakeBot({ creative = true, originalSlot = null } = {}) {
    const calls = { supply: [], equip: [], chat: [], goal: [], movements: [] };
    const bot = {
        version: VERSION,
        game: { gameMode: creative ? 'creative' : 'survival' },
        registry,
        inventory: {
            slots: Array(46).fill(null),
            items() {
                return this.slots.filter(Boolean);
            },
        },
        creative: {
            setInventorySlot(slot, item) {
                calls.supply.push({ slot, item });
                bot.inventory.slots[slot] = item;
            },
        },
        equip: (item, destination) => {
            calls.equip.push({ item, destination });
            return Promise.resolve();
        },
        chat: (...args) => calls.chat.push(args),
        pathfinder: {
            movements: { policy: 'skill-default' },
            setMovements(movements) {
                calls.movements.push(movements);
                this.movements = movements;
            },
            setGoal(goal) {
                calls.goal.push(goal);
            },
        },
        loadPlugin(plugin) {
            plugin(bot);
        },
    };
    bot.inventory.slots[36] = originalSlot;
    return { bot, calls };
}

test('loads mineflayer-schem without retaining its global pathfinder movements', () => {
    const { bot, calls } = fakeBot();
    const originalMovements = bot.pathfinder.movements;
    bot.pathfinder.searchRadius = -1;
    assert.equal(bot.builder, undefined);

    const builder = loadSchematicBuilder(bot);

    assert.equal(builder, bot.builder);
    assert.equal(bot.pathfinder.movements, originalMovements);
    assert.equal(bot.pathfinder.searchRadius, -1);
    assert.equal(calls.movements.length, 2);
    assert.equal(calls.movements[1], originalMovements);
    assert.equal(builder.equipItem instanceof Function, true);
});

test('real pathfinder keeps unrestricted searchRadius and routes around a distant wall', () => {
    const bot = new EventEmitter();
    bot.version = VERSION;
    bot.game = { gameMode: 'creative' };
    bot.registry = registry;
    bot.inventory = {
        slots: Array(46).fill(null),
        items() {
            return this.slots.filter(Boolean);
        },
    };
    bot.creative = { setInventorySlot() {} };
    bot.entity = {
        position: new Vec3(0, 64, 0),
        effects: {},
        onGround: true,
        isInLava: false,
    };
    bot.entities = {};
    bot.controlState = {};
    bot.clearControlStates = () => {};
    bot.setControlState = () => {};
    bot.blockAt = (position) => {
        const { x, y, z } = position.floored();
        const isFloor = y === 63;
        const isWall = x === 5 && z >= -12 && z <= 12 && (y === 64 || y === 65);
        const blockName = isFloor || isWall ? 'stone' : 'air';
        const blockInfo = registry.blocksByName[blockName];
        const block = Block.fromStateId(blockInfo.minStateId, 0);
        block.position = new Vec3(x, y, z);
        return block;
    };
    injectPluginLoader(bot, {});
    bot.loadPlugin(pathfinderPlugin);

    assert.doesNotThrow(() => bot.emit('inject_allowed'));
    const originalMovements = bot.pathfinder.movements;
    originalMovements.canDig = false;
    bot.pathfinder.setMovements(originalMovements);
    bot.pathfinder.tickTimeout = 5000;
    const goal = new goals.GoalBlock(10, 64, 0);
    bot.pathfinder.searchRadius = 10;
    const radiusLimitedRoute = bot.pathfinder.getPathTo(originalMovements, goal);
    assert.notEqual(radiusLimitedRoute.status, 'success');

    bot.pathfinder.searchRadius = undefined;
    const unrestrictedRoute = bot.pathfinder.getPathTo(originalMovements, goal);
    assert.equal(unrestrictedRoute.status, 'success');

    loadSchematicBuilder(bot);
    bot.emit('inject_allowed');

    assert.equal(bot.pathfinder.movements, originalMovements);
    assert.equal(bot.pathfinder.movements.canDig, false);
    assert.equal(bot.pathfinder.searchRadius, undefined);
    const routeAfterInjection = bot.pathfinder.getPathTo(bot.pathfinder.movements, goal);
    assert.equal(routeAfterInjection.status, 'success');
    assert.ok(routeAfterInjection.path.some((move) => move.z < -12 || move.z > 12));
});

test('queues schematic compatibility after pathfinder with Mineflayer plugin loader', async () => {
    const bot = new EventEmitter();
    bot.version = VERSION;
    bot.game = { gameMode: 'creative' };
    bot.registry = registry;
    bot.inventory = {
        slots: Array(46).fill(null),
        items() {
            return this.slots.filter(Boolean);
        },
    };
    bot.creative = {
        setInventorySlot(slot, item) {
            bot.inventory.slots[slot] = item;
        },
    };
    bot.equip = async () => {};
    bot.clearControlStates = () => {};
    bot.blockAt = () => null;
    injectPluginLoader(bot, {});

    bot.loadPlugin(pathfinderPlugin);
    let priorMovements;
    bot.loadPlugin((injectedBot) => {
        priorMovements = injectedBot.pathfinder.movements;
        priorMovements.allowParkour = false;
    });

    assert.doesNotThrow(() => loadSchematicBuilder(bot));
    assert.equal(bot.pathfinder, undefined);
    assert.equal(bot.builder, undefined);

    assert.doesNotThrow(() => bot.emit('inject_allowed'));
    assert.ok(bot.builder);
    assert.equal(bot.pathfinder.movements, priorMovements);
    assert.equal(bot.pathfinder.movements.allowParkour, false);

    const cleanup = beginCreativeSupply(bot);
    const equipped = await bot.builder.equipItem(registry.itemsByName.stone.id);
    assert.equal(equipped.type, registry.itemsByName.stone.id);
    assert.equal(bot.inventory.slots[36], equipped);

    bot.builder.stop();
    assert.equal(bot.pathfinder.goal, null);
    await cleanup();
});

test('builder.stop cancels the builder and clears the current pathfinder goal', () => {
    const { bot, calls } = fakeBot();
    loadSchematicBuilder(bot);
    let cancelled = false;
    bot.builder.cancel = () => { cancelled = true; };

    bot.builder.stop();

    assert.equal(cancelled, true);
    assert.deepEqual(calls.goal, [null]);
});

test('Creative supply reuses reserved slot 36 for sequential palette types and restores it', async () => {
    const original = new Item(registry.itemsByName.dirt.id, 12, 0);
    const { bot, calls } = fakeBot({ originalSlot: original });
    loadSchematicBuilder(bot);
    const cleanup = beginCreativeSupply(bot);
    const typeIds = ['oak_planks', 'mangrove_planks', 'red_wool', 'blue_wool']
        .map((name) => registry.itemsByName[name].id);

    for (const type of typeIds) {
        const equipped = await bot.builder.equipItem(type);
        assert.equal(equipped.type, type);
        assert.equal(bot.inventory.slots[36].type, type);
    }

    assert.equal(calls.supply.length, typeIds.length);
    assert.deepEqual(calls.supply.map(({ slot }) => slot), Array(typeIds.length).fill(36));
    assert.equal(calls.equip.length, typeIds.length);
    assert.deepEqual(calls.chat, []);
    await cleanup();
    assert.equal(calls.supply.at(-1).item, original);
    assert.equal(bot.inventory.slots[36], original);
});

test('rejects cancelled and non-Creative supply without writing inventory', async () => {
    const nonCreative = fakeBot({ creative: false });
    loadSchematicBuilder(nonCreative.bot);
    const firstCleanup = beginCreativeSupply(nonCreative.bot);
    await assert.rejects(nonCreative.bot.builder.equipItem(registry.itemsByName.stone.id), /Creative mode/);
    assert.equal(nonCreative.calls.supply.length, 0);
    await firstCleanup();

    const { bot, calls } = fakeBot();
    loadSchematicBuilder(bot);
    const cleanup = beginCreativeSupply(bot);
    cleanup.cancel();
    await assert.rejects(bot.builder.equipItem(registry.itemsByName.stone.id), /cancelled or closed/);
    assert.equal(calls.supply.length, 0);
    await cleanup();
});

test('closing a session prevents queued equips from writing after cancellation', async () => {
    const { bot, calls } = fakeBot();
    loadSchematicBuilder(bot);
    const cleanup = beginCreativeSupply(bot);
    let releaseSupply;
    let supplyStarted;
    const started = new Promise((resolve) => { supplyStarted = resolve; });
    const supplyPending = new Promise((resolve) => { releaseSupply = resolve; });
    const originalSupply = bot.creative.setInventorySlot;
    bot.creative.setInventorySlot = async (slot, item) => {
        if (calls.supply.length === 0) {
            calls.supply.push({ slot, item });
            supplyStarted();
            await supplyPending;
            bot.inventory.slots[slot] = item;
            return;
        }
        await originalSupply(slot, item);
    };

    const pendingEquip = bot.builder.equipItem(registry.itemsByName.stone.id);
    await started;
    const closing = cleanup();
    releaseSupply();
    await assert.rejects(pendingEquip, /cancelled or closed/);
    await closing;
    assert.equal(calls.supply.length, 2); // one supply write and the final slot restore
    assert.equal(calls.supply[1].item, null);
});

test('aborting while a write is unsettled waits for it before restoring the slot', async () => {
    const { bot, calls } = fakeBot();
    loadSchematicBuilder(bot);
    const cleanup = beginCreativeSupply(bot);
    let releaseSupply;
    let supplyStarted;
    const started = new Promise((resolve) => { supplyStarted = resolve; });
    const supplyPending = new Promise((resolve) => { releaseSupply = resolve; });
    bot.creative.setInventorySlot = async (slot, item) => {
        calls.supply.push({ slot, item });
        supplyStarted();
        await supplyPending;
        bot.inventory.slots[slot] = item;
    };

    const pendingEquip = bot.builder.equipItem(registry.itemsByName.stone.id);
    await started;
    const closing = cleanup();
    cleanup.abort();
    releaseSupply();
    await assert.rejects(pendingEquip, /cancelled or closed/);
    await closing;

    assert.equal(calls.supply.length, 2);
    assert.equal(calls.supply[1].item, null);
    assert.equal(calls.equip.length, 0);
});

test('uses mineflayer-schem equipItem item-id contract and never invokes clear or chest logic', async () => {
    assert.equal(typeof schematicPlugin, 'function');
    const { bot, calls } = fakeBot();
    loadSchematicBuilder(bot);
    const cleanup = beginCreativeSupply(bot);
    const result = await bot.builder.equipItem(registry.itemsByName.stone.id);

    assert.equal(result.type, registry.itemsByName.stone.id);
    assert.equal(calls.chat.length, 0);
    assert.equal(calls.supply.some(({ item }) => item?.type === registry.itemsByName.stone.id), true);
    await cleanup();
});

function installRealCreativePlugin(bot, version, { noAck = false, ackDelayMs = 0 } = {}) {
    const data = minecraftData(version);
    const VersionItem = prismarineItem(data);
    const writes = [];
    bot.version = version;
    bot.registry = data;
    bot.inventory = Object.assign(new EventEmitter(), {
        slots: Array(46).fill(null),
        items() { return this.slots.filter(Boolean); },
        findInventoryItem(name) { return this.slots.find((item) => item?.name === name) ?? null; },
    });
    bot.supportFeature = (feature) => feature === 'noAckOnCreateSetSlotPacket' && noAck;
    bot._setSlot = (slot, item) => {
        const oldItem = bot.inventory.slots[slot];
        bot.inventory.slots[slot] = item;
        bot.inventory.emit(`updateSlot:${slot}`, oldItem, item);
    };
    bot._client = {
        write(packetName, packet) {
            assert.equal(packetName, 'set_creative_slot');
            const item = packet.item == null ? null : VersionItem.fromNotch(packet.item);
            writes.push({ slot: packet.slot, item });
            if (!noAck) {
                const delay = typeof ackDelayMs === 'function'
                    ? ackDelayMs({ slot: packet.slot, item, writes })
                    : ackDelayMs;
                setTimeout(() => bot._setSlot(packet.slot, item), delay);
            }
        },
    };
    realCreativePlugin(bot);
    return { data, Item: VersionItem, writes };
}

test('real Mineflayer creative plugin rejects overlapping same-slot calls; shared lease serializes builder and skill writers', async () => {
    const direct = fakeBot();
    const directPlugin = installRealCreativePlugin(direct.bot, VERSION, { ackDelayMs: 15 });
    const first = direct.bot.creative.setInventorySlot(36, new directPlugin.Item(registry.itemsByName.stone.id, 1, 0));
    await assert.rejects(
        direct.bot.creative.setInventorySlot(36, new directPlugin.Item(registry.itemsByName.dirt.id, 1, 0)),
        /Setting slot 36 cancelled due to calling/,
    );
    await first;

    const { bot } = fakeBot();
    const plugin = installRealCreativePlugin(bot, VERSION, { ackDelayMs: 15 });
    bot.inventory.slots[36] = new plugin.Item(registry.itemsByName.dirt.id, 2, 0);
    bot.output = '';
    loadSchematicBuilder(bot);
    const cleanup = beginCreativeSupply(bot);
    const equipped = await bot.builder.equipItem(plugin.data.itemsByName.stone.id);
    assert.equal(equipped.type, plugin.data.itemsByName.stone.id);

    const skillWrite = serializeCreativeSlotWrite(bot, 36, () => bot.creative.setInventorySlot(
        36,
        new plugin.Item(plugin.data.itemsByName.oak_planks.id, 1, 0),
    ));
    await cleanup();
    await skillWrite;
    assert.deepEqual(plugin.writes.map(({ item }) => item?.name ?? null), ['stone', 'dirt', 'oak_planks']);
});

test('no-ack Creative cleanup restores through Mineflayer without waiting for nonexistent packet updates on 1.21.4 and 26.1', async () => {
    for (const version of ['1.21.4', '26.1']) {
        const data = minecraftData(version);
        const VersionItem = prismarineItem(data);
        const { bot } = fakeBot();
        const plugin = installRealCreativePlugin(bot, version, { noAck: true });
        bot.inventory.slots[36] = new VersionItem(data.itemsByName.dirt.id, 3, 0);
        loadSchematicBuilder(bot);
        const cleanup = beginCreativeSupply(bot);
        const equip = bot.builder.equipItem(data.itemsByName.stone.id);
        await equip;
        await Promise.race([
            cleanup(),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`${version} no-ack cleanup timed out`)), 1_500)),
        ]);
        assert.equal(bot.inventory.slots[36].name, 'dirt', version);
        assert.deepEqual(plugin.writes.map(({ item }) => item?.name ?? null), ['stone', 'dirt'], version);
        const nextCleanup = beginCreativeSupply(bot);
        await nextCleanup();
    }
});

test('failed serialized creative writes do not poison the slot queue', async () => {
    const { bot } = fakeBot();
    const order = [];
    await assert.rejects(serializeCreativeSlotWrite(bot, 36, async () => {
        order.push('failed');
        throw new Error('simulated creative write failure');
    }), /simulated creative write failure/);
    await serializeCreativeSlotWrite(bot, 36, async () => { order.push('next'); });
    assert.deepEqual(order, ['failed', 'next']);
});

test('no-ack Mineflayer writes settle locally and release the shared queue for the next write', async () => {
    const { bot } = fakeBot();
    const plugin = installRealCreativePlugin(bot, '1.21.4', { noAck: true });
    await serializeCreativeSlotWrite(bot, 36, () => bot.creative.setInventorySlot(
        36,
        new plugin.Item(plugin.data.itemsByName.stone.id, 1, 0),
    ));
    await serializeCreativeSlotWrite(bot, 36, () => bot.creative.setInventorySlot(
        36,
        new plugin.Item(plugin.data.itemsByName.oak_planks.id, 1, 0),
    ));
    assert.deepEqual(plugin.writes.map(({ item }) => item?.name), ['stone', 'oak_planks']);
    assert.equal(bot.inventory.slots[36].name, 'oak_planks');
});

test('settled aborted no-ack cleanup restores, releases queued writers, and permits a new supply', async () => {
    const { bot } = fakeBot();
    const plugin = installRealCreativePlugin(bot, '26.1', { noAck: true });
    loadSchematicBuilder(bot);
    const cleanup = beginCreativeSupply(bot);
    const equipped = await bot.builder.equipItem(plugin.data.itemsByName.stone.id);
    assert.equal(equipped.name, 'stone');
    cleanup.abort();
    const ordinaryWrite = serializeCreativeSlotWrite(bot, 36, () => bot.creative.setInventorySlot(
        36,
        new plugin.Item(plugin.data.itemsByName.oak_planks.id, 1, 0),
    ));

    await cleanup();
    await ordinaryWrite;
    assert.equal(bot.inventory.slots[36].name, 'oak_planks');

    const nextCleanup = beginCreativeSupply(bot);
    await bot.builder.equipItem(plugin.data.itemsByName.stone.id);
    await nextCleanup();
    assert.equal(bot.inventory.slots[36].name, 'oak_planks');
    assert.deepEqual(plugin.writes.map(({ item }) => item?.name ?? null), ['stone', null, 'oak_planks', 'stone', 'oak_planks']);
});

test('real creative plugin timeout followed by late acknowledgement restores before ordinary and new owners', async () => {
    const { bot } = fakeBot();
    const plugin = installRealCreativePlugin(bot, VERSION, {
        ackDelayMs: ({ item, writes }) => item?.name === 'stone'
            && writes.filter((write) => write.item?.name === 'stone').length === 1
            ? 5_050
            : 0,
    });
    const original = new plugin.Item(plugin.data.itemsByName.dirt.id, 2, 0);
    bot.inventory.slots[36] = original;
    loadSchematicBuilder(bot);
    const cleanup = beginCreativeSupply(bot);

    await assert.rejects(
        bot.builder.equipItem(plugin.data.itemsByName.stone.id),
        /Timed out|timeout/i,
    );
    const ordinaryWrite = serializeCreativeSlotWrite(bot, 36, () => bot.creative.setInventorySlot(
        36,
        new plugin.Item(plugin.data.itemsByName.oak_planks.id, 1, 0),
    ));
    await cleanup();
    await ordinaryWrite;
    assert.equal(bot.inventory.slots[36].name, 'oak_planks');

    const nextCleanup = beginCreativeSupply(bot);
    await bot.builder.equipItem(plugin.data.itemsByName.stone.id);
    await nextCleanup();
    assert.equal(bot.inventory.slots[36].name, 'oak_planks');
});

test('never-settling real-plugin supply is quarantined and queued writers fail explicitly after cancellation', async () => {
    const { bot } = fakeBot();
    const plugin = installRealCreativePlugin(bot, '26.1', { noAck: true });
    const pluginWrite = bot.creative.setInventorySlot;
    let intercepted = false;
    bot.creative.setInventorySlot = (...args) => {
        if (!intercepted) {
            intercepted = true;
            void pluginWrite.apply(bot.creative, args);
            return new Promise(() => {});
        }
        return pluginWrite.apply(bot.creative, args);
    };
    loadSchematicBuilder(bot);
    const cleanup = beginCreativeSupply(bot);
    const pendingEquip = bot.builder.equipItem(plugin.data.itemsByName.stone.id);
    const queuedWriter = serializeCreativeSlotWrite(bot, 36, () => {
        throw new Error('quarantined writer must not run');
    });
    while (plugin.writes.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    cleanup.abort();

    await assert.rejects(pendingEquip, /did not settle/i);
    await assert.rejects(cleanup(), /remains quarantined/i);
    await assert.rejects(queuedWriter, /remains quarantined/i);
    const nextCleanup = beginCreativeSupply(bot);
    await assert.rejects(bot.builder.equipItem(plugin.data.itemsByName.stone.id), /remains quarantined/i);
    await assert.rejects(nextCleanup(), /remains quarantined/i);
});
