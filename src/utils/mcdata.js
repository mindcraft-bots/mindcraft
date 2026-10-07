import minecraftData from 'minecraft-data';
import settings from '../agent/settings.js';
import { createBot } from 'mineflayer';
import prismarine_items from 'prismarine-item';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as pvp } from 'mineflayer-pvp';
import { plugin as collectblock } from 'mineflayer-collectblock';
import { plugin as autoEat } from 'mineflayer-auto-eat';
import plugin from 'mineflayer-armor-manager';
import paletteContainers from 'prismarine-chunk/src/pc/common/PaletteContainer.js';

// a chunk section of one block only (all air above the ground, all stone deep down) reports no palette, and
// mineflayer's block search then looks at each of its 4096 blocks in case the block it wants is there. a search that
// finds nothing (no trees, no gravel left) looked through every such section in range: 114ms for 64 blocks on the
// practice server, 4ms with this
Object.defineProperty(paletteContainers.SingleValueContainer.prototype, 'palette', {
    get() { return [this.value]; },
    configurable: true,
});
const armorManager = plugin;
let mc_version = settings.minecraft_version;
let mcdata = null;
let Item = null;

/**
 * @typedef {string} ItemName
 * @typedef {string} BlockName
*/

export const WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];
// stone and dirt that pile up from digging and are thrown away when the inventory fills (one stack of cobblestone
// is kept for building and hiding). item_collecting leaves them on the ground so they aren't picked straight back up
export const JUNK_ITEMS = ['dirt', 'granite', 'diorite', 'andesite', 'tuff', 'gravel', 'calcite', 'cobbled_deepslate'];
export const MATCHING_WOOD_BLOCKS = [
    'log',
    'planks',
    'sign',
    'boat',
    'fence_gate',
    'door',
    'fence',
    'slab',
    'stairs',
    'button',
    'pressure_plate',
    'trapdoor'
]
export const WOOL_COLORS = [
    'white',
    'orange',
    'magenta',
    'light_blue',
    'yellow',
    'lime',
    'pink',
    'gray',
    'light_gray',
    'cyan',
    'purple',
    'blue',
    'brown',
    'green',
    'red',
    'black'
]


