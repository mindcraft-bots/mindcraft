import test from 'node:test';
import assert from 'node:assert/strict';
import { planBridge, snapDirection } from '../src/agent/library/bridge_plan.js';

function surfaceFor(x) {
    if (x === 0 || x === 6)
        return { y: 63, water: false };
    if (x >= 1 && x <= 5)
        return { y: 62, water: true };
    return null;
}

test('snapDirection maps yaw to the nearest cardinal direction', () => {
    assert.deepEqual(snapDirection(0), { x: 0, z: 1 }); // south (+Z)
    assert.deepEqual(snapDirection(Math.PI / 2), { x: -1, z: 0 }); // west (-X)
    assert.deepEqual(snapDirection(Math.PI), { x: 0, z: -1 }); // north (-Z)
    assert.deepEqual(snapDirection(-Math.PI / 2), { x: 1, z: 0 }); // east (+X)
});

test('planBridge builds a raised deck with pillars, railings, and landings', () => {
    const plan = planBridge({
        getSurface: (x) => surfaceFor(x),
        start: { x: 0, z: 0 },
        dir: { x: 1, z: 0 },
    });

    assert.equal(plan.error, undefined);
    assert.equal(plan.length, 5);
    assert.equal(plan.waterY, 62);
    assert.equal(plan.deckY, 64); // water + 2 (one air block gap)
    assert.equal(plan.deck.length, 5);
    assert.equal(plan.landings.length, 2);
    assert.equal(plan.stairs.length, 0); // one-block rise: landing is the step
    assert.equal(plan.spacing, 3);

    // Pillars at columns 0, 3, and 4; each spans deckY-1 .. waterY.
    assert.equal(plan.pillars.length, 3 * 2);
    assert.deepEqual(
        [...new Set(plan.pillars.map(p => p.x))].sort((a, b) => a - b),
        [1, 4, 5]
    );
    assert.ok(plan.pillars.every(p => p.y >= plan.waterY && p.y <= plan.deckY - 1));

    // Two railings per deck column, one block above the deck.
    assert.equal(plan.railings.length, 10);
    assert.ok(plan.railings.every(r => r.y === plan.deckY + 1));
    assert.deepEqual(
        [...new Set(plan.railings.map(r => r.x))].sort((a, b) => a - b),
        [1, 2, 3, 4, 5]
    );
    assert.deepEqual(
        [...new Set(plan.railings.map(r => r.z))].sort((a, b) => a - b),
        [-1, 1]
    );
});

test('planBridge adds stairs when the landing is above the shore', () => {
    const plan = planBridge({
        getSurface: (x) => {
            if (x === 0 || x === 6)
                return { y: 60, water: false };
            if (x >= 1 && x <= 5)
                return { y: 60, water: true };
            return null;
        },
        start: { x: 0, z: 0 },
        dir: { x: 1, z: 0 },
    });

    assert.equal(plan.deckY, 62);
    assert.equal(plan.landings.length, 2);
    assert.equal(plan.stairs.length, 2); // one step per shore (deckY - shoreY - 1)
    assert.ok(plan.stairs.every(s => s.block === 'oak_stairs'));
});

test('planBridge reports when there is no water ahead', () => {
    const plan = planBridge({
        getSurface: () => ({ y: 64, water: false }),
        start: { x: 0, z: 0 },
        dir: { x: 1, z: 0 },
    });
    assert.match(plan.error, /No water found/);
});
