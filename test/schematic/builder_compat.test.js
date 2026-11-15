import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

import { beginCreativeSupply, loadSchematicBuilder } from '../../src/utils/schematic/builder_compat.js';

const require = createRequire(import.meta.url);
const schematicPlugin = require('mineflayer-schem').builder;
const { pathfinder: pathfinderPlugin, goals } = require('mineflayer-pathfinder');
const injectPluginLoader = require('mineflayer/lib/plugin_loader');
const minecraftData = require('minecraft-data');
const prismarineItem = require('prismarine-item');
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

test('aborting a timed-out close prevents late equipment and slot restoration writes', async () => {
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

    assert.equal(calls.supply.length, 1);
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