export function initBot(username) {
    const options = {
        username: username,
        host: settings.host,
        port: settings.port,
        auth: settings.auth,
        version: mc_version,
        checkTimeoutInterval: 60000,  // 60s keep-alive check (default 30s) — reduces disconnects on slow servers
    }
    if (!mc_version || mc_version === "auto") {
        delete options.version;
    }

    const bot = createBot(options);

    // node-minecraft-protocol hashes the last seen chat messages in storage order, but vanilla hashes them
    // oldest to newest. once more than 20 signed messages have been seen the two differ, the checksum is wrong
    // and the server kicks the bot ("Checksum mismatch on last seen update"), so recompute it the vanilla way.
    const checksumTypes = {};
    const fixChatChecksum = (name, data) => {
        if (name !== 'chat_message' && name !== 'chat_command' && name !== 'chat_command_signed') return data;
        if (typeof data?.checksum !== 'number') return data;
        const checksum = lastSeenChecksum(bot._client._lastSeenMessages);
        if (checksum === null) return data;
        if (!(name in checksumTypes)) {
            const fields = minecraftData(bot.version)?.protocol?.play?.toServer?.types?.['packet_' + name]?.[1];
            checksumTypes[name] = Array.isArray(fields) ? fields.find(f => f.name === 'checksum')?.type : undefined;
        }
        const signed = checksumTypes[name] === 'i8';
        return { ...data, checksum: signed && checksum > 127 ? checksum - 256 : checksum };
    };

    // Throttle position packets to avoid kicks on Paper/Spigot servers
    // Paper enforces stricter packet rate limits than vanilla, causing ECONNRESET
    // when mineflayer sends position updates faster than 50ms apart
    // the update held back is always the newest one, merged with any held back before it: holding the first and
    // dropping the rest left the server with the bot halfway through a jump while it stood on the ground, and the
    // server kicked it for "floating too long" (a live run, 4 minutes from the nether)
    let lastPositionUpdate = 0;
    let pendingPositionPacket = null;
    let pendingData = null;
    const POSITION_THROTTLE_MS = 50;
    const originalWrite = bot._client.write.bind(bot._client);
    const packetFor = (data) => 'x' in data && 'yaw' in data ? 'position_look' : 'x' in data ? 'position' : 'look';
    bot._client.write = function(name, data) {
        data = fixChatChecksum(name, data);
        if (name === 'position' || name === 'position_look' || name === 'look') {
            const now = Date.now();
            if (now - lastPositionUpdate < POSITION_THROTTLE_MS) {
                pendingData = { ...(pendingData || {}), ...data };
                if (!pendingPositionPacket) {
                    pendingPositionPacket = setTimeout(() => {
                        pendingPositionPacket = null;
                        const held = pendingData;
                        pendingData = null;
                        lastPositionUpdate = Date.now();
                        if (held) originalWrite(packetFor(held), held);
                    }, POSITION_THROTTLE_MS - (now - lastPositionUpdate));
                }
                return;
            }
            lastPositionUpdate = now;
            if (pendingPositionPacket) {
                clearTimeout(pendingPositionPacket);
                pendingPositionPacket = null;
                // this one goes now: fold in anything held back that it doesn't replace (a turn held back while we move)
                if (pendingData) data = { ...pendingData, ...data };
                name = packetFor(data);
                pendingData = null;
            }
        }
        return originalWrite(name, data);
    };

    // Suppress PartialReadError for non-critical packets
    // Paper servers sometimes send packets that node-minecraft-protocol
    // can't fully parse (scoreboard, resource_pack, custom_payload, etc.)
    // These errors crash the bot but the packets aren't needed for gameplay
    const originalEmit = bot._client.emit.bind(bot._client);
    bot._client.emit = function(event, ...args) {
        if (event === 'error' && args[0]) {
            const err = args[0];
            const errStr = err instanceof Error ? err.message : String(err);
            if (errStr.includes('PartialReadError')) {
                console.warn('[mcdata] Suppressed PartialReadError:', errStr.substring(0, 120));
                return true; // Swallow the error
            }
        }
        return originalEmit(event, ...args);
    };

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    bot.loadPlugin(collectblock);
    bot.loadPlugin(autoEat);
    bot.loadPlugin(armorManager); // auto equip armor
    bot.once('resourcePack', () => {
        bot.acceptResourcePack();
    });

    // going home through the end's exit portal, the server waits for the client to ask to respawn, after the
    // credits (value 1) or straight away when they've been seen before (value 0). mineflayer only answers the
    // first, so every later trip home left the bot stuck in limbo
    bot._client.on('game_state_change', (packet) => {
        if ((packet.reason === 4 || packet.reason === 'win_game') && packet.gameMode === 0)
            bot._client.write('client_command', bot.supportFeature('respawnIsPayload') ? { payload: 0 } : { actionId: 0 });
    });

    bot.once('login', () => {
        mc_version = bot.version;
        mcdata = minecraftData(mc_version);
        Item = prismarine_items(mc_version);
        fixToolMaterials(bot.registry);
        fixToolMaterials(mcdata);
        // armor-manager reads the item off every collected entity, which throws if the server never sent that
        // entity's item metadata. thrown inside a packet handler, that takes down the whole agent process.
        for (const listener of bot.listeners('playerCollect')) {
            bot.removeListener('playerCollect', listener);
            bot.on('playerCollect', (...args) => {
                try {
                    listener(...args);
                } catch (err) {
                    console.warn('Ignored error while handling a collected item:', err.message);
                }
            });
        }
    });

    return bot;
}

function lastSeenChecksum(lastSeen) {
    /* The vanilla last seen messages checksum: Arrays.hashCode of each tracked signature, combined from the
       oldest entry to the newest, cast to a byte (and never 0). Returns null for chat formats without a ring. */
    if (!lastSeen || typeof lastSeen.offset !== 'number' || !lastSeen.capacity) return null;
    let checksum = 1;
    for (let i = 0; i < lastSeen.capacity; i++) {
        const signature = lastSeen[(lastSeen.offset + i) % lastSeen.capacity]?.signature;
        if (!signature) continue;
        let hash = 1;
        for (const byte of signature) hash = (Math.imul(31, hash) + byte) | 0;
        checksum = (Math.imul(31, checksum) + hash) | 0;
    }
    const result = checksum & 0xff;
    return result === 0 ? 1 : result;
}

function fixToolMaterials(registry) {
    /* minecraft-data files blocks that need a stone or better pickaxe (ores, obsidian...) under materials like
       'incorrect_for_wooden_tool', which have no pickaxe speeds. dig times then come out as if mined by hand
       (75s for obsidian with a diamond pickaxe instead of 9.4s) and tool choice suffers. They're all pickaxe blocks. */
    if (!registry?.blocksArray || !registry.materials?.['mineable/pickaxe']) return;
    for (const block of registry.blocksArray) {
        if (block.material?.startsWith('incorrect_for_'))
            block.material = 'mineable/pickaxe';
    }
}

