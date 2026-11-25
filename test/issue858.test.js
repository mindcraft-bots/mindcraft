import test from 'node:test';
import assert from 'node:assert/strict';
import Vec3 from 'vec3';
import { placeBlock, startDoorInterval } from '../src/agent/library/skills.js';

const FULL_CUBE = [[0, 0, 0, 1, 1, 1]];
const CHEST_SHAPE = [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]];
const key = p => `${p.x},${p.y},${p.z}`;

function makeBlock(name, shapes = FULL_CUBE, props = {}, position = null) {
    return { name, shapes, position, getProperties: () => props };
}

function makePlacementBot(blockMap, itemName) {
    const placed = [];
    const bot = {
        output: '',
        modes: { isOn: () => false },
        restrict_to_inventory: false,
        game: { gameMode: 'survival' },
        inventory: { findInventoryItem: () => ({ name: itemName }) },
        entity: { position: new Vec3(3, 64, 0) },
        blockAt: p => {
            const block = blockMap.get(key(p));
            return block ? { ...block, position: p.clone() } : makeBlock('air', [], {}, p.clone());
        },
        equip: async () => {},
        lookAt: async () => {},
        placeBlock: async (block, faceVec) => {
            placed.push({ name: block.name, face: [faceVec.x, faceVec.y, faceVec.z] });
        },
    };
    return { bot, placed };
}

function fakeClock() {
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;
    const realNow = Date.now;
    let now = 1000;
    let callback = null;
    global.setInterval = cb => { callback = cb; return 4242; };
    global.clearInterval = () => {};
    Date.now = () => now;
    return {
        advance: ms => { now += ms; },
        tick: () => callback(),
        restore: () => {
            global.setInterval = realSetInterval;
            global.clearInterval = realClearInterval;
            Date.now = realNow;
        },
    };
}

function stuckDoorBot(open) {
    const activated = [];
    const origin = new Vec3(0, 64, 0);
    const door = makeBlock('oak_door', [], { open });
    const bot = {
        output: '',
        entity: { position: origin.clone() },
        blockAt: p => (p.x === origin.x && p.y === origin.y && p.z === origin.z)
            ? { ...door, position: p.clone() }
            : makeBlock('air', [], {}, p.clone()),
        activateBlock: block => { activated.push(block.name); return Promise.resolve(); },
    };
    return { bot, activated };
}

test('stuck helper does not toggle a door that is already open', () => {
    const clock = fakeClock();
    try {
        const { bot, activated } = stuckDoorBot(true);
        startDoorInterval(bot);
        clock.advance(1300);
        clock.tick();
        assert.deepEqual(activated, []);
    } finally {
        clock.restore();
    }
});

test('stuck helper still opens a closed door', () => {
    const clock = fakeClock();
    try {
        const { bot, activated } = stuckDoorBot(false);
        startDoorInterval(bot);
        clock.advance(1300);
        clock.tick();
        assert.deepEqual(activated, ['oak_door']);
    } finally {
        clock.restore();
    }
});

test('torch prefers a firm cube over a clickable crafting table and never uses the ceiling', async () => {
    const blocks = new Map([
        [key(new Vec3(0, 63, 0)), makeBlock('crafting_table')],
        [key(new Vec3(0, 65, 0)), makeBlock('stone')],
        [key(new Vec3(0, 64, -1)), makeBlock('stone')],
    ]);
    const { bot, placed } = makePlacementBot(blocks, 'torch');
    assert.equal(await placeBlock(bot, 'torch', 0, 64, 0), true);
    assert.deepEqual(placed, [{ name: 'stone', face: [0, 0, 1] }]);
});

test('torch prefers a firm cube over a chest', async () => {
    const blocks = new Map([
        [key(new Vec3(0, 63, 0)), makeBlock('chest', CHEST_SHAPE)],
        [key(new Vec3(0, 64, -1)), makeBlock('stone')],
    ]);
    const { bot, placed } = makePlacementBot(blocks, 'torch');
    assert.equal(await placeBlock(bot, 'torch', 0, 64, 0), true);
    assert.deepEqual(placed, [{ name: 'stone', face: [0, 0, 1] }]);
});

test('torch is not hung from a ceiling when that is the only support', async () => {
    const blocks = new Map([[key(new Vec3(0, 65, 0)), makeBlock('stone')]]);
    const { bot, placed } = makePlacementBot(blocks, 'torch');
    assert.equal(await placeBlock(bot, 'torch', 0, 64, 0), false);
    assert.deepEqual(placed, []);
});

test('placement still falls back to the first touching block when it is clickable', async () => {
    const blocks = new Map([[key(new Vec3(0, 63, 0)), makeBlock('crafting_table')]]);
    const { bot, placed } = makePlacementBot(blocks, 'oak_log');
    assert.equal(await placeBlock(bot, 'oak_log', 0, 64, 0), true);
    assert.deepEqual(placed, [{ name: 'crafting_table', face: [0, 1, 0] }]);
});
