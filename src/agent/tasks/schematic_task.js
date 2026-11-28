import { createRequire } from 'node:module';
import { resolveSchematicPath, conservativeBotVersion } from '../../utils/schematic/paths.js';
import { readSchematic } from '../../utils/schematic/reader.js';
import { createStateTransformer } from '../../utils/schematic/schematic_transform.js';

const Vec3 = createRequire(import.meta.url)('vec3');
const air = new Set(['air', 'cave_air', 'void_air']);
const sameProperties = (a, b) => {
    const keys = Object.keys(a).sort();
    return JSON.stringify(keys) === JSON.stringify(Object.keys(b).sort()) && keys.every(key => a[key] === b[key]);
};

// Decode the selected asset independently of the builder's plan. Coordinates are
// mapped from source voxels, including air, into the requested minimum corner.
export function expectedCells(schematic, codec, origin, orientation) {
    if (!['north', 'east', 'south', 'west'].includes(orientation) ||
        !origin || !['x', 'y', 'z'].every(k => Number.isSafeInteger(origin[k]))) throw new Error('Invalid schematic task origin or orientation');
    const size = schematic.size, offset = schematic.offset || { x: 0, y: 0, z: 0 };
    const cells = [];
    for (let y = 0; y < size.y; y++) for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) {
        const [dx, dz] = orientation === 'north' ? [x, z] : orientation === 'east' ? [size.z - 1 - z, x] : orientation === 'south' ? [size.x - 1 - x, size.z - 1 - z] : [z, size.x - 1 - x];
        const state = codec.transformState(schematic.getBlock(new Vec3(offset.x + x, offset.y + y, offset.z + z)), orientation);
        cells.push({ position: new Vec3(origin.x + dx, origin.y + y, origin.z + dz), ...state });
    }
    if (!cells.length) throw new Error('Empty schematic');
    return cells;
}

export class SchematicTaskValidator {
    constructor(data, agent) { this.data = data; this.agent = agent; this.cells = null; }
    async initialize() {
        const bot = this.agent.bot;
        const selection = await resolveSchematicPath(this.data.schem_path, undefined, {
            version: conservativeBotVersion(bot), requireStrictSchematicValidation: true, returnSnapshot: true,
        });
        const schematic = await readSchematic(selection.source, bot.version, undefined, bot.registry);
        const codec = createStateTransformer({ version: bot.version, registry: bot.registry });
        this.cells = expectedCells(schematic, codec, this.data.origin, this.data.orientation || 'north');
        const items = {};
        for (const cell of this.cells) {
            if (air.has(cell.name)) continue;
            if (!bot.registry.itemsByName[cell.name]) throw new Error(`No inventory item for ${cell.name}`);
            items[cell.name] = (items[cell.name] || 0) + 1;
        }
        return items;
    }
    validate() {
        if (!this.cells) return { valid: false, score: 0, mismatches: ['Schematic not initialized'] };
        let matched = 0;
        const mismatches = [];
        for (const cell of this.cells) {
            let block, matches = false;
            try {
                block = this.agent.bot.blockAt(cell.position);
                matches = !!block && (air.has(cell.name) ? air.has(block.name) : block.name === cell.name && block.stateId === cell.stateId && sameProperties(block.getProperties(), cell.properties));
            } catch { /* unreadable state is a mismatch */ }
            if (matches) matched++;
            else if (mismatches.length < 20) mismatches.push(`${cell.position}: expected ${cell.name} ${JSON.stringify(cell.properties)}, got ${block?.name ?? 'unloaded'}`);
        }
        return { valid: matched === this.cells.length, score: matched / this.cells.length, mismatches };
    }
}