export function isHuntable(mob) {
    if (!mob || !mob.name) return false;
    const animals = ['chicken', 'cow', 'llama', 'mooshroom', 'pig', 'rabbit', 'sheep'];
    return animals.includes(mob.name.toLowerCase()) && !mob.metadata[16]; // metadata 16 is not baby
}

export function isHostile(mob) {
    if (!mob || !mob.name) return false;
    return  (mob.type === 'mob' || mob.type === 'hostile') && mob.name !== 'iron_golem' && mob.name !== 'snow_golem';
}

// hostile-classified mobs that leave you alone unless provoked. attacking them first
// usually makes things worse (a whole pack of zombified piglins, an enderman teleporting around)
const NEUTRAL_MOBS = ['enderman', 'zombified_piglin', 'piglin'];
// mobs that self defense should never try to melee: they are either bosses with their own
// strategy or can't be reached from the ground
const NO_AUTO_FIGHT = ['ender_dragon', 'wither', 'ghast', 'phantom', 'shulker'];

export function isNeutral(mob) {
    if (!mob || !mob.name) return false;
    return NEUTRAL_MOBS.includes(mob.name);
}

export function isThreat(bot, mob) {
    // a hostile mob that should be dealt with now. neutral mobs only count if they are close
    // and we were just hurt, which is the best signal we have that they were provoked.
    if (!isHostile(mob) || NO_AUTO_FIGHT.includes(mob.name)) return false;
    if (!isNeutral(mob)) return true;
    const recently_hurt = Date.now() - (bot.lastDamageTime || 0) < 5000;
    return recently_hurt && bot.entity.position.distanceTo(mob.position) < 5;
}

// approximate melee damage, used to pick the best weapon. prismarine items don't carry attack damage.
const MATERIAL_TIERS = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];
export function getMeleeDamage(itemName) {
    if (!itemName) return 1;
    const tier = MATERIAL_TIERS.findIndex(m => itemName.startsWith(m + '_'));
    if (itemName.endsWith('_sword')) {
        return [4, 4, 5, 6, 7, 8][tier] ?? 1;
    }
    if (itemName.endsWith('_axe') && !itemName.endsWith('pickaxe')) {
        // axes hit harder but swing much slower, so rank them below the same tier of sword
        return ([7, 7, 9, 9, 9, 10][tier] ?? 1) * 0.6;
    }
    if (itemName === 'trident') return 9;
    if (itemName === 'mace') return 6;
    if (itemName.endsWith('_pickaxe')) return ([2, 2, 3, 4, 5, 6][tier] ?? 1);
    if (itemName.endsWith('_shovel')) return ([2.5, 2.5, 3.5, 4.5, 5.5, 6.5][tier] ?? 1) * 0.9;
    return 1;
}

// seconds between full-strength hits for a weapon (1.9+ attack cooldown)
export function getAttackCooldown(itemName) {
    if (!itemName) return 0.25;
    if (itemName.endsWith('_sword')) return 0.625;
    if (itemName.endsWith('_axe') && !itemName.endsWith('pickaxe')) {
        return itemName.startsWith('wooden') || itemName.startsWith('stone') ? 1.25 : 1.0;
    }
    if (itemName === 'trident') return 0.91;
    if (itemName.endsWith('_pickaxe')) return 0.83;
    if (itemName.endsWith('_shovel')) return 1.0;
    if (itemName.endsWith('_hoe')) return 0.5;
    return 0.25;
}

// blocks that don't work with collectBlock, need to be manually collected
export function mustCollectManually(blockName) {
    // all crops (that aren't normal blocks), torches, buttons, levers, redstone,
    const full_names = ['wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart', 'cocoa', 'sugar_cane', 'kelp', 'short_grass', 'fern', 'tall_grass', 'bamboo',
        'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lilac', 'wither_rose', 'lily_of_the_valley', 'wither_rose',
        'lever', 'redstone_wire', 'lantern']
    const partial_names = ['sapling', 'torch', 'button', 'carpet', 'pressure_plate', 'mushroom', 'tulip', 'bush', 'vines', 'fern']
    return full_names.includes(blockName.toLowerCase()) || partial_names.some(partial => blockName.toLowerCase().includes(partial));
}

export function getItemId(itemName) {
    let item = mcdata.itemsByName[itemName];
    if (item) {
        return item.id;
    }
    return null;
}

