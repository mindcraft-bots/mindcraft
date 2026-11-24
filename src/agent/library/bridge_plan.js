const WATER_BLOCKS = new Set([
    'water', 'flowing_water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'
]);

export function isWaterBlock(name) {
    return WATER_BLOCKS.has(name);
}

export function snapDirection(yaw) {
    const dx = -Math.sin(yaw);
    const dz = Math.cos(yaw);
    if (Math.abs(dx) >= Math.abs(dz))
        return { x: dx >= 0 ? 1 : -1, z: 0 };
    return { x: 0, z: dz >= 0 ? 1 : -1 };
}

export function findBridgeSpan({ getSurface, start, dir, maxLength = 64 }) {
    const startSurface = getSurface(start.x, start.z);
    let nearShore = startSurface && !startSurface.water
        ? { x: start.x, z: start.z, y: startSurface.y }
        : null;
    const water = [];
    let farShore = null;

    for (let i = 1; i <= maxLength; i++) {
        const x = start.x + dir.x * i;
        const z = start.z + dir.z * i;
        const surface = getSurface(x, z);
        if (!surface)
            continue;
        if (surface.water) {
            water.push({ x, z, y: surface.y });
        } else if (water.length === 0) {
            nearShore = { x, z, y: surface.y };
        } else {
            farShore = { x, z, y: surface.y };
            break;
        }
    }

    if (water.length === 0)
        return { error: 'No water found ahead. Stand on the shore and face the water.' };
    if (!farShore)
        return { error: 'Could not find the far shore within range. Face the water and try again.' };
    if (!nearShore)
        return { error: 'Could not find the near shore. Stand on land facing the water.' };
    return { nearShore, farShore, water };
}

/**
 * Plan a single-width bridge with a deck, pillars, railings, landings, and stairs.
 * Pure function: pass a getSurface(x, z) callback returning { y, water }.
 */
export function planBridge({
    getSurface,
    start,
    dir,
    maxLength = 64,
    deckBlock = 'white_concrete',
    pillarBlock = 'white_concrete',
    railBlock = 'oak_fence',
    stairBlock = 'oak_stairs',
    pillarSpacing = null,
}) {
    const span = findBridgeSpan({ getSurface, start, dir, maxLength });
    if (span.error)
        return span;

    const { nearShore, farShore, water } = span;
    const waterY = Math.max(...water.map(column => column.y));
    // At least one air block between the deck and the water.
    const deckY = Math.max(waterY + 2, nearShore.y, farShore.y);
    const length = water.length;

    const spacing = pillarSpacing ?? Math.max(3, Math.ceil(length / 4));
    const pillarIndices = new Set([0, length - 1]);
    for (let i = 0; i < length; i += spacing)
        pillarIndices.add(i);

    const deck = water.map(column => ({
        x: column.x, y: deckY, z: column.z, block: deckBlock
    }));

    const pillars = [];
    for (const index of [...pillarIndices].sort((a, b) => a - b)) {
        const column = water[index];
        for (let y = deckY - 1; y >= waterY; y--)
            pillars.push({ x: column.x, y, z: column.z, block: pillarBlock });
    }

    const side = dir.x !== 0 ? { x: 0, z: 1 } : { x: 1, z: 0 };
    const railings = [];
    for (const column of water) {
        for (const sign of [-1, 1]) {
            railings.push({
                x: column.x + side.x * sign,
                y: deckY + 1,
                z: column.z + side.z * sign,
                block: railBlock
            });
        }
    }

    // Landings sit at each shore at deck level and support the first/last deck block.
    // Extra supports fill the gap between the shore and the landing. Stairs climb
    // from the shore up to the landing, extending away from the water.
    const landings = [];
    const landingSupports = [];
    const stairs = [];
    const stairSupports = [];
    const addShore = (shore, away) => {
        const diff = deckY - shore.y;
        if (diff <= 0)
            return;
        for (let y = shore.y + 1; y < deckY; y++)
            landingSupports.push({ x: shore.x, y, z: shore.z, block: deckBlock });
        landings.push({ x: shore.x, y: deckY, z: shore.z, block: deckBlock });
        for (let i = 1; i < diff; i++) {
            const step = {
                x: shore.x - away.x * i,
                y: deckY - i,
                z: shore.z - away.z * i,
                block: stairBlock
            };
            stairs.push(step);
            const ground = getSurface(step.x, step.z);
            if (ground && !ground.water) {
                for (let y = ground.y + 1; y < step.y; y++)
                    stairSupports.push({ x: step.x, y, z: step.z, block: deckBlock });
            }
        }
    };
    addShore(nearShore, dir); // away from the water = against dir
    addShore(farShore, { x: -dir.x, z: -dir.z }); // away from the water = along dir

    return {
        nearShore,
        farShore,
        water,
        waterY,
        deckY,
        length,
        spacing,
        deck,
        pillars,
        railings,
        landings,
        landingSupports,
        stairs,
        stairSupports,
    };
}
