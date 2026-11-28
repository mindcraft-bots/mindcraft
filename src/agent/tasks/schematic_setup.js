import vec3 from 'vec3';

const { Vec3 } = vec3;
const SETUP_LIMIT_MS = 30000;
const POLL_MS = 50;

// Chat sends a command, not its result. Advance only after the corresponding
// server state has arrived, and never schedule another command after failure.
export async function prepareSchematicTask(task) {
    const bot = task.agent.bot;
    if (!Number.isFinite(task.taskTimeout) || task.taskTimeout <= 0 || !Number.isFinite(task.taskStartTime)) throw new Error('Invalid schematic task deadline');
    const deadline = Math.min(task.taskStartTime + task.taskTimeout * 1000, Date.now() + SETUP_LIMIT_MS);
    let stage = 'initializing schematic';
    const check = () => {
        if (task.schematicSetupFailed || Date.now() >= deadline) throw new Error(`Schematic setup timed out or cancelled while ${stage}`);
    };
    const wait = async (description, predicate) => {
        stage = description;
        console.log(`Schematic setup: ${stage}`);
        for (;;) {
            check();
            if (predicate()) { check(); return; }
            await new Promise(resolve => setTimeout(resolve, Math.min(POLL_MS, Math.max(1, deadline - Date.now()))));
        }
    };
    const bounded = async promise => {
        check();
        let timer;
        try {
            const result = await Promise.race([
                promise,
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Schematic setup timed out while ${stage}`)), Math.max(1, deadline - Date.now())); }),
            ]);
            check();
            return result;
        } finally { clearTimeout(timer); }
    };
    const send = command => { check(); bot.chat(command); };
    const counts = () => {
        const result = {};
        for (const item of bot.inventory.slots) if (item) result[item.name] = (result[item.name] || 0) + item.count;
        return result;
    };
    const blockAt = pos => { try { return bot.blockAt(pos); } catch { return null; } };
    const { x, y, z } = task.data.origin;
    const target = new Vec3(x - 0.5, y, z + 0.5);
    const atTarget = (verticalTolerance = 0.08) => {
        const pos = bot.entity?.position;
        return !!pos && Math.abs(pos.x - target.x) < 0.35 && Math.abs(pos.y - target.y) < verticalTolerance && Math.abs(pos.z - target.z) < 0.35;
    };
    const teleport = async verticalTolerance => {
        if (!atTarget(verticalTolerance)) {
            send(`/tp ${task.name} ${target.x} ${target.y} ${target.z}`);
            await wait('waiting for teleport', () => atTarget(verticalTolerance));
        }
    };

    if (task.data.agent_count > 1 || task.data.human_count > 0 || task.data.conversation) {
        throw new Error('Schematic setup requires one agent and no human players or conversation');
    }
    const required = await bounded(task.validator.initialize());
    const additional = task.data.initial_inventory?.[task.agent.count_id.toString()] || {};
    const inventory = { ...required };
    for (const [name, count] of Object.entries(additional)) {
        if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid initial inventory count for ${name}`);
        const item = name.toLowerCase();
        inventory[item] = (inventory[item] || 0) + count;
    }
    send(`/clear ${task.name}`);
    await wait('clearing inventory', () => Object.keys(counts()).length === 0);
    for (const [item, count] of Object.entries(inventory)) {
        if (!Number.isSafeInteger(count) || count < 0 || !bot.registry.itemsByName[item]) throw new Error(`Invalid schematic inventory item or count: ${item}`);
        if (!count) continue;
        send(`/give ${task.name} ${item} ${count}`);
        await wait(`receiving ${count} ${item}`, () => (counts()[item] || 0) >= count);
    }

    // Teleport first so Purpur loads remote chunks before /fill. A second
    // teleport after the platform is built handles falling during chunk load.
    await teleport(0.75);
    const platform = [];
    if (task.data.prepare_test_platform === true) {
        for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) platform.push(new Vec3(x + dx, y - 1, z + dz));
    }
    const site = [new Vec3(x - 1, y - 1, z), new Vec3(x - 1, y, z), new Vec3(x - 1, y + 1, z), ...task.validator.cells.map(cell => cell.position), ...platform];
    await wait('loading the entire build site', () => site.every(pos => blockAt(pos)));
    if (platform.length) {
        const existing = platform.map(blockAt);
        if (existing.some(block => block.name !== 'stone' && block.name !== 'air')) throw new Error('Test platform contains blocks other than air or stone');
        if (existing.some(block => block.name !== 'stone')) {
            // Restrict the server operation too: a block can change between
            // the client-side inspection and command execution.
            send(`/fill ${x - 5} ${y - 1} ${z - 5} ${x + 5} ${y - 1} ${z + 5} stone replace air`);
            await wait('building the test platform', () => platform.every(pos => blockAt(pos)?.name === 'stone'));
        }
    }
    await teleport(0.08);
    const ready = () => {
        const floor = blockAt(site[0]), feet = blockAt(site[1]), head = blockAt(site[2]);
        const current = counts();
        return atTarget() && bot.entity?.onGround === true && floor?.boundingBox === 'block' && feet?.boundingBox === 'empty' && head?.boundingBox === 'empty'
            && site.every(pos => blockAt(pos)) && platform.every(pos => blockAt(pos)?.name === 'stone')
            && Object.entries(inventory).every(([item, count]) => (current[item] || 0) >= count);
    };
    await wait('verifying teleport, support, headroom, chunks and inventory', ready);
    console.log('Schematic setup ready at', bot.entity.position, 'grounded:', bot.entity.onGround);
    check();
}