export function getItemName(itemId) {
    let item = mcdata.items[itemId]
    if (item) {
        return item.name;
    }
    return null;
}

export function getBlockId(blockName) {
    let block = mcdata.blocksByName[blockName];
    if (block) {
        return block.id;
    }
    return null;
}

export function getBlockName(blockId) {
    let block = mcdata.blocks[blockId]
    if (block) {
        return block.name;
    }
    return null;
}

export function getEntityId(entityName) {
    let entity = mcdata.entitiesByName[entityName];
    if (entity) {
        return entity.id;
    }
    return null;
}

export function getAllItems(ignore) {
    if (!ignore) {
        ignore = [];
    }
    let items = []
    for (const itemId in mcdata.items) {
        const item = mcdata.items[itemId];
        if (!ignore.includes(item.name)) {
            items.push(item);
        }
    }
    return items;
}

export function getAllItemIds(ignore) {
    const items = getAllItems(ignore);
    let itemIds = [];
    for (const item of items) {
        itemIds.push(item.id);
    }
    return itemIds;
}

export function getAllBlocks(ignore) {
    if (!ignore) {
        ignore = [];
    }
    let blocks = []
    for (const blockId in mcdata.blocks) {
        const block = mcdata.blocks[blockId];
        if (!ignore.includes(block.name)) {
            blocks.push(block);
        }
    }
    return blocks;
}

export function getAllBlockIds(ignore) {
    const blocks = getAllBlocks(ignore);
    let blockIds = [];
    for (const block of blocks) {
        blockIds.push(block.id);
    }
    return blockIds;
}

export function getAllBiomes() {
    return mcdata.biomes;
}

export function getItemCraftingRecipes(itemName) {
    let itemId = getItemId(itemName);
    if (!mcdata.recipes[itemId]) {
        return null;
    }

    let recipes = [];
    for (let r of mcdata.recipes[itemId]) {
        let recipe = {};
        let ingredients = [];
        if (r.ingredients) {
            ingredients = r.ingredients;
        } else if (r.inShape) {
            ingredients = r.inShape.flat();
        }
        for (let ingredient of ingredients) {
            let ingredientName = getItemName(ingredient);
            if (ingredientName === null) continue;
            if (!recipe[ingredientName])
                recipe[ingredientName] = 0;
            recipe[ingredientName]++;
        }
        recipes.push([
            recipe,
            {craftedCount : r.result.count}
        ]);
    }
    // sort recipes by if their ingredients include common items
    const commonItems = ['oak_planks', 'oak_log', 'coal', 'cobblestone'];
    recipes.sort((a, b) => {
        let commonCountA = Object.keys(a[0]).filter(key => commonItems.includes(key)).reduce((acc, key) => acc + a[0][key], 0);
        let commonCountB = Object.keys(b[0]).filter(key => commonItems.includes(key)).reduce((acc, key) => acc + b[0][key], 0);
        return commonCountB - commonCountA;
    });

    return recipes;
}

export function isSmeltable(itemName) {
    const misc_smeltables = ['beef', 'chicken', 'cod', 'mutton', 'porkchop', 'rabbit', 'salmon', 'tropical_fish', 'potato', 'kelp', 'sand', 'cobblestone', 'clay_ball'];
    return itemName.includes('raw') || itemName.includes('log') || misc_smeltables.includes(itemName);
}

export function getSmeltingFuel(bot) {
    let fuel = bot.inventory.items().find(i => i.name === 'coal' || i.name === 'charcoal' || i.name === 'blaze_rod')
    if (fuel)
        return fuel;
    fuel = bot.inventory.items().find(i => i.name.includes('log') || i.name.includes('planks'))
    if (fuel)
        return fuel;
    return bot.inventory.items().find(i => i.name === 'coal_block' || i.name === 'lava_bucket');
}

export function getFuelSmeltOutput(fuelName) {
    if (fuelName === 'coal' || fuelName === 'charcoal')
        return 8;
    if (fuelName === 'blaze_rod')
        return 12;
    if (fuelName.includes('log') || fuelName.includes('planks'))
        return 1.5
    if (fuelName === 'coal_block')
        return 80;
    if (fuelName === 'lava_bucket')
        return 100;
    return 0;
}

export function getItemSmeltingIngredient(itemName) {
    return {    
        baked_potato: 'potato',
        steak: 'raw_beef',
        cooked_chicken: 'raw_chicken',
        cooked_cod: 'raw_cod',
        cooked_mutton: 'raw_mutton',
        cooked_porkchop: 'raw_porkchop',
        cooked_rabbit: 'raw_rabbit',
        cooked_salmon: 'raw_salmon',
        dried_kelp: 'kelp',
        iron_ingot: 'raw_iron',
        gold_ingot: 'raw_gold',
        copper_ingot: 'raw_copper',
        glass: 'sand'
    }[itemName];
}

export function getItemBlockSources(itemName) {
    let itemId = getItemId(itemName);
    let sources = [];
    for (let block of getAllBlocks()) {
        if (block.drops.includes(itemId)) {
            sources.push(block.name);
        }
    }
    return sources;
}

export function getItemAnimalSource(itemName) {
    return {    
        raw_beef: 'cow',
        raw_chicken: 'chicken',
        raw_cod: 'cod',
        raw_mutton: 'sheep',
        raw_porkchop: 'pig',
        raw_rabbit: 'rabbit',
        raw_salmon: 'salmon',
        leather: 'cow',
        wool: 'sheep'
    }[itemName];
}

export function getBlockTool(blockName) {
    let block = mcdata.blocksByName[blockName];
    if (!block || !block.harvestTools) {
        return null;
    }
    return getItemName(Object.keys(block.harvestTools)[0]);  // Double check first tool is always simplest
}

export function makeItem(name, amount=1) {
    return new Item(getItemId(name), amount);
}

/**
 * Returns the number of ingredients required to use the recipe once.
 * 
 * @param {Recipe} recipe
 * @returns {Object<mc.ItemName, number>} an object describing the number of each ingredient.
 */
export function ingredientsFromPrismarineRecipe(recipe) {
    let requiredIngedients = {};
    if (recipe.inShape)
        for (const ingredient of recipe.inShape.flat()) {
            if(ingredient.id<0) continue; //prismarine-recipe uses id -1 as an empty crafting slot
            const ingredientName = getItemName(ingredient.id);
            requiredIngedients[ingredientName] ??=0;
            requiredIngedients[ingredientName] += ingredient.count;
        }
    if (recipe.ingredients)
        for (const ingredient of recipe.ingredients) {
            if(ingredient.id<0) continue;
            const ingredientName = getItemName(ingredient.id);
            requiredIngedients[ingredientName] ??=0;
            requiredIngedients[ingredientName] -= ingredient.count;
            //Yes, the `-=` is intended.
            //prismarine-recipe uses positive numbers for the shaped ingredients but negative for unshaped.
            //Why this is the case is beyond my understanding.
        }
    return requiredIngedients;
}

/**
 * Calculates the number of times an action, such as a crafing recipe, can be completed before running out of resources.
 * @template T - doesn't have to be an item. This could be any resource.
 * @param {Object.<T, number>} availableItems - The resources available; e.g, `{'cobble_stone': 7, 'stick': 10}`
 * @param {Object.<T, number>} requiredItems - The resources required to complete the action once; e.g, `{'cobble_stone': 3, 'stick': 2}`
 * @param {boolean} discrete - Is the action discrete?
 * @returns {{num: number, limitingResource: (T | null)}} the number of times the action can be completed and the limmiting resource; e.g `{num: 2, limitingResource: 'cobble_stone'}`
 */
export function calculateLimitingResource(availableItems, requiredItems, discrete=true) {
    let limitingResource = null;
    let num = Infinity;
    for (const itemType in requiredItems) {
        if (availableItems[itemType] < requiredItems[itemType] * num) {
            limitingResource = itemType;
            num = availableItems[itemType] / requiredItems[itemType];
        }
    }
    if(discrete) num = Math.floor(num);
    return {num, limitingResource}
}

let loopingItems = new Set();

export function initializeLoopingItems() {

    loopingItems = new Set(['coal',
        'wheat',
        'bone_meal',
        'diamond',
        'emerald',
        'raw_iron',
        'raw_gold',
        'redstone',
        'blue_wool',
        'packed_mud',
        'raw_copper',
        'iron_ingot',
        'dried_kelp',
        'gold_ingot',
        'slime_ball',
        'black_wool',
        'quartz_slab',
        'copper_ingot',
        'lapis_lazuli',
        'honey_bottle',
        'rib_armor_trim_smithing_template',
        'eye_armor_trim_smithing_template',
        'vex_armor_trim_smithing_template',
        'dune_armor_trim_smithing_template',
        'host_armor_trim_smithing_template',
        'tide_armor_trim_smithing_template',
        'wild_armor_trim_smithing_template',
        'ward_armor_trim_smithing_template',
        'coast_armor_trim_smithing_template',
        'spire_armor_trim_smithing_template',
        'snout_armor_trim_smithing_template',
        'shaper_armor_trim_smithing_template',
        'netherite_upgrade_smithing_template',
        'raiser_armor_trim_smithing_template',
        'sentry_armor_trim_smithing_template',
        'silence_armor_trim_smithing_template',
        'wayfinder_armor_trim_smithing_template']);
}


/**
 * Gets a detailed plan for crafting an item considering current inventory
 */
export function getDetailedCraftingPlan(targetItem, count = 1, current_inventory = {}) {
    initializeLoopingItems();
    if (!targetItem || count <= 0 || !getItemId(targetItem)) {
        return "Invalid input. Please provide a valid item name and positive count.";
    }

    if (isBaseItem(targetItem)) {
        const available = current_inventory[targetItem] || 0;
        if (available >= count) return "You have all required items already in your inventory!";
        return `${targetItem} is a base item, you need to find ${count - available} more in the world`;
    }

    const inventory = { ...current_inventory };
    const leftovers = {};
    const plan = craftItem(targetItem, count, inventory, leftovers);
    return formatPlan(targetItem, plan);
}

function isBaseItem(item) {
    return loopingItems.has(item) || getItemCraftingRecipes(item) === null;
}

function craftItem(item, count, inventory, leftovers, crafted = { required: {}, steps: [], leftovers: {} }) {
    // Check available inventory and leftovers first
    const availableInv = inventory[item] || 0;
    const availableLeft = leftovers[item] || 0;
    const totalAvailable = availableInv + availableLeft;

    if (totalAvailable >= count) {
        // Use leftovers first, then inventory
        const useFromLeft = Math.min(availableLeft, count);
        leftovers[item] = availableLeft - useFromLeft;
        
        const remainingNeeded = count - useFromLeft;
        if (remainingNeeded > 0) {
            inventory[item] = availableInv - remainingNeeded;
        }
        return crafted;
    }

    // Use whatever is available
    const stillNeeded = count - totalAvailable;
    if (availableLeft > 0) leftovers[item] = 0;
    if (availableInv > 0) inventory[item] = 0;

    if (isBaseItem(item)) {
        crafted.required[item] = (crafted.required[item] || 0) + stillNeeded;
        return crafted;
    }

    const recipe = getItemCraftingRecipes(item)?.[0];
    if (!recipe) {
        crafted.required[item] = stillNeeded;
        return crafted;
    }

    const [ingredients, result] = recipe;
    const craftedPerRecipe = result.craftedCount;
    const batchCount = Math.ceil(stillNeeded / craftedPerRecipe);
    const totalProduced = batchCount * craftedPerRecipe;

    // Add excess to leftovers
    if (totalProduced > stillNeeded) {
        leftovers[item] = (leftovers[item] || 0) + (totalProduced - stillNeeded);
    }

    // Process each ingredient
    for (const [ingredientName, ingredientCount] of Object.entries(ingredients)) {
        const totalIngredientNeeded = ingredientCount * batchCount;
        craftItem(ingredientName, totalIngredientNeeded, inventory, leftovers, crafted);
    }

    // Add crafting step
    const stepIngredients = Object.entries(ingredients)
        .map(([name, amount]) => `${amount * batchCount} ${name}`)
        .join(' + ');
    crafted.steps.push(`Craft ${stepIngredients} -> ${totalProduced} ${item}`);

    return crafted;
}

function formatPlan(targetItem, { required, steps, leftovers }) {
    const lines = [];

    if (Object.keys(required).length > 0) {
        lines.push('You are missing the following items:');
        Object.entries(required).forEach(([item, count]) => 
            lines.push(`- ${count} ${item}`));
        lines.push('\nOnce you have these items, here\'s your crafting plan:');
    } else {
        lines.push('You have all items required to craft this item!');
        lines.push('Here\'s your crafting plan:');
    }

    lines.push('');
    lines.push(...steps);

    if (Object.keys(required).some(item => item.includes('oak')) && !targetItem.includes('oak')) {
        lines.push('Note: Any varient of wood can be used for this recipe.');
    }

    if (Object.keys(leftovers).length > 0) {
        lines.push('\nYou will have leftover:');
        Object.entries(leftovers).forEach(([item, count]) => 
            lines.push(`- ${count} ${item}`));
    }

    return lines.join('\n');
}
