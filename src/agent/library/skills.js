import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

export function log(bot, message) {
    bot.output += message + '\n';
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {return false;}
    }
    return false;
}

async function equipHighestAttack(bot) {
    const weapons = bot.inventory.items().filter(item => mc.getMeleeDamage(item.name) > 1);
    if (weapons.length === 0)
        return;
    weapons.sort((a, b) => mc.getMeleeDamage(b.name) - mc.getMeleeDamage(a.name));
    const weapon = weapons[0];
    if (bot.heldItem?.name !== weapon.name)
        await bot.equip(weapon, 'hand');
}

// cheap blocks the pathfinder may place to bridge gaps and tower up
const SCAFFOLD_BLOCKS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite', 'diorite',
    'granite', 'tuff', 'blackstone', 'basalt', 'end_stone', 'sandstone'];
// blocks that hurt or trap you
const DANGER_BLOCKS = ['magma_block', 'powder_snow', 'sweet_berry_bush', 'wither_rose', 'campfire', 'soul_campfire',
    'soul_fire', 'cactus', 'pointed_dripstone'];
// blocks the pathfinder must never break on its way somewhere
const PROTECTED_BLOCKS = ['end_portal_frame', 'end_portal', 'nether_portal', 'chest', 'furnace', 'crafting_table',
    'spawner', 'bed', 'respawn_anchor'];

function makeMovements(bot, {destructive=true, digCost=null, placeCost=null} = {}) {
    /* Build pathfinder movements tuned for survival: sprint/parkour on, avoids hazards,
       bridges and towers with cheap blocks, and never breaks important blocks. */
    const movements = new pf.Movements(bot);
    movements.allowSprinting = true;
    movements.allowParkour = true;
    movements.allow1by1towers = true;
    movements.canDig = destructive;
    if (digCost !== null) movements.digCost = digCost;
    if (placeCost !== null) movements.placeCost = placeCost;
    // falling more than 3 blocks hurts; allow more only when we're healthy
    movements.maxDropDown = bot.health > 14 ? 4 : 3;
    // swimming is barely more than walking by default, so paths dove through flooded caves the bot can't climb back
    // out of and it ran out of air. make water cost a lot more than walking. not too much though: at 20 the search
    // tried every land route before crossing a river, ran out of thinking time, and the bot stood still
    movements.liquidCost = 8;

    const scaffold = new Set(movements.scafoldingBlocks);
    for (const name of SCAFFOLD_BLOCKS) {
        const item = bot.registry.itemsByName[name];
        if (item) scaffold.add(item.id);
    }
    movements.scafoldingBlocks = [...scaffold];

    for (const name of DANGER_BLOCKS) {
        const block = bot.registry.blocksByName[name];
        if (block) movements.blocksToAvoid.add(block.id);
    }
    for (const block of bot.registry.blocksArray) {
        if (PROTECTED_BLOCKS.some(name => block.name === name || block.name.endsWith('_' + name)))
            movements.blocksCantBreak.add(block.id);
    }
    return movements;
}

function stopPathfinding(bot) {
    // pathfinder.stop() alone only takes effect when the bot reaches its next path node, and otherwise leaves a
    // flag behind that cancels the *next* path. re-applying the movements makes the stop happen right now.
    if (bot.pathfinder.goal || bot.pathfinder.isMoving()) {
        bot.pathfinder.stop();
        bot.pathfinder.setMovements(bot.pathfinder.movements);
    }
    else {
        bot.pathfinder.setGoal(null); // nothing running, just make sure no stale stop flag is left behind
    }
}

// slots outside the main inventory that still show up in the bot's inventory counts: the 2x2 crafting grid,
// armor, and the off-hand. findInventoryItem doesn't search them, so items there look like they're missing
const EXTRA_ITEM_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 45];

async function findItemAnywhere(bot, itemName) {
    /* findInventoryItem, but an item that is only in the off-hand, armor or crafting grid is first moved
       into the main inventory so it can be tossed, deposited, eaten or placed. */
    let item = bot.inventory.findInventoryItem(itemName);
    if (item) return item;
    for (const slot of EXTRA_ITEM_SLOTS) {
        if (bot.inventory.slots[slot]?.name !== itemName) continue;
        if (bot.inventory.emptySlotCount() === 0) {
            log(bot, `Your ${itemName} is equipped or in the crafting grid, and there's no free inventory slot to move it to.`);
            return null;
        }
        try {
            await bot.putAway(slot);
        } catch (err) {
            return null;
        }
        return bot.inventory.findInventoryItem(itemName);
    }
    return null;
}

function getScaffoldItem(bot) {
    const items = bot.inventory.items();
    for (const name of SCAFFOLD_BLOCKS) {
        const item = items.find(i => i.name === name);
        if (item) return item;
    }
    return null;
}

async function resyncInventory(bot) {
    // the bot's copy of its inventory can drift from the server's after crafting or smelting. closing the inventory
    // makes the server put back anything left on the cursor or in the 2x2 crafting grid, then mineflayer asks for the real contents
    try {
        bot._client.write('close_window', {windowId: 0});
        await bot._syncWindow(bot.inventory);
        return true;
    } catch (err) {
        console.log('Failed to resync the inventory:', err.message);
        return false;
    }
}

async function craftMissingIngredients(bot, itemName, num, depth) {
    /* Craft the planks and sticks a recipe needs from what we carry. Getting a wooden pickaxe took a round trip to the
       model for each of planks, sticks, the table and the pickaxe, plus failed tries in between. */
    const inv = () => world.getInventoryCounts(bot);
    const plankable = (name, counts) => (counts[name] || 0) + 4 * (counts[name.replace(/_planks$/, '_log')] || 0);
    // the recipe variant we're closest to having, e.g. spruce planks when we carry spruce logs
    let best = null, best_score = -1;
    for (const [ingredients] of mc.getItemCraftingRecipes(itemName) || []) {
        const counts = inv();
        const any_planks = Math.max(0, ...Object.keys(counts).filter(n => n.endsWith('_planks') || n.endsWith('_log'))
            .map(n => plankable(n.replace(/_log$/, '_planks'), counts)));
        let score = 0;
        for (const [name, per] of Object.entries(ingredients)) {
            const need = per * num;
            const have = name === 'stick' ? (counts.stick || 0) + 2 * any_planks
                : name.endsWith('_planks') ? plankable(name, counts) : (counts[name] || 0);
            score += Math.min(have, need) / need;
        }
        if (score > best_score) {
            best = ingredients;
            best_score = score;
        }
    }
    if (!best) return;
    // sticks first: making them uses planks, which would otherwise come out of the planks the recipe itself needs
    const entries = Object.entries(best).sort(([a], [b]) => (b === 'stick') - (a === 'stick'));
    for (const [name, per] of entries) {
        const missing = per * num - (inv()[name] || 0);
        if (missing > 0 && (name === 'stick' || name.endsWith('_planks')))
            await craftRecipe(bot, name, Math.ceil(missing / 4), depth + 1); // both recipes make 4
    }
}

export async function craftRecipe(bot, itemName, num=1, _depth=0) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    if ((mc.getItemCraftingRecipes(itemName) || []).length == 0) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!`);
        return false;
    }
    if (_depth < 2)
        await craftMissingIngredients(bot, itemName, num, _depth);

    // get recipes that don't require a crafting table
    let recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, null); 
    let craftingTable = null;
    const craftingTableRange = 16;
    placeTable: if (!recipes || recipes.length === 0) {
        recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, true);
        if(!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // Look for crafting table
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null){

            // Try to place crafting table, crafting one first if we can
            let hasTable = world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (!hasTable && _depth < 2)
                hasTable = await craftRecipe(bot, 'crafting_table', 1, _depth + 1) && world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (hasTable) {
                // the nearest free space doesn't always take a block (underground it failed), so also try the spaces
                // right around us. crafting without a table throws, and the model was shown the whole recipe
                const here = bot.entity.position.floored();
                const spots = [world.getNearestFreeSpace(bot, 1, 6), ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => here.offset(dx, 0, dz))];
                for (const pos of spots) {
                    if (!pos || bot.blockAt(pos)?.boundingBox !== 'empty' || bot.blockAt(pos.offset(0, -1, 0))?.boundingBox !== 'block') continue;
                    await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                    craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                    if (craftingTable) break;
                }
                if (!craftingTable) {
                    log(bot, `Couldn't place a crafting table to craft ${itemName}. Move to a more open spot and try again.`);
                    return false;
                }
                recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                placedTable = true;
            }
            else {
                log(bot, `Crafting ${itemName} requires a crafting table.`)
                return false;
            }
        }
        else {
            recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
        }
    }
    if (!recipes || recipes.length === 0) {
        log(bot, `You do not have the resources to craft a ${itemName}. It requires: ${Object.entries(mc.getItemCraftingRecipes(itemName)[0][0]).map(([key, value]) => `${key}: ${value}`).join(', ')}.`);
        if (placedTable) {
            await collectBlock(bot, 'crafting_table', 1);
        }
        return false;
    }
    
    if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
        await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
    }

    const recipe = recipes[0];
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    // ingredients in the off-hand or crafting grid count as ours, but crafting only takes from the main inventory
    // ("missing ingredient"), so move them there first
    for (const name of Object.keys(requiredIngredients)) {
        for (const slot of EXTRA_ITEM_SLOTS) {
            if (bot.inventory.slots[slot]?.name === name && bot.inventory.emptySlotCount() > 0)
                await bot.putAway(slot).catch(() => {});
        }
    }
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);
    const craftNum = Math.min(craftLimit.num, num);
    const had = inventory[itemName] || 0;

    try {
        await bot.craft(recipe, craftNum, craftingTable);
    } catch (err) {
        // when the inventory has drifted, mineflayer waits for a slot update that never comes or can't find an ingredient.
        // get the real inventory back and craft whatever is still missing
        console.log(`Crafting ${itemName} failed (${err.message}), resyncing the inventory and trying again.`);
        await resyncInventory(bot);
        const crafted = Math.floor(((world.getInventoryCounts(bot)[itemName] || 0) - had) / recipe.result.count);
        const left = Math.min(craftNum - crafted, mc.calculateLimitingResource(world.getInventoryCounts(bot), requiredIngredients).num);
        try {
            if (left > 0 && !bot.interrupt_code)
                await bot.craft(recipe, left, craftingTable);
        } catch (err) {
            await resyncInventory(bot);
            log(bot, `Failed to craft ${itemName}: ${err.message}. You now have ${world.getInventoryCounts(bot)[itemName] || 0} ${itemName}.`);
            if (placedTable) {
                await collectBlock(bot, 'crafting_table', 1);
            }
            return false;
        }
    }
    // mineflayer resyncs after crafting at a table but not in the inventory grid, where its last click can leave the inventory wrong
    if (!craftingTable)
        await resyncInventory(bot);

    if(craftLimit.num<num) log(bot, `Not enough ${craftLimit.limitingResource} to craft ${num}, crafted ${craftLimit.num}. You now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    else log(bot, `Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    if (placedTable) {
        await collectBlock(bot, 'crafting_table', 1);
    }

    //Equip any armor the bot may have crafted.
    //There is probablly a more efficient method than checking the entire inventory but this is all mineflayer-armor-manager provides. :P
    bot.armorManager.equipAll(); 

    return true;
}

export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();
    
    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;
        
        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

export async function smeltItem(bot, itemName, num=1) {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    if (!mc.isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    let furnaceBlock = undefined;
    const furnaceRange = 16;
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock){
        // Try to place furnace
        let hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            let pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock){
        log(bot, `There is no furnace nearby and you have no furnace.`)
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
    }
    bot.modes.pause('unstuck');
    await bot.lookAt(furnaceBlock.position);

    // the furnace only takes from the main inventory, but the counts include the off-hand and crafting grid,
    // which can't be reached once the furnace window is open
    for (const slot of EXTRA_ITEM_SLOTS) {
        if (bot.inventory.slots[slot]?.name === itemName && bot.inventory.emptySlotCount() > 0)
            await bot.putAway(slot).catch(() => {});
    }

    console.log('smelting...');
    const furnace = await bot.openFurnace(furnaceBlock);
    // every way out of here, early returns and errors included, has to close the furnace: left open, later inventory
    // actions ran against its slots and failed ("invalid operation" equipping a tool)
    try {
        // check if the furnace is already smelting something
        let input_item = furnace.inputItem();
        if (input_item && input_item.type !== mc.getItemId(itemName) && input_item.count > 0) {
            // TODO: check if furnace is currently burning fuel. furnace.fuel is always null, I think there is a bug.
            // This only checks if the furnace has an input item, but it may not be smelting it and should be cleared.
            log(bot, `The furnace is currently smelting ${mc.getItemName(input_item.type)}.`);
            bot.closeWindow(furnace); // picking the furnace back up needs the inventory window
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        // check if the bot has enough items to smelt
        let inv_counts = world.getInventoryCounts(bot);
        if (!inv_counts[itemName] || inv_counts[itemName] < num) {
            log(bot, `You do not have enough ${itemName} to smelt.`);
            bot.closeWindow(furnace); // picking the furnace back up needs the inventory window
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }

        // fuel the furnace
        if (!furnace.fuelItem()) {
            // the fuel that smelts the most, not just the first one found (logs were picked over a stack of planks)
            let fuel = bot.inventory.items()
                .filter(item => mc.getFuelSmeltOutput(item.name) > 0)
                .sort((a, b) => b.count * mc.getFuelSmeltOutput(b.name) - a.count * mc.getFuelSmeltOutput(a.name))[0]
                || mc.getSmeltingFuel(bot);
            if (!fuel) {
                log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
                bot.closeWindow(furnace); // picking the furnace back up needs the inventory window
                if (placedFurnace)
                    await collectBlock(bot, 'furnace', 1);
                return false;
            }
            log(bot, `Using ${fuel.name} as fuel.`);

            let put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));

            if (fuel.count < put_fuel) {
                // smelt what the fuel allows rather than nothing: the first 3 ingots make the iron pickaxe
                const can_smelt = Math.floor(fuel.count * mc.getFuelSmeltOutput(fuel.name));
                if (can_smelt < 1) {
                    log(bot, `You don't have enough ${fuel.name} to smelt ${itemName}.`);
                    bot.closeWindow(furnace); // picking the furnace back up needs the inventory window
                    if (placedFurnace)
                        await collectBlock(bot, 'furnace', 1);
                    return false;
                }
                log(bot, `Only enough ${fuel.name} to smelt ${can_smelt} of the ${num} ${itemName}, smelting those.`);
                num = can_smelt;
                put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));
            }
            await furnace.putFuel(fuel.type, null, put_fuel);
            log(bot, `Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`);
            console.log(`Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`)
        }
        // put the items in the furnace
        await furnace.putInput(mc.getItemId(itemName), null, num);
        // wait for the items to smelt
        let total = 0;
        let smelted_item = null;
        await new Promise(resolve => setTimeout(resolve, 200));
        let last_collected = Date.now();
        while (total < num) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (furnace.outputItem()) {
                smelted_item = await furnace.takeOutput();
                if (smelted_item) {
                    total += smelted_item.count;
                    last_collected = Date.now();
                }
            }
            if (Date.now() - last_collected > 11000) {
                break; // if nothing has been collected in 11 seconds, stop
            }
            if (bot.interrupt_code) {
                break;
            }
        }
        // take all remaining in input/fuel slots
        if (furnace.inputItem()) {
            await furnace.takeInput();
        }
        if (furnace.fuelItem()) {
            await furnace.takeFuel();
        }

        await bot.closeWindow(furnace);

        if (placedFurnace) {
            await collectBlock(bot, 'furnace', 1);
        }
        if (total === 0) {
            log(bot, `Failed to smelt ${itemName}.`);
            return false;
        }
        if (total < num) {
            log(bot, `Only smelted ${total} ${mc.getItemName(smelted_item.type)}.`);
            return false;
        }
        // mineflayer used to lose track of smelted items until the bot reconnected, so check they showed up (see !smeltItem)
        const output_name = mc.getItemName(smelted_item.type);
        const expected = (inv_counts[output_name] || 0) + total;
        if ((world.getInventoryCounts(bot)[output_name] || 0) < expected)
            await resyncInventory(bot);
        bot._smelt_inventory_stale = (world.getInventoryCounts(bot)[output_name] || 0) < expected;
        log(bot, `Successfully smelted ${itemName}, got ${total} ${output_name}.`);
        return true;
    } finally {
        if (bot.currentWindow === furnace) bot.closeWindow(furnace);
    }
}

export async function clearNearestFurnace(bot) {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, 32);
    }

    console.log('clearing furnace...');
    const furnace = await bot.openFurnace(furnaceBlock);
    console.log('opened furnace...')
    // take the items out of the furnace
    let smelted_item, intput_item, fuel_item;
    if (furnace.outputItem())
        smelted_item = await furnace.takeOutput();
    if (furnace.inputItem())
        intput_item = await furnace.takeInput();
    if (furnace.fuelItem())
        fuel_item = await furnace.takeFuel();
    console.log(smelted_item, intput_item, fuel_item)
    let smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    let input_name = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    let fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}


export async function attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    bot.modes.pause('cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        bot.modes.pause('self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
}

export async function attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    let pos = entity.position;
    await equipHighestAttack(bot)

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...')
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        console.log('attacking mob...')
        await bot.attack(entity);
        return true;
    }

    let killed = false;
    if (isRangedTarget(bot, entity) && hasBowAndArrows(bot)) {
        killed = await shootEntity(bot, entity, 12);
    }
    if (!killed && isAlive(bot, entity) && !bot.interrupt_code) {
        killed = await meleeFight(bot, entity, {timeout: 120000});
    }
    if (!killed && isAlive(bot, entity) && !bot.interrupt_code && hasBowAndArrows(bot)) {
        // couldn't get to it on foot, try shooting instead
        killed = await shootEntity(bot, entity, 12);
    }
    if (bot.interrupt_code) return false;
    if (killed) {
        log(bot, `Successfully killed ${entity.name}.`);
        await pickupNearbyItems(bot);
        return true;
    }
    log(bot, `Failed to kill ${entity.name}.`);
    return false;
}

function isAlive(bot, entity) {
    return entity && entity.isValid !== false && bot.entities[entity.id] === entity;
}

function hasBowAndArrows(bot) {
    const items = bot.inventory.items();
    return items.some(i => i.name === 'bow') && items.some(i => i.name.includes('arrow'));
}

function isRangedTarget(bot, entity) {
    // targets we can't or shouldn't walk up to and hit
    const always_ranged = ['ghast', 'end_crystal', 'phantom'];
    if (always_ranged.includes(entity.name)) return true;
    const dy = entity.position.y - bot.entity.position.y;
    return entity.name === 'blaze' && dy > 2;
}

function isCreeperFusing(entity) {
    return entity.name === 'creeper' && entity.metadata && entity.metadata[16] === 1;
}

async function equipShield(bot) {
    const shield = bot.inventory.items().find(i => i.name === 'shield');
    const offhand = bot.inventory.slots[45];
    if (offhand?.name === 'shield') return true;
    if (!shield) return false;
    try {
        await bot.equip(shield, 'off-hand');
        return true;
    } catch (err) {
        return false;
    }
}

async function meleeFight(bot, entity, {timeout=60000} = {}) {
    /* Melee an entity until it dies. Times swings to the weapon cooldown, jump-crits when it can,
       blocks or backs off from exploding creepers, and gives up if the target can't be reached.
       Returns true if the entity died. */
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const reach = 3.0;
    bot.modes.pause('unstuck'); // standing still while trading blows isn't being stuck
    await equipHighestAttack(bot);
    const has_shield = await equipShield(bot);
    bot.pathfinder.setMovements(makeMovements(bot, {digCost: 8}));

    const start = Date.now();
    let last_attack = 0;
    let best_dist = Infinity;
    let last_progress = Date.now();
    let shielding = false;
    let mode = null; // 'chase' | 'flee' | null, so we don't reset the goal every tick
    const setMode = (m) => {
        if (m === mode) return;
        mode = m;
        if (m === 'chase') bot.pathfinder.setGoal(new pf.goals.GoalFollow(entity, 1.5), true);
        else if (m === 'flee') bot.pathfinder.setGoal(new pf.goals.GoalInvert(new pf.goals.GoalFollow(entity, 7)), true);
        else bot.pathfinder.setGoal(null);
    };
    const lowerShield = () => {
        if (shielding) bot.deactivateItem();
        shielding = false;
    };

    try {
        while (isAlive(bot, entity)) {
            if (bot.interrupt_code) return false;
            const now = Date.now();
            if (now - start > timeout) {
                log(bot, `Gave up fighting ${entity.name} after ${Math.round(timeout/1000)} seconds.`);
                return false;
            }
            const dist = bot.entity.position.distanceTo(entity.position);
            if (dist > 48) {
                log(bot, `${entity.name} got away.`);
                return false;
            }
            if (bot.health <= 8 && mc.isHostile(entity)) {
                log(bot, `Too hurt to keep fighting ${entity.name}.`);
                return false;
            }

            if (isCreeperFusing(entity) && dist < 5) {
                if (has_shield) {
                    setMode(null);
                    await bot.lookAt(entity.position.offset(0, 1, 0), true);
                    if (!shielding) bot.activateItem(true);
                    shielding = true;
                } else {
                    setMode('flee');
                }
                await sleep(100);
                continue;
            }
            // block with the shield whenever we aren't swinging: between swings up close (blocks melee hits), and while
            // walking up to an archer (blocks arrows). it comes down for each swing
            const cooldown = mc.getAttackCooldown(bot.heldItem?.name) * 1000;
            const swing_ready = dist <= reach && now - last_attack >= cooldown;
            const archer = ['skeleton', 'stray', 'bogged', 'pillager'].includes(entity.name);
            if (has_shield && !swing_ready && (dist < 4 || (archer && dist < 16))) {
                if (!shielding) bot.activateItem(true);
                shielding = true;
            }
            else {
                lowerShield();
            }

            if (dist < best_dist - 0.5) {
                best_dist = dist;
                last_progress = now;
            }
            if (dist > reach && now - last_progress > 15000) {
                log(bot, `Can't reach ${entity.name}.`);
                return false;
            }

            setMode('chase');
            if (swing_ready) {
                // critical hit: attack while falling after a jump. skip it in water/when the target is right on top of us
                const can_crit = bot.entity.onGround && !bot.entity.isInWater && !bot.entity.isInLava && dist > 1.5 && entity.name !== 'creeper';
                if (can_crit) {
                    // jump, then hit on the way down
                    bot.setControlState('jump', true);
                    for (let t = 0; t < 6 && bot.entity.onGround; t++) await sleep(25);
                    bot.setControlState('jump', false);
                    for (let t = 0; t < 10 && bot.entity.velocity.y > -0.05 && !bot.entity.onGround; t++) await sleep(50);
                }
                if (!isAlive(bot, entity)) break;
                if (bot.entity.position.distanceTo(entity.position) <= reach + 0.5) {
                    await bot.lookAt(entity.position.offset(0, entity.height * 0.8, 0), true);
                    bot.attack(entity);
                    last_attack = Date.now();
                }
            }
            await sleep(50);
        }
        return true;
    } finally {
        lowerShield();
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
    }
}

// --- archery ---
const ARROW_SPEED = 3.0; // blocks/tick at full draw
const ARROW_GRAVITY = 0.05;
const ARROW_DRAG = 0.99;

function simulateArrow(pitch, horizontal_dist) {
    // returns the arrow height relative to the shooter when it has covered horizontal_dist, and the ticks it took
    let vh = Math.cos(pitch) * ARROW_SPEED;
    let vy = Math.sin(pitch) * ARROW_SPEED;
    let h = 0, y = 0;
    for (let tick = 1; tick < 200; tick++) {
        const prev_h = h, prev_y = y;
        h += vh;
        y += vy;
        vh *= ARROW_DRAG;
        vy = vy * ARROW_DRAG - ARROW_GRAVITY;
        if (h >= horizontal_dist) {
            const f = (horizontal_dist - prev_h) / (h - prev_h);
            return {y: prev_y + (y - prev_y) * f, ticks: tick - 1 + f};
        }
        if (vh < 0.01) break;
    }
    return null;
}

function solveArrowPitch(horizontal_dist, dy, high=false) {
    // pitch whose arc passes through the target, or null if out of range. the flattest arc by default,
    // or a lob that comes down steeply onto the target when high is set
    const heightAt = deg => simulateArrow(deg * Math.PI / 180, horizontal_dist)?.y ?? null;
    let prev_deg = null, prev_y = null;
    const [from, to, step] = high ? [89, -60, -0.5] : [-60, 89, 0.5];
    for (let deg = from; high ? deg >= to : deg <= to; deg += step) {
        const y = heightAt(deg);
        // look for where the arc crosses the target height on the way from too low to high enough
        if (y !== null && prev_y !== null && prev_y < dy && y >= dy) {
            let lo = prev_deg, hi = deg; // heightAt(lo) < dy <= heightAt(hi)
            for (let i = 0; i < 20; i++) {
                const mid = (lo + hi) / 2;
                const mid_y = heightAt(mid);
                if (mid_y !== null && mid_y >= dy) hi = mid;
                else lo = mid;
            }
            const pitch = hi * Math.PI / 180;
            return {pitch, ticks: simulateArrow(pitch, horizontal_dist).ticks};
        }
        prev_deg = deg;
        prev_y = y;
    }
    return null;
}

function arrowPath(pitch, horizontal_dist) {
    // [{h, y}] points along the flight until it covers horizontal_dist, relative to the shooter
    const points = [];
    let vh = Math.cos(pitch) * ARROW_SPEED;
    let vy = Math.sin(pitch) * ARROW_SPEED;
    let h = 0, y = 0;
    for (let tick = 0; tick < 200 && h < horizontal_dist; tick++) {
        // sub-step so we don't skip over thin obstacles like a pillar edge or iron bars
        for (let k = 0; k < 16; k++) {
            h += vh / 16;
            y += vy / 16;
            points.push({h, y});
        }
        vh *= ARROW_DRAG;
        vy = vy * ARROW_DRAG - ARROW_GRAVITY;
    }
    return points;
}

function aimPoint(entity) {
    if (entity.name === 'end_crystal') return entity.position.offset(0, 1, 0);
    if (entity.name === 'ender_dragon') return entity.position.offset(0, 1.5, 0);
    return entity.position.offset(0, (entity.height || 1) * 0.6, 0);
}

async function fireArrowAt(bot, entity, {high=false, abort=null} = {}) {
    /* Draw the bow fully while tracking the target, then release with gravity and target movement accounted for.
       abort is checked while drawing; if it returns true the shot is called off. */
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const bow = bot.inventory.items().find(i => i.name === 'bow');
    if (!bow || !bot.inventory.items().some(i => i.name.includes('arrow'))) return false;
    if (bot.heldItem?.name !== 'bow') await bot.equip(bow, 'hand');

    let last_pos = entity.position.clone();
    let last_time = Date.now();
    let velocity = new Vec3(0, 0, 0); // blocks per tick, measured since server velocity is unreliable for big mobs
    const aim = async () => {
        const now = Date.now();
        if (now - last_time >= 100) {
            const ticks = (now - last_time) / 50;
            velocity = entity.position.minus(last_pos).scaled(1 / ticks);
            last_pos = entity.position.clone();
            last_time = now;
        }
        const eye = bot.entity.position.offset(0, bot.entity.height * 0.9 - 0.1, 0);
        const solve = (t) => solveArrowPitch(Math.hypot(t.x - eye.x, t.z - eye.z), t.y - eye.y, high);
        let target = aimPoint(entity);
        let solution = solve(target);
        for (let i = 0; i < 3 && solution; i++) { // lead the target by its flight time, refining a few times
            target = aimPoint(entity).plus(velocity.scaled(solution.ticks));
            solution = solve(target);
        }
        if (!solution) return false;
        const yaw = Math.atan2(-(target.x - eye.x), -(target.z - eye.z));
        await bot.look(yaw, solution.pitch, true);
        return true;
    };

    if (!(await aim())) {
        log(bot, `${entity.name} is out of bow range.`);
        return false;
    }
    bot.activateItem();
    const draw_start = Date.now();
    while (Date.now() - draw_start < 1150) {
        if (bot.interrupt_code || !isAlive(bot, entity) || abort?.()) {
            bot.deactivateItem();
            return false;
        }
        await aim();
        await sleep(50);
    }
    await aim();
    bot.deactivateItem();
    return true;
}

export async function shootEntity(bot, entity, maxShots=8, high=false) {
    /**
     * Shoot an entity with a bow until it dies or you run out of shots. Needs a bow and arrows. Use for end crystals, blazes, ghasts, the ender dragon, or anything out of reach.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to shoot.
     * @param {number} maxShots, the maximum number of arrows to fire. Defaults to 8.
     * @param {boolean} high, lob the arrows in a high arc so they come down on the target, e.g. over a wall. Defaults to false.
     * @returns {Promise<boolean>} true if the entity died, false otherwise.
     * @example
     * let crystal = world.getNearestEntityWhere(bot, e => e.name === 'end_crystal', 64);
     * await skills.shootEntity(bot, crystal);
     **/
    return await shootAt(bot, entity, maxShots, high);
}

async function shootAt(bot, entity, maxShots, high=false, abort=null) {
    /* shootEntity, but stops early (returning false) when abort() says so, e.g. to dodge. */
    if (!hasBowAndArrows(bot)) {
        log(bot, `Need a bow and arrows to shoot.`);
        return false;
    }
    stopPathfinding(bot);
    bot.modes.pause('unstuck');
    for (let shot = 0; shot < maxShots; shot++) {
        if (bot.interrupt_code || abort?.()) return false;
        if (!isAlive(bot, entity)) break;
        if (!hasBowAndArrows(bot)) {
            log(bot, `Ran out of arrows.`);
            break;
        }
        const fired = await fireArrowAt(bot, entity, {high, abort});
        if (!fired) break;
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    // give the last arrow time to land (unless we have to go)
    for (let t = 0; t < 30 && isAlive(bot, entity) && !abort?.(); t++) await new Promise(resolve => setTimeout(resolve, 100));
    const dead = !isAlive(bot, entity);
    if (dead) log(bot, `Shot down ${entity.name}.`);
    return dead;
}

export async function shootNearest(bot, entityType, maxShots=8) {
    /**
     * Shoot the nearest entity of the given type with a bow.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to shoot, e.g. 'end_crystal' or 'blaze'.
     * @param {number} maxShots, the maximum number of arrows to fire. Defaults to 8.
     * @returns {Promise<boolean>} true if the entity died, false otherwise.
     * @example
     * await skills.shootNearest(bot, 'blaze');
     **/
    const entity = world.getNearestEntityWhere(bot, e => e.name === entityType, 96);
    if (!entity) {
        log(bot, `Could not find any ${entityType} to shoot.`);
        return false;
    }
    return await shootEntity(bot, entity, maxShots);
}

export async function defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let attacked = false;
    const failed = new Set(); // enemies we couldn't reach, don't loop on them forever
    const nextEnemy = () => world.getNearestEntityWhere(bot, entity => mc.isThreat(bot, entity) && !failed.has(entity.id), range);
    let enemy = nextEnemy();
    while (enemy) {
        if (bot.interrupt_code) return false;
        // the decision to fight is made when it starts; if it goes badly, stop and let self defense hide or run
        if (bot.health <= 8) {
            log(bot, `Too hurt to keep fighting.`);
            break;
        }
        attacked = true;
        let killed = false;
        if (isRangedTarget(bot, enemy) && hasBowAndArrows(bot)) {
            killed = await shootEntity(bot, enemy, 6);
        }
        else {
            // short timeout so we re-evaluate which enemy is most urgent
            killed = await meleeFight(bot, enemy, {timeout: 20000});
            if (!killed && isAlive(bot, enemy) && hasBowAndArrows(bot) && !bot.interrupt_code)
                killed = await shootEntity(bot, enemy, 4);
        }
        if (bot.interrupt_code) return false;
        if (!killed && isAlive(bot, enemy))
            failed.add(enemy.id);
        enemy = nextEnemy();
    }
    bot.pathfinder.setGoal(null);
    if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked;
}



export async function collectBlock(bot, blockType, num=1, exclude=null) {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return false;
    }
    if (blockType === 'flint') {
        // flint only drops from gravel, one time in ten
        const flint = () => world.getInventoryCounts(bot)['flint'] || 0;
        const start = flint();
        let mined = 0;
        while (flint() - start < num && mined < num * 30 && !bot.interrupt_code) {
            if (!(await collectBlock(bot, 'gravel', 1)))
                break;
            mined++;
        }
        const got = flint() - start;
        log(bot, `Mined ${mined} gravel and got ${got} flint.`);
        return got > 0;
    }
    // items that come from mining a block of a different name
    const ore_items = {raw_iron: 'iron', raw_gold: 'gold', raw_copper: 'copper', quartz: 'nether_quartz_ore', clay_ball: 'clay'};
    if (ore_items[blockType])
        blockType = ore_items[blockType];
    let blocktypes = [blockType];
    if (['coal', 'diamond', 'emerald', 'iron', 'gold', 'copper', 'lapis_lazuli', 'redstone'].includes(blockType))
        blocktypes.push(blockType+'_ore');
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_'+blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;

    const movements = makeMovements(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;
    // the blocks we were asked to collect are fair game, even ones normally protected like crafting tables
    for (const type of blocktypes) {
        const id = mc.getBlockId(type);
        if (id != null) movements.blocksCantBreak.delete(id);
    }
    // collectblock paths with plain pathfinder movements of its own unless given some, which swim through anything.
    // it changes the ones it gets, so it gets its own copy
    bot.collectBlock.movements = makeMovements(bot);
    // collectblock turns dontCreateFlow off on the movements it's given, so its paths dug blocks next to and under
    // water: up to 25x slower to dig down there, and the bot ran out of air. keep it on, whatever the plugin sets
    Object.defineProperty(bot.collectBlock.movements, 'dontCreateFlow', { get: () => true, set: () => {} });
    for (const type of blocktypes) {
        const id = mc.getBlockId(type);
        if (id != null) bot.collectBlock.movements.blocksCantBreak.delete(id);
    }

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    let refused = 0; // blocks the server put back after we broke them, e.g. spawn protection
    const refused_positions = new Set();
    for (let i=0; i<num; i++) {
        if (bot.interrupt_code)
            break;
        let blocks = world.getNearestBlocksWhere(bot, block => {
            if (!blocktypes.includes(block.name)) {
                return false;
            }
            if (isLiquid && block.metadata !== 0) {
                // collect only source blocks
                return false;
            }
            if (!block.position) {
                // findBlocks first checks each chunk section's palette with position-less blocks
                return true;
            }
            if (exclude) {
                for (let position of exclude) {
                    if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) {
                        return false;
                    }
                }
            }
            if (refused_positions.has(block.position.toString())) {
                return false;
            }
            if (isLiquid) {
                return true;
            }
            
            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        }, 64, 16);

        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        // the nearest one is often high up a tree, and pillaring or climbing through leaves to it is slow and clumsy
        // for the pathfinder. prefer blocks near our feet, so it takes the low logs of nearby trees first
        const feet = bot.entity.position.y;
        const cost = b => b.position.distanceTo(bot.entity.position) + 4 * Math.max(0, b.position.y - feet - 2);
        const block = blocks.reduce((best, b) => cost(b) < cost(best) ? b : best);
        await bot.tool.equipForBlock(block);
        if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                return false;
            }
            await bot.equip(bucket, 'hand');
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null
        if (!block.canHarvest(itemId)) {
            log(bot, `Don't have right tools to harvest ${blockType}.`);
            return false;
        }
        const total_items = () => bot.inventory.items().reduce((sum, item) => sum + item.count, 0);
        const items_before = total_items();
        try {
            let success = false;
            if (isLiquid) {
                // a bucket only picks up source blocks, so make sure it actually filled
                const full = blockType + '_bucket';
                const before = world.getInventoryCounts(bot)[full] || 0;
                await useToolOnBlock(bot, 'bucket', block);
                await new Promise(resolve => setTimeout(resolve, 250));
                success = (world.getInventoryCounts(bot)[full] || 0) > before;
                if (!success) {
                    refused_positions.add(block.position.toString());
                    log(bot, `Couldn't fill the bucket from the ${blockType} at ${block.position}, trying another.`);
                }
            }
            else if (mc.mustCollectManually(blockType)) {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                await bot.dig(block);
                // give the drops (or the server's refusal) a moment to arrive
                await new Promise(resolve => setTimeout(resolve, 300));
                await pickupNearbyItems(bot);
                success = true;
            }
            else {
                await bot.collectBlock.collect(block);
                success = true;
            }
            // the client clears a dug block right away, even if the server refused the break. if nothing was picked
            // up, make sure it's really gone (a block that's back but dropped something is just sand or gravel
            // falling into the gap)
            if (success && !isLiquid && total_items() <= items_before && bot.game.gameMode !== 'creative' && !(await confirmBroken(bot, block))) {
                success = false;
                refused++;
                refused_positions.add(block.position.toString());
                if (refused >= 2) {
                    log(bot, `The server keeps putting the ${blockType} back after breaking it, so you can't break blocks here (spawn protection or a land claim?). Move further away and try again.`);
                    break;
                }
            }
            if (success)
                collected++;
            await autoLight(bot);
        }
        catch (err) {
            if (bot.interrupt_code)
                break;
            if (err.name === 'NoChests') {
                log(bot, `Failed to collect ${blockType}: Inventory full, no place to deposit.`);
                break;
            }
            else {
                log(bot, `Failed to collect ${blockType}: ${err}.`);
                continue;
            }
        }
        
        if (bot.interrupt_code)
            break;  
    }
    log(bot, `Collected ${collected} ${blockType}.`);
    return collected > 0;
}

export async function pickupNearbyItems(bot) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = 8;
    const getNearestItem = bot => bot.nearestEntity(entity => entity.name === 'item' && bot.entity.position.distanceTo(entity.position) < distance);
    let nearestItem = getNearestItem(bot);
    let pickedUp = 0;
    while (nearestItem) {
        let movements = makeMovements(bot);
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1));
        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}


async function confirmBroken(bot, block) {
    /* mineflayer marks a dug block as air right away. A server that refuses the break (spawn protection, land
       claims) doesn't necessarily correct that, and the bot goes on believing in a gap that isn't there. Click
       the spot again: if the block is still there, the server answers with its real state.
       Returns false if the block turned out to still be there. */
    const pos = block.position;
    if (bot.blockAt(pos)?.type === block.type) return false;
    bot._client.write('block_dig', { status: 0, location: pos, face: 1, sequence: 0 });
    bot._client.write('block_dig', { status: 1, location: pos, face: 1, sequence: 0 });
    for (let t = 0; t < 8; t++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (bot.blockAt(pos)?.type === block.type) return false;
    }
    return true;
}

export async function breakBlockAt(bot, x, y, z) {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    let block = bot.blockAt(Vec3(x, y, z));
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (bot.modes.isOn('cheat')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' air';
            bot.chat(msg);
            log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
            return true;
        }

        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            let pos = block.position;
            let movements = makeMovements(bot);
            movements.canPlaceOn = false;
            movements.allow1by1towers = false;
            bot.pathfinder.setMovements(movements);
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
        if (bot.game.gameMode !== 'creative') {
            await bot.tool.equipForBlock(block);
            const itemId = bot.heldItem ? bot.heldItem.type : null
            if (!block.canHarvest(itemId)) {
                log(bot, `Don't have right tools to break ${block.name}.`);
                return false;
            }
        }
        // a block that drops something was really broken. otherwise make sure the server didn't refuse it
        let dropped = false;
        const onDrop = entity => {
            if (entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) < 2) dropped = true;
        };
        bot.on('itemDrop', onDrop);
        try {
            await bot.dig(block, true);
            for (let t = 0; t < 6 && !dropped; t++) await new Promise(resolve => setTimeout(resolve, 50));
        } finally {
            bot.removeListener('itemDrop', onDrop);
        }
        if (!dropped && bot.game.gameMode !== 'creative' && !(await confirmBroken(bot, block))) {
            log(bot, `The server put the ${block.name} at ${block.position} back, you can't break blocks here (spawn protection or a land claim?).`);
            return false;
        }
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}


// blocks that are placed with an item of a different name, and the other way round
const BLOCK_TO_ITEM = {
    redstone_wire: 'redstone', water: 'water_bucket', lava: 'lava_bucket', powder_snow: 'powder_snow_bucket',
    tripwire: 'string', potatoes: 'potato', carrots: 'carrot', wheat: 'wheat_seeds', beetroots: 'beetroot_seeds',
    cocoa: 'cocoa_beans', sweet_berry_bush: 'sweet_berries', melon_stem: 'melon_seeds', pumpkin_stem: 'pumpkin_seeds',
    torchflower_crop: 'torchflower_seeds', pitcher_crop: 'pitcher_pod', cave_vines: 'glow_berries', bamboo_sapling: 'bamboo',
};
const ITEM_TO_BLOCK = Object.fromEntries(Object.entries(BLOCK_TO_ITEM).filter(([block]) => block !== 'bamboo_sapling')
    .map(([block, item]) => [item, block]));

function itemForBlock(name) {
    if (BLOCK_TO_ITEM[name]) return BLOCK_TO_ITEM[name];
    // wall torches, signs, banners and heads are placed with the regular item
    if (name.includes('wall_') && mc.getItemId(name) == null && mc.getItemId(name.replace('wall_', '')) != null)
        return name.replace('wall_', '');
    return name;
}

function blockForItem(name) {
    return ITEM_TO_BLOCK[name] ?? name;
}

export async function placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }
    // accept item names too, e.g. 'potato' places potatoes and 'water_bucket' places water
    blockType = blockForItem(blockType);

    if (bot.modes.isOn('cheat') && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                return false;
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        if (blockType.includes('door'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        if (blockType.includes('bed'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = itemForBlock(blockType);
    let block_item = await findItemAnywhere(bot, item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        return false;
    }

    const targetBlock = bot.blockAt(target_dest);
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return false;
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    const dir_map = {
        'top': Vec3(0, 1, 0),
        'bottom': Vec3(0, -1, 0),
        'north': Vec3(0, 0, -1),
        'south': Vec3(0, 0, 1),
        'east': Vec3(1, 0, 0),
        'west': Vec3(-1, 0, 0),
    }
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        const block = bot.blockAt(target_dest.plus(d));
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail', 
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        bot.pathfinder.setMovements(makeMovements(bot));
        await gotoWithWatchdog(bot, inverted_goal);
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        let pos = targetBlock.position;
        let movements = makeMovements(bot);
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            await bot.equip(block_item, 'hand');
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            await bot.placeBlock(buildOffBlock, faceVec);
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            await new Promise(resolve => setTimeout(resolve, 200));
            return true;
        }
    } catch (err) {
        log(bot, `Failed to place ${blockType} at ${target_dest}.`);
        return false;
    }
}

export async function equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        log(bot, `Unequipped hand.`);
        return true;
    }
    let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            log(bot, `You do not have any ${itemName} to equip.`);
            return false;
        }
    }
    if (itemName.includes('leggings')) {
        await bot.equip(item, 'legs');
    }
    else if (itemName.includes('boots')) {
        await bot.equip(item, 'feet');
    }
    else if (itemName.includes('helmet')) {
        await bot.equip(item, 'head');
    }
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
        await bot.equip(item, 'torso');
    }
    else if (itemName.includes('shield')) {
        await bot.equip(item, 'off-hand');
    }
    else {
        await bot.equip(item, 'hand');
    }
    log(bot, `Equipped ${itemName}.`);
    return true;
}

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    let discarded = 0;
    while (true) {
        let item = await findItemAnywhere(bot, itemName);
        if (!item) {
            break;
        }
        let to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
        await bot.toss(item.type, null, to_discard);
        discarded += to_discard;
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
}

export async function putInChest(bot, itemName, num=-1) {
    /**
     * Put the given item in the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    let item = await findItemAnywhere(bot, itemName);
    if (!item) {
        log(bot, `You do not have any ${itemName} to put in the chest.`);
        return false;
    }
    const have = bot.inventory.items().filter(i => i.name === itemName).reduce((sum, i) => sum + i.count, 0);
    let to_put = num === -1 ? have : Math.min(num, have);
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    await chestContainer.deposit(item.type, null, to_put);
    await chestContainer.close();
    log(bot, `Successfully put ${to_put} ${itemName} in the chest.`);
    return true;
}

export async function takeFromChest(bot, itemName, num=-1) {
    /**
     * Take the given item from the nearest chest, potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    
    // Find all matching items in the chest
    let matchingItems = chestContainer.containerItems().filter(item => item.name === itemName);
    if (matchingItems.length === 0) {
        log(bot, `Could not find any ${itemName} in the chest.`);
        await chestContainer.close();
        return false;
    }
    
    let totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
    let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;
    
    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;
        
        let toTakeFromSlot = Math.min(remaining, item.count);
        await chestContainer.withdraw(item.type, null, toTakeFromSlot);
        
        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }
    
    await chestContainer.close();
    log(bot, `Successfully took ${totalTaken} ${itemName} from the chest.`);
    return totalTaken > 0;
}

export async function viewChest(bot) {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    let items = chestContainer.containerItems();
    if (items.length === 0) {
        log(bot, `The chest is empty.`);
    }
    else {
        log(bot, `The chest contains:`);
        for (let item of items) {
            log(bot, `${item.count} ${item.name}`);
        }
    }
    await chestContainer.close();
    return true;
}

export async function consume(bot, itemName="") {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    let item, name;
    if (itemName) {
        item = await findItemAnywhere(bot, itemName);
        name = itemName;
    }
    if (!item) {
        log(bot, `You do not have any ${name} to eat.`);
        return false;
    }
    // most food can't be eaten on a full stomach (golden apples, chorus fruit and drinks can)
    const always = ['golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'milk_bucket', 'potion', 'honey_bottle', 'suspicious_stew'];
    if (bot.food >= 20 && bot.game.gameMode !== 'creative' && !always.includes(item.name)) {
        log(bot, `You're not hungry, so you can't eat ${item.name} right now.`);
        return false;
    }
    await bot.equip(item, 'hand');
    await bot.consume();
    log(bot, `Consumed ${item.name}.`);
    return true;
}


export async function giveToPlayer(bot, itemType, username, num=1) {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    let player = bot.players[username].entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }
    await goToPlayer(bot, username, 3);
    // if we are 2 below the player
    log(bot, bot.entity.position.y, player.position.y);
    if (bot.entity.position.y < player.position.y - 1) {
        await goToPlayer(bot, username, 1);
    }
    // if we are too close, make some distance
    if (bot.entity.position.distanceTo(player.position) < 2) {
        let too_close = true;
        let start_moving_away = Date.now();
        await moveAwayFromEntity(bot, player, 2);
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                await moveAwayFromEntity(bot, player, 5);
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            log(bot, `Failed to give ${itemType} to ${username}, too close.`);
            return false;
        }
    }

    await bot.lookAt(player.position);
    if (await discard(bot, itemType, num)) {
        let given = false;
        bot.once('playerCollect', (collector, collected) => {
            console.log(collected.name);
            if (collector.username === username) {
                log(bot, `${username} received ${itemType}.`);
                given = true;
            }
        });
        let start = Date.now();
        while (!given && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (given) {
                return true;
            }
            if (Date.now() - start > 3000) {
                break;
            }
        }
    }
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
}

export async function goToGoal(bot, goal) {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     **/

    // walking around is preferred, but digging through is allowed when it saves a long detour
    const carefulMovements = makeMovements(bot, {digCost: 10, placeCost: 2});
    for (let block of ['glass', 'glass_pane']) {
        carefulMovements.blocksCantBreak.add(mc.getBlockId(block));
    }
    let movements = carefulMovements;

    const doorCheckInterval = startDoorInterval(bot);

    const max_attempts = 3;
    try {
        for (let attempt = 1; ; attempt++) {
            bot.pathfinder.setMovements(movements);
            try {
                await gotoWithWatchdog(bot, goal);
                return true;
            } catch (err) {
                // don't retry if we were told to stop, or the goal was swapped out from under us
                const retryable = !bot.interrupt_code && attempt < max_attempts &&
                    !/GoalChanged|interrupt|stopped/i.test(err.name + ' ' + err.message);
                if (!retryable) throw err;
                log(bot, `Pathfinding hiccup (${err.message}), retrying...`);
                if (bot.entity.isInWater) {
                    // the pathfinder can't plan its way up out of deep water, swim out by hand
                    await swimToShore(bot, goal);
                }
                else {
                    // shake loose from whatever we were stuck on
                    bot.clearControlStates();
                    bot.setControlState('jump', true);
                    await new Promise(resolve => setTimeout(resolve, 400));
                    bot.setControlState('jump', false);
                }
                // and dig freely from now on
                movements = makeMovements(bot);
            }
        }
    } finally {
        clearInterval(doorCheckInterval);
    }
}

export function isWaterBlock(block) {
    if (!block) return false;
    if (['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'].includes(block.name)) return true;
    return block.getProperties?.().waterlogged === true;
}

async function swimToShore(bot, goal=null) {
    /* The pathfinder can't plan upward moves through water, so from below the surface of deep water it finds
       no way out. Steer by hand instead: swim up and towards the nearest bank (preferring ones towards the goal)
       and climb out, which works for banks up to one block above the water. Returns true if we got onto land. */
    const pos = bot.entity.position;
    const surface_y = () => {
        let y = Math.floor(pos.y);
        while (isWaterBlock(bot.blockAt(new Vec3(pos.x, y + 1, pos.z))) && y < pos.y + 32) y++;
        return y;
    };
    const water_top = surface_y();
    const goal_xz = goal && Number.isFinite(goal.x) && Number.isFinite(goal.z) ? goal : null;
    const banks = bot.findBlocks({
        matching: block => block && block.boundingBox === 'block' && !isWaterBlock(block),
        useExtraInfo: block => {
            const y = block.position.y;
            if (y < water_top - 1 || y > water_top + 1) return false;
            const a1 = bot.blockAt(block.position.offset(0, 1, 0));
            const a2 = bot.blockAt(block.position.offset(0, 2, 0));
            return a1 && a2 && a1.boundingBox === 'empty' && a2.boundingBox === 'empty' && !isWaterBlock(a1) && !isWaterBlock(a2);
        },
        maxDistance: 32,
        count: 64,
    });
    if (banks.length === 0) {
        log(bot, `Can't see any land to swim to.`);
        return false;
    }
    // climbing out onto a ledge well above the water often fails, so prefer low banks (top at the water surface or
    // one block above), and try the next one when a bank can't be climbed
    const cost = p => p.distanceTo(pos) + (goal_xz ? 0.5 * Math.hypot(p.x - goal_xz.x, p.z - goal_xz.z) : 0) +
        4 * Math.max(0, p.y - (water_top - 1));
    banks.sort((a, b) => cost(a) - cost(b));

    stopPathfinding(bot);
    const start = Date.now();
    try {
        for (const bank of banks.slice(0, 3)) {
            const target = bank.offset(0.5, 1, 0.5);
            log(bot, `Swimming to land at ${bank.offset(0, 1, 0)}.`);
            let best = Infinity, last_progress = Date.now();
            while (Date.now() - start < 30000) {
                if (bot.interrupt_code) return false;
                const here = bot.entity.position;
                const dist = Math.hypot(target.x - here.x, target.z - here.z);
                if (!bot.entity.isInWater && bot.entity.onGround && (dist < 1.5 || here.y >= target.y - 0.5)) break;
                // getting closer or rising up along the bank both count as progress
                const remaining = dist + Math.max(0, target.y - here.y);
                if (remaining < best - 0.3) {
                    best = remaining;
                    last_progress = Date.now();
                }
                else if (Date.now() - last_progress > 5000) {
                    log(bot, `Couldn't reach the bank.`);
                    break;
                }
                await bot.lookAt(new Vec3(target.x, here.y + 0.5, target.z), true);
                bot.setControlState('forward', dist > 0.3);
                bot.setControlState('jump', true);
                bot.setControlState('sprint', false);
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (!bot.entity.isInWater) break;
        }
    } finally {
        bot.clearControlStates();
    }
    const ok = !bot.entity.isInWater;
    if (ok) log(bot, `Got out of the water at ${bot.entity.position.floored()}.`);
    return ok;
}

export async function swimToAir(bot) {
    /**
     * Swim straight up to breathe when running out of air underwater, then swim to the nearest land.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bot got its head above water, false otherwise.
     * @example
     * await skills.swimToAir(bot);
     **/
    const headInWater = () => isWaterBlock(bot.blockAt(bot.entity.position.offset(0, 1.62, 0)));
    stopPathfinding(bot);
    const start = Date.now();
    try {
        while (headInWater() && Date.now() - start < 10000) {
            if (bot.interrupt_code) return false;
            bot.setControlState('jump', true);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    } finally {
        bot.clearControlStates();
    }
    if (headInWater()) {
        // something is in the way above, so head for a bank instead
        log(bot, `Couldn't swim straight up for air.`);
        return await swimToShore(bot);
    }
    log(bot, `Came up for air at ${bot.entity.position.floored()}.`);
    // get out of the water too, or the next path dives straight back down
    await swimToShore(bot);
    return true;
}

export async function bunkerDown(bot) {
    /**
     * Hide from mobs: dig two blocks straight down and seal the hole above. Use it when hurt at night with no way to
     * win a fight. Afterwards you are underground and can mine your way onward.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bot is sealed in, false if it wasn't safe to dig down here.
     * @example
     * await skills.bunkerDown(bot);
     **/
    const start = bot.entity.position.floored();
    if (bot.entity.isInWater) {
        log(bot, `Can't bunker down in water, the hole would flood.`);
        return false;
    }
    // the two blocks we dig and the one we land on must be solid: no digging into lava, water or a cave drop
    for (let dy = 1; dy <= 3; dy++) {
        const block = bot.blockAt(start.offset(0, -dy, 0));
        if (!block || block.boundingBox !== 'block' || (dy <= 2 && !block.diggable) || DANGER_BLOCKS.includes(block.name) || isWaterBlock(block)) {
            log(bot, `Can't bunker down here: ${block?.name || 'unloaded'} ${dy} below.`);
            return false;
        }
    }
    const scaffold = getScaffoldItem(bot);
    stopPathfinding(bot);
    for (let dy = 1; dy <= 2; dy++) {
        const block = bot.blockAt(start.offset(0, -dy, 0));
        try {
            await bot.tool.equipForBlock(block);
            await bot.dig(block);
        } catch (err) {
            log(bot, `Couldn't dig down to bunker: ${err.message}.`);
            return false;
        }
        // let gravity bring us down into the hole before digging the next block
        for (let t = 0; t < 20 && bot.entity.position.y > start.y - dy + 0.1; t++)
            await new Promise(resolve => setTimeout(resolve, 50));
    }
    // seal the top: the old feet level, now two blocks above our feet
    if (scaffold && await placeBlock(bot, scaffold.name, start.x, start.y, start.z, 'bottom', true)) {
        log(bot, `Bunkered down at ${bot.entity.position.floored()}, sealed in until it's safe.`);
        return true;
    }
    // nothing to seal it with: dig a pocket to the side and step into it, out of sight of archers above the hole
    const bottom = start.offset(0, -2, 0);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const feet = bot.blockAt(bottom.offset(dx, 0, dz)), head = bot.blockAt(bottom.offset(dx, 1, dz));
        const floor = bot.blockAt(bottom.offset(dx, -1, dz)), roof = bot.blockAt(bottom.offset(dx, 2, dz));
        const ok = b => b && (b.boundingBox === 'empty' || b.diggable) && !isWaterBlock(b) && b.name !== 'lava';
        if (!ok(feet) || !ok(head) || floor?.boundingBox !== 'block' || roof?.boundingBox !== 'block') continue;
        try {
            for (const b of [head, feet]) {
                if (b.boundingBox === 'block') {
                    await bot.tool.equipForBlock(b);
                    await bot.dig(b);
                }
            }
        } catch (err) {
            continue;
        }
        const target = bottom.offset(dx + 0.5, 0, dz + 0.5);
        for (let t = 0; t < 30 && Math.hypot(target.x - bot.entity.position.x, target.z - bot.entity.position.z) > 0.3; t++) {
            await bot.lookAt(target.offset(0, 1.6, 0), true);
            bot.setControlState('forward', true);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        bot.setControlState('forward', false);
        log(bot, `Bunkered down in a pocket at ${bot.entity.position.floored()}, out of sight until it's safe.`);
        return true;
    }
    log(bot, `Dug down to hide at ${bot.entity.position.floored()}, but couldn't seal the hole or dig a pocket.`);
    return true;
}

export async function digOut(bot) {
    /**
     * Break the blocks the bot is stuck inside of, e.g. after sand or gravel fell on it, so it stops suffocating.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bot got free, false otherwise.
     * @example
     * await skills.digOut(bot);
     **/
    // the pathfinder can't plan a way out from inside a block, and harvesting doesn't matter here, only getting free
    stopPathfinding(bot);
    const pos = bot.entity.position;
    for (const dy of [1, 0]) { // head first, that's the one we suffocate in
        const block = bot.blockAt(pos.offset(0, dy, 0));
        if (!block || block.boundingBox !== 'block' || !block.diggable) continue;
        try {
            await bot.tool.equipForBlock(block);
            await bot.dig(block);
        } catch (err) {
            log(bot, `Couldn't dig out of ${block.name}: ${err.message}.`);
            return false;
        }
        log(bot, `Dug out of ${block.name} at ${block.position}.`);
    }
    return true;
}

async function gotoWithWatchdog(bot, goal, noProgressMs=30000) {
    /* bot.pathfinder.goto, but it settles as soon as the action is interrupted (the pathfinder only checks
       its stop flag when it reaches the next node of a path, which may never happen), and gives up when the
       bot hasn't gotten any closer to the goal for a while. */
    const heuristic = () => {
        try {
            const h = goal.heuristic(bot.entity.position.floored());
            return Number.isFinite(h) ? h : null;
        } catch (err) {
            return null;
        }
    };
    let best = heuristic();
    let last_progress = Date.now();
    let gave_up = null;
    let last_pos = bot.entity.position.clone();
    let still_since = Date.now();
    const watchdog = setInterval(() => {
        if (bot.interrupt_code) {
            stopPathfinding(bot);
            return;
        }
        const h = heuristic();
        if (h !== null && (best === null || h < best - 0.5)) {
            best = h;
            last_progress = Date.now();
        }
        else if (Date.now() - last_progress > noProgressMs) {
            gave_up = `Made no progress towards the goal for ${Math.round(noProgressMs / 1000)} seconds`;
            stopPathfinding(bot);
        }
        // hanging in the air without falling means we're wedged on a block the server and we disagree about
        // (usually one we just placed while towering). the pathfinder waits to land before its next step, forever
        const p = bot.entity.position;
        if (p.distanceTo(last_pos) > 0.1 || bot.targetDigBlock || bot.entity.onGround || bot.entity.isInWater || bot.entity.isInLava) {
            last_pos = p.clone();
            still_since = Date.now();
        }
        else if (Date.now() - still_since > 3000) {
            gave_up = 'Got wedged in mid-air';
            stopPathfinding(bot);
        }
    }, 250);
    try {
        await bot.pathfinder.goto(goal);
    } catch (err) {
        if (gave_up) {
            const stuck = new Error(gave_up);
            stuck.name = 'NoProgress';
            throw stuck;
        }
        throw err;
    } finally {
        clearInterval(watchdog);
    }
}

let _doorInterval = null;
function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ]
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor'))) 
                {
                    bot.activateBlock(block);
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

export async function goToPosition(bot, x, y, z, min_distance=2) {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.x + 20);
     **/
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }
    
    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!targetBlock.canHarvest(itemId)) {
                log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
                stopPathfinding(bot);
                bot.stopDigging();
            }
        }
    };
    
    // far away targets are often in unloaded chunks, so hop there in segments first
    const horizontal = Math.hypot(bot.entity.position.x - x, bot.entity.position.z - z);
    if (horizontal > TRAVEL_SEGMENT * 1.5) {
        const arrived = await travelTo(bot, x, z, 32);
        if (!arrived) return false;
    }

    const progressInterval = setInterval(checkDigProgress, 1000);

    try {
        await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance));
        clearInterval(progressInterval);
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance+1) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        else {
            log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
            return false;
        }
    } catch (err) {
        log(bot, `Pathfinding stopped: ${err.message}.`);
        clearInterval(progressInterval);
        return false;
    }
}

const TRAVEL_SEGMENT = 64;
let _exploreAngle = null;

export async function travelTo(bot, x, z, min_distance=8) {
    /**
     * Travel a long distance over land to the given x, z coordinates, in segments. Use this for trips of hundreds or thousands of blocks, where the y coordinate is unknown.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to travel to.
     * @param {number} z, the z coordinate to travel to.
     * @param {number} min_distance, how close to get. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot arrived, false otherwise.
     * @example
     * await skills.travelTo(bot, 1200, -340);
     **/
    if (bot.modes.isOn('cheat')) {
        // spreadplayers lands on the surface instead of inside the ground
        bot.chat(`/spreadplayers ${Math.round(x)} ${Math.round(z)} 0 1 false @s`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        log(bot, `Teleported to ${x}, ${z}.`);
        return true;
    }
    const start = bot.entity.position.clone();
    const dist = () => Math.hypot(bot.entity.position.x - x, bot.entity.position.z - z);
    let failures = 0;
    while (dist() > min_distance) {
        if (bot.interrupt_code) return false;
        const pos = bot.entity.position;
        const remaining = dist();
        const step = Math.min(TRAVEL_SEGMENT, remaining);
        // after a failure, veer left or right to route around whatever blocked us
        const angle = Math.atan2(z - pos.z, x - pos.x) + (failures === 0 ? 0 : (failures % 2 ? 1 : -1) * 0.6 * Math.ceil(failures / 2));
        const wx = pos.x + Math.cos(angle) * step;
        const wz = pos.z + Math.sin(angle) * step;
        const before = remaining;
        try {
            await goToGoal(bot, new pf.goals.GoalNearXZ(wx, wz, step < TRAVEL_SEGMENT ? min_distance : 6));
        } catch (err) {
            if (bot.interrupt_code) return false;
        }
        if (dist() < before - 8) {
            failures = 0;
        }
        else if (++failures > 6) {
            log(bot, `Could not make progress towards ${x}, ${z}; stuck at ${bot.entity.position.floored()}, ${Math.round(dist())} blocks away.`);
            return false;
        }
    }
    log(bot, `Traveled from ${start.floored()} to ${bot.entity.position.floored()}, near ${x}, ${z}.`);
    return true;
}

export async function explore(bot, distance=100) {
    /**
     * Travel in a random new direction to discover new areas and load new chunks, e.g. when you can't find a block or mob nearby.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, how far to go. Defaults to 100.
     * @returns {Promise<boolean>} true if the bot moved, false otherwise.
     * @example
     * await skills.explore(bot, 150);
     **/
    // keep roughly the same heading as the last exploration so repeated calls cover new ground
    if (_exploreAngle === null) _exploreAngle = Math.random() * 2 * Math.PI;
    _exploreAngle += (Math.random() - 0.5) * Math.PI / 2;
    const angle = _exploreAngle;
    const pos = bot.entity.position;
    const x = Math.round(pos.x + Math.cos(angle) * distance);
    const z = Math.round(pos.z + Math.sin(angle) * distance);
    log(bot, `Exploring towards ${x}, ${z}.`);
    return await travelTo(bot, x, z, 10);
}

export async function goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    let block = null;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else {
        // getting to something under water means diving for it, so take the nearest one that isn't when there is one
        const underwater = (b) => {
            for (let dy = 1; dy <= 4; dy++) {
                const above = bot.blockAt(b.position.offset(0, dy, 0));
                if (isWaterBlock(above)) return true;
                if (!above || above.boundingBox === 'empty') return false;
            }
            return false;
        };
        const blocks = world.getNearestBlocks(bot, blockType, range, 16);
        block = blocks.find(b => !underwater(b)) || blocks[0];
    }
    if (!block) {
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
    return true;
}

export async function goToNearestEntity(bot, entityType, min_distance=2, range=64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
    return true;
}

export async function goToPlayer(bot, username, distance=3) {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + username);
        log(bot, `Teleported to ${username}.`);
        return true;
    }

    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let player = bot.players[username].entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(player, distance);

    await goToGoal(bot, goal, true);

    log(bot, `You have reached ${username}.`);
}


export async function followPlayer(bot, username, distance=4) {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    let player = bot.players[username].entity
    if (!player)
        return false;

    const move = makeMovements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
    log(bot, `You are now actively following player ${username}.`);


    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // in cheat mode, if the distance is too far, teleport to the player
        const distance_from_player = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const ignore_modes_distance = 30; 
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && bot.modes.isOn('cheat')) {
            // teleport with cheat mode
            await goToPlayer(bot, username);
        }
        else if (distance_from_player > ignore_modes_distance) {
            // these modes slow down the bot, and we want to catch up
            bot.modes.pause('item_collecting');
            bot.modes.pause('hunting');
            bot.modes.pause('torch_placing');
        }
        else if (distance_from_player <= ignore_modes_distance) {
            bot.modes.unpause('item_collecting');
            bot.modes.unpause('hunting');
            bot.modes.unpause('torch_placing');
        }

        if (distance_from_player <= nearby_distance) {
            clearInterval(doorCheckInterval);
            doorCheckInterval = null;
            bot.modes.pause('unstuck');
            bot.modes.pause('elbow_room');
        }
        else {
            if (!doorCheckInterval) {
                doorCheckInterval = startDoorInterval(bot);
            }
            bot.modes.unpause('unstuck');
            bot.modes.unpause('elbow_room');
        }
    }
    clearInterval(doorCheckInterval);
    return true;
}


export async function moveAway(bot, distance) {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    const pos = bot.entity.position;
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(makeMovements(bot));

    if (bot.modes.isOn('cheat')) {
        const move = makeMovements(bot);
        const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        let last_move = path.path[path.path.length-1];
        if (last_move) {
            let x = Math.floor(last_move.x);
            let y = Math.floor(last_move.y);
            let z = Math.floor(last_move.z);
            bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
            return true;
        }
    }

    await goToGoal(bot, inverted_goal);
    let new_pos = bot.entity.position;
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    return true;
}

export async function moveAwayFromEntity(bot, entity, distance=16) {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(makeMovements(bot));
    await gotoWithWatchdog(bot, inverted_goal);
    return true;
}

export async function avoidEnemies(bot, distance=16) {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    bot.modes.pause('self_preservation'); // prevents damage-on-low-health from interrupting the bot
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isThreat(bot, entity), distance);
    // a faster mob or an archer can keep up forever, and self_preservation (air, healing) is paused while we run
    const start = Date.now();
    while (enemy && Date.now() - start < 20000) {
        const follow = new pf.goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal = new pf.goals.GoalInvert(follow);
        bot.pathfinder.setMovements(makeMovements(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isThreat(bot, entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    stopPathfinding(bot);
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
}

export async function stay(bot, seconds=30) {
    /**
     * Stay in the current position until interrupted. Disables all modes.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    bot.modes.pause('self_preservation');
    bot.modes.pause('unstuck');
    bot.modes.pause('cowardice');
    bot.modes.pause('self_defense');
    bot.modes.pause('hunting');
    bot.modes.pause('torch_placing');
    bot.modes.pause('item_collecting');
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}

export async function useDoor(bot, door_pos=null) {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            door_pos = world.getNearestBlock(bot, door_type, 16).position;
            if (door_pos) break;
        }
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    
    let door_block = bot.blockAt(door_pos);
    await bot.lookAt(door_pos);
    if (!door_block._properties.open)
        await bot.activateBlock(door_block);
    
    bot.setControlState("forward", true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    bot.setControlState("forward", false);
    await bot.activateBlock(door_block);

    log(bot, `Used door at ${door_pos}.`);
    return true;
}

export async function goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds = bot.findBlocks({
        matching: (block) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    let loc = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    const bed = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    bot.modes.pause('unstuck');
    while (bot.isSleeping) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
}

export async function tillAndSow(bot, x, y, z, seedType=null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (bot.modes.isOn('cheat')) {
        let to_remove = ['_seed', '_seeds'];
        for (let remove of to_remove) {
            if (seedType.endsWith(remove)) {
                seedType = seedType.replace(remove, '');
            }
        }
        placeBlock(bot, 'farmland', x, y, z);
        placeBlock(bot, seedType, x, y+1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(makeMovements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await bot.activateBlock(block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    
    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        let equipped_seeds = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.`);
            return false;
        }

        await bot.activateBlock(block);
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(makeMovements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    await bot.activateBlock(block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    id = id+"";
    const entity = bot.entities[id];
    
    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        let entities = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (let entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }
    
    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }
    
    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }
    
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            bot.modes.pause('unstuck');
            const goal = new pf.goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);
            
            
            log(bot, 'Successfully reached villager');
        } catch (err) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            console.log(err);
            return null;
        } finally {
            bot.modes.unpause('unstuck');
        }
    }
    
    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot, id) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            const tradeInfo = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });
        
        villager.close();
        return true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        console.log('Villager trading error:', err.message);
        return false;
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function tradeWithVillager(bot, id, index, count) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }
        
        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr) {
            log(bot, 'An error occurred while trying to execute the trade');
            console.log('Trade execution error:', tradeErr.message);
            villager.close();
            return false;
        }
    } catch (err) {
        log(bot, 'Failed to open villager trading interface');
        console.log('Villager interface error:', err.message);
        return false;
    }
}

function hasResources(window, trade, count) {
    const first = enough(trade.inputItem1, count);
    const second = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e) => {
                const lvl = e.lvl.value;
                const id = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

async function centerOnBlock(bot) {
    /* Shuffle (sneaking, so we can't walk off anything) to the middle of the block we're standing in. Off center,
       our hitbox overhangs the next block over and we can end up standing on that instead of what's under us. */
    const target = bot.entity.position.floored().offset(0.5, 0, 0.5);
    try {
        bot.setControlState('sneak', true);
        for (let t = 0; t < 30; t++) {
            const p = bot.entity.position;
            const dx = target.x - p.x, dz = target.z - p.z;
            if (Math.hypot(dx, dz) < 0.12) break;
            await bot.look(Math.atan2(-dx, -dz), bot.entity.pitch, true);
            bot.setControlState('forward', true);
            await new Promise(resolve => setTimeout(resolve, 50));
            bot.setControlState('forward', false);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    } finally {
        bot.setControlState('forward', false);
        bot.setControlState('sneak', false);
    }
}

async function moveToDryGround(bot, range=12) {
    /* Walk to the nearest spot with no water within 2 blocks around it or 3 below, so digging down there won't
       hit water. Returns true if we got there. */
    const pos = bot.entity.position.floored();
    const dry = (p) => {
        for (let dx = -2; dx <= 2; dx++)
            for (let dz = -2; dz <= 2; dz++)
                for (let dy = -3; dy <= 1; dy++)
                    if (isWaterBlock(bot.blockAt(p.offset(dx, dy, dz)))) return false;
        return true;
    };
    const spots = bot.findBlocks({
        matching: block => block && block.boundingBox === 'block' && !isWaterBlock(block),
        useExtraInfo: block => {
            const p = block.position;
            if (Math.abs(p.y - (pos.y - 1)) > 3) return false;
            const a1 = bot.blockAt(p.offset(0, 1, 0)), a2 = bot.blockAt(p.offset(0, 2, 0));
            return a1?.boundingBox === 'empty' && a2?.boundingBox === 'empty' && dry(p);
        },
        maxDistance: range,
        count: 1,
    });
    if (spots.length === 0) return false;
    log(bot, `Moving away from the water to dig at ${spots[0].offset(0, 1, 0)}.`);
    return await goToPosition(bot, spots[0].x, spots[0].y + 1, spots[0].z, 0);
}

export async function digStairsDown(bot, distance = 10, _find_dry_ground = true) {
    /**
     * Dig a staircase down the given number of blocks, so you can walk back up it later. Stops at lava, water or drops.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, how many blocks down to go.
     * @returns {Promise<boolean>} true if it got all the way down.
     * @example
     * await skills.digStairsDown(bot, 10);
     **/
    // a straight shaft down is a trap on the way back: climbing it means pillaring up one block at a time, which the
    // pathfinder is slow and clumsy at. stairs can be walked back up
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const unsafe = b => !b || b.name === 'lava' || isWaterBlock(b) || DANGER_BLOCKS.includes(b.name);
    let dir = null;
    for (let i = 0; i < distance; i++) {
        if (bot.interrupt_code) return false;
        const pos = bot.entity.position.floored();
        // a step: head height, feet height and one below in front of us, with solid ground under it, and no water
        // or lava next to anything we open up
        const stepOk = ([dx, dz]) => {
            const blocks = [1, 0, -1].map(dy => bot.blockAt(pos.offset(dx, dy, dz)));
            if (blocks.some(b => unsafe(b) || (b.boundingBox === 'block' && !b.diggable))) return false;
            const floor = bot.blockAt(pos.offset(dx, -2, dz));
            if (!floor || floor.boundingBox !== 'block' || unsafe(floor)) return false;
            if (unsafe(bot.blockAt(pos.offset(dx, 2, dz)))) return false;
            return blocks.every(b => dirs.every(([ox, oz]) => !unsafe(bot.blockAt(b.position.offset(ox, 0, oz))) ||
                (ox === -dx && oz === -dz))); // the side we come from is us, not water
        };
        if (!dir || !stepOk(dir)) dir = dirs.find(stepOk);
        if (!dir && i === 0 && _find_dry_ground && await moveToDryGround(bot)) {
            // standing by water we can't dig down at all: start again from dry ground nearby
            return await digStairsDown(bot, distance, false);
        }
        if (!dir) {
            // a step needs more room than a shaft does, so dig the rest straight down (it stops at lava, water and
            // drops too) rather than give up and wander off to dig somewhere else
            log(bot, `Dug ${i} steps down, then no safe direction for stairs, so digging straight down.`);
            return await digDown(bot, distance - i);
        }
        // gravel and sand above fall into the gap as soon as it opens, so clear the step again until it stays clear
        for (let round = 0; round < 8; round++) {
            let dug = false;
            for (const dy of [1, 0, -1]) {
                const b = bot.blockAt(pos.offset(dir[0], dy, dir[1]));
                if (b.boundingBox !== 'block') continue;
                if (!await breakBlockAt(bot, b.position.x, b.position.y, b.position.z)) {
                    log(bot, `Failed to dig the staircase at ${b.position}.`);
                    return false;
                }
                dug = true;
            }
            if (!dug) break;
            await new Promise(resolve => setTimeout(resolve, 400));
        }
        // walk down into the step
        const target = pos.offset(dir[0] + 0.5, -1, dir[1] + 0.5);
        try {
            for (let t = 0; t < 40; t++) {
                if (bot.interrupt_code) return false;
                const p = bot.entity.position;
                if (Math.hypot(target.x - p.x, target.z - p.z) < 0.3 && p.y < pos.y - 0.5) break;
                await bot.lookAt(new Vec3(target.x, p.y + 1.6, target.z), true);
                bot.setControlState('forward', true);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        } finally {
            bot.setControlState('forward', false);
        }
        if (bot.entity.position.y > pos.y - 0.5) {
            log(bot, `Couldn't step down the staircase at ${target.floored()}.`);
            return false;
        }
    }
    log(bot, `Dug a staircase ${distance} blocks down to ${bot.entity.position.floored()}.`);
    return true;
}

export async function digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/

    let start_block_pos = bot.blockAt(bot.entity.position).position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            log(bot, `Dug down ${i-1} blocks, but reached the end of the world.`);
            return true;
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' || 
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            log(bot, `Dug down ${i-1} blocks, but reached ${belowBlock ? belowBlock.name : '(lava/water)'}`)
            return false;
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            log(bot, `Dug down ${i-1} blocks, but reached a drop below the next block.`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            console.log(targetBlock.position);
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        if (!dug) {
            log(bot, 'Failed to dig block at position:' + targetBlock.position);
            return false;
        }
        // drop into the hole before digging the next block. digging while still falling counts as digging in
        // mid air (5x slower), so the server would reject the break and put the block back
        for (let t = 0; t < 30; t++) {
            if (bot.entity.onGround && bot.entity.position.y < targetBlock.position.y + 0.1) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (bot.entity.position.y >= targetBlock.position.y + 0.5) {
            // still up here: we're standing on the edge of a block next to the hole. step into the hole
            await centerOnBlock(bot);
            for (let t = 0; t < 30 && bot.entity.position.y >= targetBlock.position.y + 0.5; t++)
                await new Promise(resolve => setTimeout(resolve, 50));
            if (bot.entity.position.y >= targetBlock.position.y + 0.5) {
                log(bot, `Dug down ${i-1} blocks, but can't get into the hole.`);
                return false;
            }
        }
    }
    log(bot, `Dug down ${distance} blocks.`);
    return true;
}

export async function goToSurface(bot) {
    /**
     * Navigate to the surface (highest non-air block at current x,z). Digs and pillars straight up if there is no walkable way out.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos = bot.entity.position;
    const top = bot.game.height ? bot.game.minY + bot.game.height : 320;
    let surface = null;
    for (let y = top - 1; y > pos.y; y--) {
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        // treetops don't count as being underground
        if (block && block.boundingBox === 'block' && !block.name.includes('leaves')) {
            surface = block;
            break;
        }
    }
    if (!surface) {
        log(bot, `Already at the surface.`);
        return true;
    }
    if (bot.game.dimension?.includes('nether')) {
        log(bot, `Can't go to the surface in the nether, the bedrock ceiling is above you.`);
        return false;
    }
    const target_y = surface.position.y + 1;
    log(bot, `Going to the surface at y=${target_y}.`);
    const reached = await goToPosition(bot, surface.position.x, target_y, surface.position.z, 2);
    if (reached && bot.entity.position.y >= target_y - 1) return true;
    if (bot.interrupt_code) return false;
    log(bot, `No walkable path up, digging straight up instead.`);
    return await pillarUp(bot, Math.ceil(target_y - bot.entity.position.y));
}

export async function pillarUp(bot, height=1) {
    /**
     * Tower straight up by jumping and placing blocks underneath, digging through anything overhead. Needs cheap blocks like dirt or cobblestone.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} height, number of blocks to go up.
     * @returns {Promise<boolean>} true if the bot climbed the full height, false otherwise.
     * @example
     * await skills.pillarUp(bot, 5);
     **/
    return await towerUp(bot, height);
}

async function towerUp(bot, height, abort=null) {
    /* pillarUp, but stops (returning false) when abort() says so. */
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    stopPathfinding(bot);
    await centerOnBlock(bot);
    const start_y = Math.floor(bot.entity.position.y);
    const target_y = start_y + height;
    const column = bot.entity.position.floored();
    let failures = 0;
    while (Math.floor(bot.entity.position.y + 0.01) < target_y) {
        if (bot.interrupt_code || abort?.()) return false;
        // knocked off (or pushed onto something else): this isn't our tower any more
        const p = bot.entity.position;
        if (Math.hypot(p.x - (column.x + 0.5), p.z - (column.z + 0.5)) > 1.5) {
            log(bot, `Got knocked off the pillar.`);
            return false;
        }
        if (failures > 4) {
            log(bot, `Couldn't pillar up, stopped at y=${Math.floor(bot.entity.position.y)}.`);
            return false;
        }
        const feet = bot.entity.position.floored();
        // make headroom, gravel and sand may keep falling so check a few times
        for (let i = 0; i < 6; i++) {
            const above = bot.blockAt(feet.offset(0, 2, 0));
            if (!above || above.boundingBox !== 'block') break;
            if (above.name === 'bedrock' || !(await breakBlockAt(bot, above.position.x, above.position.y, above.position.z))) {
                log(bot, `Blocked by ${above?.name} overhead.`);
                return false;
            }
            await sleep(250);
        }
        const above = bot.blockAt(feet.offset(0, 2, 0));
        if (above && above.boundingBox === 'block') { failures++; continue; }

        const scaffold = getScaffoldItem(bot);
        if (!scaffold) {
            log(bot, `Need blocks like dirt or cobblestone to pillar up.`);
            return false;
        }
        const below = bot.blockAt(feet.offset(0, -1, 0));
        if (!below || below.boundingBox !== 'block') {
            // standing on something odd (slab, water, ...), let gravity settle us first
            await sleep(300);
            failures++;
            continue;
        }
        await bot.equip(scaffold, 'hand');
        await bot.look(bot.entity.yaw, -Math.PI / 2, true);
        const y0 = bot.entity.position.y;
        bot.setControlState('jump', true);
        // place near the top of the jump (max ~1.25). the server only knows where we were a tick or so ago,
        // and rejects a block that would still overlap that position
        for (let t = 0; t < 30 && bot.entity.position.y < y0 + 1.18; t++) await sleep(20);
        try {
            await bot.placeBlock(below, new Vec3(0, 1, 0));
        } catch (err) { /* the block often places even when this throws */ }
        bot.setControlState('jump', false);
        for (let t = 0; t < 20 && !bot.entity.onGround; t++) await sleep(50);
        if (Math.floor(bot.entity.position.y + 0.01) > feet.y) failures = 0;
        else failures++;
    }
    const p = bot.entity.position;
    if (Math.hypot(p.x - (column.x + 0.5), p.z - (column.z + 0.5)) > 1.5) {
        log(bot, `Got knocked off the pillar.`);
        return false;
    }
    log(bot, `Pillared up ${Math.floor(p.y) - start_y} blocks to y=${Math.floor(p.y)}.`);
    return true;
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    if (!bot.inventory.slots.find(slot => slot && slot.name === toolName) && !bot.game.gameMode === 'creative') {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

 export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(5);
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView && 
            !blockInView.position.equals(block.position) && 
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    }
    const blockInView = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `Block ${blockInView.name} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(5);
            log(bot, `Block ${blockInView.name} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        await bot.activateItem();
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
 }

// ----------------------------------------------------------------------------------------------
// Beating the game: nether portals, finding the stronghold, the end portal, and the ender dragon
// ----------------------------------------------------------------------------------------------

function getDimension(bot) {
    return (bot.game.dimension || 'overworld').replace('minecraft:', '');
}

function isAirLike(block) {
    return !block || block.boundingBox === 'empty' && !['water', 'lava'].includes(block.name);
}

export async function buildNetherPortal(bot) {
    /**
     * Build and light a nether portal next to you. Needs 10 obsidian, a flint_and_steel, and a few cheap blocks like cobblestone or dirt for the corners.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if a lit portal was built, false otherwise.
     * @example
     * await skills.buildNetherPortal(bot);
     **/
    const cheat = bot.modes.isOn('cheat');
    const counts = world.getInventoryCounts(bot);
    if (!cheat) {
        if ((counts['obsidian'] || 0) < 10) {
            log(bot, `Need 10 obsidian to build a nether portal, you have ${counts['obsidian'] || 0}.`);
            return false;
        }
        if (!counts['flint_and_steel'] && !counts['fire_charge']) {
            log(bot, `Need a flint_and_steel (or fire_charge) to light the portal.`);
            return false;
        }
    }

    // portal frame in local coords (i across, j up). j=0 is the floor row, sunk into the ground.
    const frame = [[1, 0], [2, 0], [0, 1], [0, 2], [0, 3], [3, 1], [3, 2], [3, 3], [1, 4], [2, 4]];
    const corners = [[0, 0], [3, 0], [0, 4], [3, 4]];
    const interior = [[1, 1], [2, 1], [1, 2], [2, 2], [1, 3], [2, 3]];

    // pick the nearby spot that needs the least clearing, with solid ground under the floor row
    const feet = bot.entity.position.floored();
    let best = null;
    for (const axis of ['x', 'z']) {
        for (let dx = -5; dx <= 5; dx++) {
            for (let dz = -5; dz <= 5; dz++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const origin = feet.offset(dx, dy - 1, dz);
                    const at = (i, j) => axis === 'x' ? origin.offset(i, j, 0) : origin.offset(0, j, i);
                    let ok = true;
                    let score = Math.abs(dx) + Math.abs(dz);
                    for (let i = 0; i < 4 && ok; i++) {
                        const ground = bot.blockAt(at(i, 0));
                        const below = bot.blockAt(at(i, -1));
                        if (!ground || !below || below.boundingBox !== 'block') ok = false;
                        for (let j = 1; j <= 4 && ok; j++) {
                            const b = bot.blockAt(at(i, j));
                            if (!b) { ok = false; break; }
                            if (b.name === 'water' || b.name === 'lava') ok = false;
                            else if (!isAirLike(b)) score += 3;
                            if (at(i, j).equals(feet) || at(i, j).equals(feet.offset(0, 1, 0))) ok = false;
                        }
                    }
                    if (ok && (!best || score < best.score)) best = {score, at};
                }
            }
        }
    }
    if (!best) {
        log(bot, `Couldn't find a flat enough spot nearby for a portal. Move somewhere flatter and try again.`);
        return false;
    }
    const at = best.at;
    const base = at(0, 0);
    log(bot, `Building nether portal at ${base}.`);

    if (cheat) {
        for (const [i, j] of frame.concat(corners)) {
            const p = at(i, j);
            bot.chat(`/setblock ${p.x} ${p.y} ${p.z} obsidian`);
        }
        const axis_name = at(1, 0).x !== base.x ? 'x' : 'z';
        for (const [i, j] of interior) {
            const p = at(i, j);
            bot.chat(`/setblock ${p.x} ${p.y} ${p.z} nether_portal[axis=${axis_name}]`);
        }
        log(bot, `Built nether portal with cheats at ${base}.`);
        return true;
    }

    // clear the inside first so nothing blocks lighting it
    for (const [i, j] of interior) {
        const p = at(i, j);
        if (!isAirLike(bot.blockAt(p))) {
            if (!(await breakBlockAt(bot, p.x, p.y, p.z))) {
                log(bot, `Couldn't clear the portal interior at ${p}.`);
                return false;
            }
        }
        if (bot.interrupt_code) return false;
    }

    let placed_obsidian = 0;
    const filler = () => {
        const scaffold = getScaffoldItem(bot);
        if (scaffold) return scaffold.name;
        // spare obsidian works too, as long as enough is left for the frame itself
        return world.getInventoryCounts(bot)['obsidian'] > 10 - placed_obsidian ? 'obsidian' : null;
    };
    const place = async (name, i, j) => {
        const p = at(i, j);
        const existing = bot.blockAt(p);
        if (name === 'obsidian' && existing?.name === 'obsidian') return true;
        if (name !== 'obsidian' && existing && existing.boundingBox === 'block') return true; // corners can be anything solid
        const ok = await placeBlock(bot, name, p.x, p.y, p.z, 'bottom', true);
        if (ok && name === 'obsidian') placed_obsidian++;
        return ok;
    };

    // floor corners support the side pillars, top corners support the lintel
    const order = [
        ['corner', 0, 0], ['corner', 3, 0],
        ['obsidian', 1, 0], ['obsidian', 2, 0],
        ['obsidian', 0, 1], ['obsidian', 0, 2], ['obsidian', 0, 3],
        ['obsidian', 3, 1], ['obsidian', 3, 2], ['obsidian', 3, 3],
        ['corner', 0, 4], ['corner', 3, 4],
        ['obsidian', 1, 4], ['obsidian', 2, 4],
    ];
    for (const [kind, i, j] of order) {
        if (bot.interrupt_code) return false;
        const name = kind === 'corner' ? filler() : 'obsidian';
        if (!name) {
            log(bot, `Need some cheap blocks (cobblestone, dirt...) for the portal corners.`);
            return false;
        }
        if (!(await place(name, i, j))) {
            log(bot, `Failed to place ${name} for the portal frame at ${at(i, j)}.`);
            return false;
        }
    }

    // light it from the inside floor
    const lighter = bot.inventory.items().find(i => i.name === 'flint_and_steel') || bot.inventory.items().find(i => i.name === 'fire_charge');
    const floor_block = bot.blockAt(at(1, 0));
    await goToPosition(bot, floor_block.position.x, floor_block.position.y + 1, floor_block.position.z, 3);
    await bot.equip(lighter, 'hand');
    await bot.lookAt(floor_block.position.offset(0.5, 1, 0.5), true);
    try {
        await bot.activateBlock(floor_block, new Vec3(0, 1, 0));
    } catch (err) { /* checked below */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
    const lit = interior.some(([i, j]) => bot.blockAt(at(i, j))?.name === 'nether_portal');
    if (!lit) {
        log(bot, `Built the frame at ${base} but failed to light it. Try using flint_and_steel on the obsidian floor inside the frame.`);
        return false;
    }
    const inside = at(1, 1);
    log(bot, `Built and lit a nether portal at ${inside.x}, ${inside.y}, ${inside.z}. Remember this location to get home.`);
    return true;
}

async function pourLiquid(bot, bucketName, pos, faceOffsets) {
    /* Pour a water_bucket or lava_bucket into the empty block at pos by clicking the face of a solid neighbour that
       touches it, like a player does. faceOffsets are the neighbours to try (Vec3 from pos), best first. Returns
       true if the liquid is there afterwards. */
    const liquid = bucketName === 'water_bucket' ? 'water' : 'lava';
    const bucket = bot.inventory.items().find(i => i.name === bucketName);
    if (!bucket) return false;
    for (const off of faceOffsets) {
        const neighbour = bot.blockAt(pos.plus(off));
        if (!neighbour || neighbour.boundingBox !== 'block') continue;
        const facePoint = neighbour.position.offset(0.5, 0.5, 0.5).minus(off.scaled(0.5));
        await bot.lookAt(facePoint, true);
        const aimed = bot.blockAtCursor(4.5);
        if (!aimed || !aimed.position.equals(neighbour.position)) {
            // something's in the way of this face
            log(bot, `Can't reach the face of ${neighbour.name} at ${neighbour.position} to pour into ${pos}: aiming at ${aimed ? aimed.name + ' ' + aimed.position : 'nothing in reach'}.`);
            continue;
        }
        await bot.equip(bucket, 'hand');
        await bot.lookAt(facePoint, true);
        bot.activateItem();
        // a source block, not flowing liquid that was already there from an earlier pour
        for (let t = 0; t < 10; t++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            const b = bot.blockAt(pos);
            if (b?.name === liquid && b.metadata === 0) return true;
        }
    }
    return false;
}

async function scoopLiquid(bot, pos) {
    /* Pick the liquid source at pos back up with an empty bucket. Returns true if the bucket filled. */
    const bucket = bot.inventory.items().find(i => i.name === 'bucket');
    if (!bucket) return false;
    const before = bot.inventory.items().filter(i => i.name.endsWith('_bucket') && i.name !== 'bucket').length;
    await bot.equip(bucket, 'hand');
    await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
    bot.activateItem();
    for (let t = 0; t < 10; t++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (bot.inventory.items().filter(i => i.name.endsWith('_bucket') && i.name !== 'bucket').length > before) return true;
    }
    return false;
}

export async function castNetherPortal(bot) {
    /**
     * Build a lit nether portal without diamonds by casting its obsidian frame from lava and water next to a lava pool. Needs a water_bucket, an empty bucket, a flint_and_steel and about 30 cobblestone (or other cheap blocks), with a lava pool nearby (common underground and near diamond level).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if a lit portal was built, false otherwise.
     * @example
     * await skills.castNetherPortal(bot);
     **/
    // obsidian needs a diamond pickaxe to mine, and diamonds are a long way down. speedrunners cast the frame in
    // place instead: pour lava into each frame slot, then water just above it, which turns the lava into obsidian
    if (getDimension(bot) !== 'overworld') {
        log(bot, `Cast the portal in the overworld: water evaporates in the nether.`);
        return false;
    }
    const counts = () => world.getInventoryCounts(bot);
    const scaffoldCount = () => SCAFFOLD_BLOCKS.reduce((n, name) => n + (counts()[name] || 0), 0);
    const missing = [];
    if (!counts()['water_bucket']) missing.push('a water_bucket');
    if (!counts()['bucket'] && !counts()['lava_bucket']) missing.push('an empty bucket (3 iron_ingot) to carry lava');
    if (!counts()['flint_and_steel'] && !counts()['fire_charge']) missing.push('a flint_and_steel (1 iron_ingot, 1 flint)');
    if (scaffoldCount() < 28) missing.push(`about 30 cobblestone or other cheap blocks (you have ${scaffoldCount()})`);
    if (missing.length > 0) {
        log(bot, `To cast a nether portal you still need ${missing.join(', ')}.`);
        return false;
    }
    // each frame block uses up a lava source (it doesn't flow back like water), so make sure there are enough to scoop
    const scoopable = world.getNearestBlocksWhere(bot, b => b.name === 'lava' && b.metadata === 0, 48, 40)
        .filter(b => isAirLike(bot.blockAt(b.position.offset(0, 1, 0))));
    const lavaNear = scoopable[0];
    if (scoopable.length < 12) {
        log(bot, `Need a lava pool with at least 12 lava you can reach from above to cast a portal, found ${scoopable.length}. Lava is common underground, especially near diamond level (y=-54 and below), and in surface pools.`);
        return false;
    }

    // frame layout: i across, j up, k back. j=0 is the ground row, so the top is in reach from the ground. a wall of
    // cheap blocks at k=1 gives every lava and water pour a face to aim at; we stand at k=-2
    const frame = [[1, 0], [2, 0], [0, 1], [0, 2], [0, 3], [3, 1], [3, 2], [3, 3], [1, 4], [2, 4]];
    const interior = [[1, 1], [2, 1], [1, 2], [2, 2], [1, 3], [2, 3]];
    const L = lavaNear.position;
    let best = null;
    for (const axis of ['x', 'z']) {
        const across = axis === 'x' ? new Vec3(1, 0, 0) : new Vec3(0, 0, 1);
        const back = axis === 'x' ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
        for (const flip of [1, -1]) {
            const b = back.scaled(flip);
            for (let dx = -14; dx <= 14; dx++) for (let dz = -14; dz <= 14; dz++) for (let dy = -2; dy <= 2; dy++) {
                const O = L.offset(dx, dy, dz);
                const dist = O.distanceTo(L);
                if (dist < 7 || dist > 14 || (best && dist >= best.score)) continue; // beyond the 7 blocks our water flows, or it turns the pool to obsidian
                const at = (i, j, k) => O.plus(across.scaled(i)).offset(0, j, 0).plus(b.scaled(k));
                let ok = true, score = dist;
                for (let i = 0; i <= 3 && ok; i++) {
                    if (bot.blockAt(at(i, -1, 0))?.boundingBox !== 'block') ok = false; // under the ground row
                    // the wall's bottom row needs something under it to be placed on (or to be there already)
                    if (bot.blockAt(at(i, 0, 1))?.boundingBox !== 'block' && bot.blockAt(at(i, -1, 1))?.boundingBox !== 'block') ok = false;
                    for (let j = (i === 0 || i === 3 ? 1 : 0); j <= 5 && ok; j++) {
                        const block = bot.blockAt(at(i, j, 0));
                        if (!isAirLike(block)) {
                            if (!block.diggable) ok = false;
                            score += 2;
                        }
                    }
                }
                // the space between where we stand and the frame must be open, or it blocks aiming the pours
                for (let i = 0; i <= 3 && ok; i++) for (let j = 1; j <= 5 && ok; j++)
                    if (!isAirLike(bot.blockAt(at(i, j, -1)))) ok = false;
                // somewhere to stand in front, on solid ground
                const stand = at(1, 1, -2);
                if (ok && (bot.blockAt(stand.offset(0, -1, 0))?.boundingBox !== 'block' || !isAirLike(bot.blockAt(stand)) ||
                    !isAirLike(bot.blockAt(stand.offset(0, 1, 0))))) ok = false;
                if (!ok || (best && score >= best.score)) continue;
                // no liquid anywhere near the build (checked last, it's the most lookups)
                for (let i = -1; i <= 4 && ok; i++) for (let j = -1; j <= 6 && ok; j++) for (let k = -2; k <= 2 && ok; k++) {
                    const block = bot.blockAt(at(i, j, k));
                    if (!block || block.name === 'water' || block.name === 'lava') ok = false;
                }
                if (ok) best = {score, at, stand};
            }
        }
    }
    if (!best) {
        log(bot, `Couldn't find a clear, dry spot 7-14 blocks from the lava at ${L} to cast a portal. Try another lava pool.`);
        return false;
    }
    const {at, stand} = best;
    const frameBox = (p) => [...Array(6).keys()].some(i => [...Array(8).keys()].some(j => [0, 1].some(k => at(i - 1, j - 1, k).equals(p))));
    log(bot, `Casting a nether portal at ${at(0, 0, 0)}, using the lava at ${L}.`);
    const goStand = () => goToPosition(bot, stand.x, stand.y, stand.z, 0);
    const scaffold = () => getScaffoldItem(bot)?.name;

    // clear the frame slots and the space above them
    for (let i = 0; i <= 3; i++) for (let j = (i === 0 || i === 3 ? 1 : 0); j <= 5; j++) {
        if (bot.interrupt_code) return false;
        const p = at(i, j, 0);
        if (!isAirLike(bot.blockAt(p)) && !(await breakBlockAt(bot, p.x, p.y, p.z))) {
            log(bot, `Couldn't clear ${p} for the portal.`);
            return false;
        }
    }
    // the backing wall (bottom up, so each block has support), and the floor corners
    for (let j = 0; j <= 5; j++) for (let i = 0; i <= 3; i++) {
        if (bot.interrupt_code) return false;
        const p = at(i, j, 1);
        if (bot.blockAt(p)?.boundingBox !== 'block' && !(await placeBlock(bot, scaffold(), p.x, p.y, p.z, 'bottom', true))) {
            log(bot, `Couldn't place the backing wall at ${p}.`);
            return false;
        }
    }
    for (const i of [0, 3]) {
        const p = at(i, 0, 0);
        if (bot.blockAt(p)?.boundingBox !== 'block' && !(await placeBlock(bot, scaffold(), p.x, p.y, p.z, 'bottom', true))) {
            log(bot, `Couldn't place the portal corner at ${p}.`);
            return false;
        }
    }

    const fillLava = async () => {
        if (counts()['lava_bucket']) return true;
        // lava we can see from above: one walled in by rock can't be scooped up
        const source = world.getNearestBlocksWhere(bot, b => b.name === 'lava' && b.metadata === 0, 48, 20)
            .find(b => !frameBox(b.position) && isAirLike(bot.blockAt(b.position.offset(0, 1, 0))));
        if (!source) return false;
        await useToolOnBlock(bot, 'bucket', source);
        // the bucket fills when the server says so, a moment after using it
        for (let t = 0; t < 10 && !counts()['lava_bucket']; t++) await new Promise(resolve => setTimeout(resolve, 100));
        return !!counts()['lava_bucket'];
    };
    const castAt = async (i, j) => {
        const P = at(i, j, 0), W = at(i, j + 1, 0);
        const toWall = at(i, j, 1).minus(P);
        for (let attempt = 0; attempt < 3; attempt++) {
            if (bot.interrupt_code) return false;
            if (bot.blockAt(P)?.name === 'obsidian') return true;
            // a water source left from an earlier pour keeps flowing into the slots: scoop any up, then let the flowing
            // water drain (a couple of seconds)
            for (let si = 0; si <= 3; si++) for (let sj = 0; sj <= 6; sj++) for (const sk of [0, -1]) {
                const s = bot.blockAt(at(si, sj, sk));
                if (s?.name === 'water' && s.metadata === 0) {
                    await goStand();
                    await scoopLiquid(bot, s.position);
                }
            }
            for (let t = 0; t < 40 && bot.blockAt(P)?.name === 'water'; t++) await new Promise(resolve => setTimeout(resolve, 100));
            if (bot.blockAt(P)?.name === 'water') await scoopLiquid(bot, P);
            // lava already in the slot from an attempt whose water didn't land just needs the water
            if (bot.blockAt(P)?.name !== 'lava') {
                if (!isAirLike(bot.blockAt(P)) && !(await breakBlockAt(bot, P.x, P.y, P.z))) return false; // cobblestone from a bad pour
                if (!(await fillLava())) {
                    log(bot, `Couldn't fill a bucket with lava.`);
                    return false;
                }
                await goStand();
                if (!(await pourLiquid(bot, 'lava_bucket', P, [toWall, new Vec3(0, -1, 0)]))) continue;
            }
            else {
                await goStand();
            }
            // water just above the lava source turns it into obsidian
            if (!(await pourLiquid(bot, 'water_bucket', W, [toWall]))) continue;
            await new Promise(resolve => setTimeout(resolve, 300)); // enough to turn the lava, short enough that the water barely spreads
            await scoopLiquid(bot, W);
            await new Promise(resolve => setTimeout(resolve, 400));
        }
        return bot.blockAt(P)?.name === 'obsidian';
    };
    for (const [i, j] of frame) {
        if (i !== 0 && i !== 3 && j === 4) {
            // the top corners hold up nothing, but go in before the lintel so its water has somewhere to stop
            for (const ci of [0, 3]) {
                const p = at(ci, 4, 0);
                if (bot.blockAt(p)?.boundingBox !== 'block') await placeBlock(bot, scaffold(), p.x, p.y, p.z, 'bottom', true);
            }
        }
        if (!(await castAt(i, j))) {
            log(bot, `Couldn't cast obsidian at ${at(i, j, 0)}.`);
            return false;
        }
    }
    // anything the water left behind inside (cobblestone from flowing lava) blocks the portal
    await new Promise(resolve => setTimeout(resolve, 2000));
    for (const [i, j] of interior) {
        const p = at(i, j, 0);
        if (!isAirLike(bot.blockAt(p)) && bot.blockAt(p).name !== 'water') await breakBlockAt(bot, p.x, p.y, p.z);
    }

    // light it from the inside floor
    const lighter = bot.inventory.items().find(i => i.name === 'flint_and_steel') || bot.inventory.items().find(i => i.name === 'fire_charge');
    const floor = bot.blockAt(at(1, 0, 0));
    await goStand();
    await bot.equip(lighter, 'hand');
    await bot.lookAt(floor.position.offset(0.5, 1, 0.5), true);
    try {
        await bot.activateBlock(floor, new Vec3(0, 1, 0));
    } catch (err) { /* checked below */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!interior.some(([i, j]) => bot.blockAt(at(i, j, 0))?.name === 'nether_portal')) {
        log(bot, `Cast the frame at ${at(0, 0, 0)} but couldn't light it. Use flint_and_steel on the obsidian floor inside it.`);
        return false;
    }
    const inside = at(1, 1, 0);
    log(bot, `Cast and lit a nether portal at ${inside.x}, ${inside.y}, ${inside.z}. Remember this location to get home.`);
    return true;
}

export async function enterPortal(bot, portalType='nether_portal') {
    /**
     * Walk into the nearest portal and wait to be teleported. Works for 'nether_portal' and 'end_portal'.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} portalType, 'nether_portal' or 'end_portal'. Defaults to 'nether_portal'.
     * @returns {Promise<boolean>} true if the bot changed dimension, false otherwise.
     * @example
     * await skills.enterPortal(bot, 'nether_portal');
     **/
    const portal = world.getNearestBlock(bot, portalType, 64);
    if (!portal) {
        log(bot, `Could not find any ${portalType} nearby.`);
        return false;
    }
    const start_dim = getDimension(bot);
    let p = portal.position;
    // stand in the bottom portal block of the column, the upper ones are in mid air
    while (bot.blockAt(p.offset(0, -1, 0))?.name === portalType) p = p.offset(0, -1, 0);
    log(bot, `Entering ${portalType} at ${p} from the ${start_dim}.`);

    bot.modes.pause('unstuck');
    bot.modes.pause('elbow_room');
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const inPortal = () => [0, 1].some(dy => bot.blockAt(bot.entity.position.offset(0, dy, 0))?.name === portalType);
    for (let attempt = 0; attempt < 3; attempt++) {
        if (bot.interrupt_code) return false;
        if (inPortal() || attempt > 0) {
            // standing in the portal you just came out of keeps it on cooldown: step out, wait, then go back in
            try {
                await moveAway(bot, 3);
            } catch (err) { /* try from here */ }
            await sleep(attempt === 0 ? 1500 : 5000);
        }
        try {
            const movements = makeMovements(bot, {destructive: false});
            movements.blocksToAvoid.delete(mc.getBlockId(portalType));
            bot.pathfinder.setMovements(movements);
            await gotoWithWatchdog(bot, new pf.goals.GoalBlock(p.x, p.y, p.z), 15000);
        } catch (err) {
            // the pathfinder can be shy about portal blocks, so walk the last bit by hand
            await goToPosition(bot, p.x, p.y, p.z, 1);
            await bot.lookAt(p.offset(0.5, 0.5, 0.5));
            bot.setControlState('forward', true);
            await sleep(600);
            bot.setControlState('forward', false);
        }

        // nether portals take ~4 seconds of standing still in survival
        const start = Date.now();
        while (Date.now() - start < 8000) {
            if (bot.interrupt_code) return false;
            if (getDimension(bot) !== start_dim) {
                await sleep(2000); // let chunks load
                try { await bot.waitForChunksToLoad(); } catch (err) { /* go anyway */ }
                const pos = bot.entity.position.floored();
                log(bot, `Went through the portal, now in the ${getDimension(bot)} at ${pos.x}, ${pos.y}, ${pos.z}.`);
                return true;
            }
            await sleep(250);
        }
    }
    log(bot, `Stood in the portal but nothing happened.`);
    return false;
}

async function waitForEyeOfEnder(bot, timeout=2000) {
    return await new Promise(resolve => {
        const onSpawn = (entity) => {
            if (entity.name === 'eye_of_ender' && entity.position.distanceTo(bot.entity.position) < 4) {
                cleanup();
                resolve(entity);
            }
        };
        const timer = setTimeout(() => { cleanup(); resolve(null); }, timeout);
        const cleanup = () => {
            clearTimeout(timer);
            bot.removeListener('entitySpawn', onSpawn);
        };
        bot.on('entitySpawn', onSpawn);
    });
}

export async function throwEnderEye(bot) {
    /**
     * Throw an eye of ender to see which way the stronghold is, then try to pick the eye back up.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<Object|null>} {origin, direction, close} where direction is a horizontal unit vector towards the stronghold and close is true when the stronghold is right around here. null if the throw failed.
     * @example
     * let result = await skills.throwEnderEye(bot);
     **/
    if (getDimension(bot) !== 'overworld') {
        log(bot, `Eyes of ender only point to strongholds in the overworld.`);
        return null;
    }
    const eye_item = bot.inventory.items().find(i => i.name === 'ender_eye');
    if (!eye_item) {
        log(bot, `You have no ender_eye to throw.`);
        return null;
    }
    stopPathfinding(bot);
    await bot.equip(eye_item, 'hand');
    // look up at the sky so we don't accidentally use the eye on a block
    await bot.look(bot.entity.yaw, Math.PI / 4, true);
    const origin = bot.entity.position.clone();
    const spawned = waitForEyeOfEnder(bot);
    bot.activateItem();
    const eye = await spawned;
    if (!eye) {
        log(bot, `Threw the eye but couldn't see it fly.`);
        return null;
    }
    const start = eye.position.clone();
    let lowest_dy = 0;
    for (let t = 0; t < 30 && isAlive(bot, eye); t++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        lowest_dy = Math.min(lowest_dy, eye.position.y - start.y);
    }
    const end = eye.position.clone();
    const dx = end.x - start.x, dz = end.z - start.z;
    const len = Math.hypot(dx, dz);
    // the eye floats down to the stronghold instead of up and away when it is within ~12 blocks
    const close = len < 3 || lowest_dy < -0.5;
    // it hovers for a few seconds, then drops as an item (or shatters). go grab it back
    let last_pos = eye.position.clone();
    for (let t = 0; t < 60 && isAlive(bot, eye); t++) {
        last_pos = eye.position.clone();
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    const dropped = world.getNearestEntityWhere(bot, e => e.name === 'item' && e.position.distanceTo(last_pos) < 4, 32);
    if (dropped) {
        try {
            await goToGoal(bot, new pf.goals.GoalFollow(dropped, 0.5));
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (err) { /* lost it */ }
    }
    else {
        log(bot, `The eye of ender shattered.`);
    }
    if (len < 0.5) {
        log(bot, `The eye of ender went straight down: the stronghold is right below you.`);
        return {origin, direction: null, close: true};
    }
    const direction = new Vec3(dx / len, 0, dz / len);
    const heading = Math.round(Math.atan2(direction.z, direction.x) * 180 / Math.PI);
    log(bot, `The eye of ender flew towards direction (${direction.x.toFixed(2)}, ${direction.z.toFixed(2)})${close ? ' and dropped: the stronghold is very close' : ''}. heading ${heading} degrees.`);
    return {origin, direction, close};
}

// bearings from every eye throw this session, so each new throw sharpens the estimate
const _strongholdRays = [];

function intersectRays(rays) {
    /* Least-squares point closest to all bearing lines. Returns null if they're too close to parallel. */
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
    for (const {origin, direction: d} of rays) {
        // projector onto the line's normal: I - d d^T
        const n11 = 1 - d.x * d.x, n12 = -d.x * d.z, n22 = 1 - d.z * d.z;
        a11 += n11; a12 += n12; a22 += n22;
        b1 += n11 * origin.x + n12 * origin.z;
        b2 += n12 * origin.x + n22 * origin.z;
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-4 * rays.length) return null;
    const x = (a22 * b1 - a12 * b2) / det;
    const z = (a11 * b2 - a12 * b1) / det;
    // must be in front of the throws, not behind them
    for (const {origin, direction: d} of rays) {
        if ((x - origin.x) * d.x + (z - origin.z) * d.z < 0) return null;
    }
    return new Vec3(Math.round(x), 0, Math.round(z));
}

async function recordEyeThrow(bot) {
    const result = await throwEnderEye(bot);
    if (result?.direction && !result.close) _strongholdRays.push({origin: result.origin, direction: result.direction});
    return result;
}

function findPortalFrame(bot) {
    // the server sends whole chunks, underground included, so the portal room is often visible from far away
    return world.getNearestBlock(bot, 'end_portal_frame', 192);
}

export async function locateStronghold(bot) {
    /**
     * Estimate the stronghold's location by throwing eyes of ender from different spots and intersecting their bearings. Each throw this session improves the estimate. Needs ender_eye (they are usually picked back up).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<Vec3|null>} estimated stronghold x, z position (y is 0), or null if it failed.
     * @example
     * let stronghold = await skills.locateStronghold(bot);
     **/
    const here = () => {
        const p = bot.entity.position.floored();
        log(bot, `The stronghold is right around ${p.x}, ${p.z}. Dig down to find it.`);
        return new Vec3(p.x, 0, p.z);
    };
    const first = await recordEyeThrow(bot);
    if (!first) return null;
    if (first.close || !first.direction) return here();

    let estimate = intersectRays(_strongholdRays);
    if (!estimate || _strongholdRays.length < 2) {
        // need a second bearing from somewhere off to the side, the wider the baseline the better
        const d1 = first.direction;
        const side = new Vec3(-d1.z, 0, d1.x);
        const target = first.origin.plus(side.scaled(100));
        await travelTo(bot, target.x, target.z, 8);
        if (bot.interrupt_code) return null;
        const second = await recordEyeThrow(bot);
        if (!second) return null;
        if (second.close || !second.direction) return here();
        estimate = intersectRays(_strongholdRays);
    }
    if (!estimate) {
        // nearly parallel bearings mean it's far away; strongholds are usually 1300-2800 blocks from spawn
        const last = _strongholdRays[_strongholdRays.length - 1];
        estimate = last.origin.plus(last.direction.scaled(1000)).floored();
        estimate.y = 0;
        log(bot, `The eyes all point the same way, so the stronghold is far. Heading roughly 1000 blocks that way.`);
    }
    const dist = Math.round(Math.hypot(estimate.x - bot.entity.position.x, estimate.z - bot.entity.position.z));
    log(bot, `Estimated stronghold location from ${_strongholdRays.length} throws: x=${estimate.x}, z=${estimate.z} (${dist} blocks away).`);
    return estimate;
}

async function digTowards(bot, target) {
    /* Get down to a block far below: path there directly, falling back to digging down in steps. */
    for (let attempt = 0; attempt < 6; attempt++) {
        if (bot.interrupt_code) return false;
        const reached = await goToPosition(bot, target.x, target.y + 1, target.z, 3);
        if (reached) return true;
        const dy = bot.entity.position.y - (target.y + 1);
        const horizontal = Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z);
        if (dy > 2 && horizontal < 24) {
            const dug = await digDown(bot, Math.min(10, Math.ceil(dy)));
            if (!dug) await moveAway(bot, 4); // lava or a drop below, try another hole
        }
        else if (horizontal >= 24) {
            await travelTo(bot, target.x, target.z, 8);
        }
    }
    return false;
}

export async function goToStronghold(bot) {
    /**
     * Find the stronghold with eyes of ender, travel there, and get down to the end portal room. Needs several ender_eye (12 are needed to open the portal).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the end portal frame was found and reached, false otherwise.
     * @example
     * await skills.goToStronghold(bot);
     **/
    let frame = findPortalFrame(bot);
    for (let round = 0; round < 6 && !frame; round++) {
        if (bot.interrupt_code) return false;
        const estimate = await locateStronghold(bot);
        if (!estimate) return false;
        frame = findPortalFrame(bot);
        if (frame) break;
        const pos = bot.entity.position;
        const dist = Math.hypot(estimate.x - pos.x, estimate.z - pos.z);
        if (dist < 24) {
            // the eyes lead to the stronghold's entrance, the portal room can be ~100 blocks away inside it.
            // dig down into the stronghold, where more of it comes into view
            await digDown(bot, Math.max(4, Math.floor(pos.y) - 30));
            frame = findPortalFrame(bot);
            if (!frame) {
                const bricks = world.getNearestBlock(bot, 'stone_bricks', 48);
                if (bricks) await goToPosition(bot, bricks.position.x, bricks.position.y + 1, bricks.position.z, 2);
                frame = findPortalFrame(bot);
            }
            if (!frame) await explore(bot, 60);
            continue;
        }
        // stop partway on long trips and throw again, every throw makes the estimate better
        const leg = Math.min(dist, 400);
        await travelTo(bot, pos.x + (estimate.x - pos.x) * leg / dist, pos.z + (estimate.z - pos.z) * leg / dist, 16);
        frame = findPortalFrame(bot);
    }
    if (bot.interrupt_code) return false;
    if (!frame) {
        log(bot, `Couldn't find the end portal room. Throw more eyes of ender (locateStronghold) to narrow it down.`);
        return false;
    }
    log(bot, `Found the end portal frame at ${frame.position}! Heading there.`);
    if (await digTowards(bot, frame.position)) {
        log(bot, `Reached the end portal. Use activateEndPortal to fill it with eyes of ender.`);
        return true;
    }
    log(bot, `Found the portal at ${frame.position} but couldn't get to it.`);
    return false;
}

export async function activateEndPortal(bot) {
    /**
     * Place eyes of ender into all the empty end portal frames nearby to open the end portal.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the end portal is open, false otherwise.
     * @example
     * await skills.activateEndPortal(bot);
     **/
    const frames = world.getNearestBlocks(bot, ['end_portal_frame'], 24, 12);
    if (frames.length === 0) {
        log(bot, `No end portal frames nearby.`);
        return false;
    }
    if (world.getNearestBlock(bot, 'end_portal', 24)) {
        log(bot, `The end portal is already open.`);
        return true;
    }
    const empty = frames.filter(f => !f.getProperties().eye);
    const eyes = world.getInventoryCounts(bot)['ender_eye'] || 0;
    log(bot, `${frames.length} frames found, ${empty.length} need an eye. You have ${eyes} ender_eye.`);
    if (eyes < empty.length) {
        log(bot, `Not enough eyes of ender, need ${empty.length - eyes} more.`);
        return false;
    }
    for (const frame of empty) {
        if (bot.interrupt_code) return false;
        const p = frame.position;
        // stand outside the ring so we don't fall into the portal when it opens
        if (bot.entity.position.distanceTo(p) > 4) {
            await goToPosition(bot, p.x, p.y + 1, p.z, 3);
        }
        const eye = bot.inventory.items().find(i => i.name === 'ender_eye');
        if (!eye) break;
        await bot.equip(eye, 'hand');
        await bot.lookAt(p.offset(0.5, 1, 0.5), true);
        try {
            await bot.activateBlock(bot.blockAt(p), new Vec3(0, 1, 0));
        } catch (err) { /* checked below */ }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    if (world.getNearestBlock(bot, 'end_portal', 24)) {
        log(bot, `The end portal is open! Prepare (bow, arrows, blocks, food, armor) then use enterPortal with 'end_portal'.`);
        return true;
    }
    const still_empty = world.getNearestBlocks(bot, ['end_portal_frame'], 24, 12).filter(f => !f.getProperties().eye).length;
    log(bot, `Portal not open yet, ${still_empty} frames still need an eye.`);
    return false;
}

function getEntityHealth(entity) {
    // living entity health is metadata index 9 in modern versions
    const h = entity?.metadata?.[9];
    return typeof h === 'number' ? h : null;
}

// the dragon's hitbox is split into parts with their own entity ids. only the head takes full damage
const DRAGON_HEAD = 1, DRAGON_BODY = 3;
// what the dragon is doing, from its metadata. while sitting it can't be hurt by arrows, only by hitting it
const DRAGON_PHASE = {HOLDING_PATTERN: 0, STRAFE_PLAYER: 1, LANDING_APPROACH: 2, LANDING: 3, TAKEOFF: 4, SITTING_FLAMING: 5,
    SITTING_SCANNING: 6, SITTING_ATTACKING: 7, CHARGING_PLAYER: 8, DYING: 9, HOVERING: 10};
const SITTING_PHASES = [DRAGON_PHASE.SITTING_FLAMING, DRAGON_PHASE.SITTING_SCANNING, DRAGON_PHASE.SITTING_ATTACKING];

function dragonPhase(dragon) {
    const phase = dragon?.metadata?.[16];
    return typeof phase === 'number' && phase >= 0 && phase <= 10 ? phase : null;
}

function dragonPerching(bot) {
    /* Is the dragon perched on the portal, or on its way down to it? */
    const phase = dragonPhase(Object.values(bot.entities).find(e => e.name === 'ender_dragon'));
    return phase !== null && (SITTING_PHASES.includes(phase) || phase === DRAGON_PHASE.LANDING || phase === DRAGON_PHASE.LANDING_APPROACH);
}

function dragonPartPositions(dragon, flip=false, perched=false) {
    /* Estimate the centers of the head and body parts, using the same offsets the server uses.
       mineflayer stores yaw as PI - notchian yaw (radians). flip mirrors the estimate in case
       the yaw we see is the other way round from the server's. While perched, the 1x1 head hangs
       a block below the dragon's position; in flight it's level with it. */
    let yaw = Math.PI - dragon.yaw;
    if (flip) yaw += Math.PI;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const p = dragon.position;
    return {
        head: p.offset(sin * 6.5, perched ? -0.5 : 0.5, -cos * 6.5),
        neck: p.offset(sin * 5.5, perched ? 0.5 : 1.5, -cos * 5.5),
        body: p.offset(sin * 0.5, 1.5, -cos * 0.5),
        // wing centers. even while it sits, anything near a wing gets shoved hard every tick
        wings: [p.offset(cos * 4.5, 3, sin * 4.5), p.offset(-cos * 4.5, 3, -sin * 4.5)],
    };
}

function findExitPortalTop(bot) {
    // the bedrock fountain in the middle of the main island marks where the dragon perches
    for (let y = 100; y > 40; y--) {
        const b = bot.blockAt(new Vec3(0, y, 0));
        if (b && b.name === 'bedrock') return y;
    }
    return null;
}

function getPillarInfo(bot, crystal) {
    /* The crystal sits on a bedrock block on top of an obsidian pillar, sometimes inside an iron bar cage. */
    const cx = Math.floor(crystal.position.x), cz = Math.floor(crystal.position.z);
    const cy = Math.floor(crystal.position.y);
    let top = cy - 1; // y of the bedrock block
    for (let y = cy; y > cy - 4; y--) {
        if (bot.blockAt(new Vec3(cx, y, cz))?.name === 'bedrock') { top = y; break; }
    }
    let radius = 1;
    for (let r = 1; r <= 8; r++) {
        if (bot.blockAt(new Vec3(cx + r, top - 1, cz))?.name === 'obsidian') radius = r;
        else break;
    }
    const bars = [];
    for (let dx = -3; dx <= 3; dx++)
        for (let dz = -3; dz <= 3; dz++)
            for (let dy = 0; dy <= 4; dy++) {
                const b = bot.blockAt(new Vec3(cx + dx, top + dy, cz + dz));
                if (b?.name === 'iron_bars') bars.push(b);
            }
    return {center: new Vec3(cx + 0.5, top, cz + 0.5), top, radius, bars};
}

function groundAt(bot, x, z, below_y) {
    // y to stand at for column x,z (first solid block with 2 air above), searching down from below_y
    for (let y = Math.floor(below_y); y > 0; y--) {
        const b = bot.blockAt(new Vec3(Math.floor(x), y, Math.floor(z)));
        if (!b || b.boundingBox !== 'block' || b.name === 'bedrock') continue;
        const a1 = bot.blockAt(new Vec3(Math.floor(x), y + 1, Math.floor(z)));
        const a2 = bot.blockAt(new Vec3(Math.floor(x), y + 2, Math.floor(z)));
        if (isAirLike(a1) && isAirLike(a2)) return y + 1;
    }
    return null;
}

function cellKey(x, y, z) {
    // one number per block, for fast lookups (good for a few thousand blocks in every direction)
    return ((x + 8192) * 1024 + (y + 256)) * 16384 + (z + 8192);
}

function solidCells(bot) {
    /* Cached "would this block stop an arrow" lookups, for tracing many shots at once. */
    const cache = new Map();
    return (x, y, z) => {
        const key = cellKey(x, y, z);
        let solid = cache.get(key);
        if (solid === undefined) {
            const b = bot.blockAt(new Vec3(x, y, z));
            solid = !!b && (b.boundingBox === 'block' || b.name === 'iron_bars' || b.name.endsWith('_pane'));
            cache.set(key, solid);
        }
        return solid;
    };
}

function crystalShotClear(info, crystal, stand, high, solid=null) {
    /* Trace the arrow from a standing spot to the crystal and check it doesn't clip the pillar's
       top edge, the cage bars, or anything else solid on the way (like what's left of our own tower). */
    const eye = new Vec3(stand.x, stand.y + 1.52, stand.z);
    const target = crystal.position.offset(0, 1, 0);
    const dist = Math.hypot(target.x - eye.x, target.z - eye.z);
    const sol = solveArrowPitch(dist, target.y - eye.y, high);
    if (!sol) return false;
    const dir_x = (target.x - eye.x) / dist, dir_z = (target.z - eye.z) / dist;
    // the arrow isn't a point: keep its half width (plus a little spread) clear of the pillar and the bars
    const margin = 0.3;
    const edge = info.radius + 0.5 + margin;
    const bar_cells = new Set(info.bars.map(b => cellKey(b.position.x, b.position.y, b.position.z)));
    const blocked = (x, y, z) => bar_cells.has(cellKey(x, y, z)) || (solid !== null && solid(x, y, z));
    // (the arrow only moves a fifth of a block per sub-step, so skip cells we've just checked)
    let prev = [];
    const hits = (px, py, pz) => {
        const cells = [Math.floor(px - margin), Math.floor(px + margin), Math.floor(py - margin), Math.floor(py + margin),
            Math.floor(pz - margin), Math.floor(pz + margin)];
        if (cells.every((c, i) => c === prev[i])) return false;
        prev = cells;
        const [x0, x1, y0, y1, z0, z1] = cells;
        for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1])
            if (blocked(x, y, z)) return true;
        return false;
    };
    const c = crystal.position;
    for (const {h, y} of arrowPath(sol.pitch, dist + 1.5)) {
        const px = eye.x + dir_x * h, pz = eye.z + dir_z * h, py = eye.y + y;
        // reached the middle of the crystal's 2x2x2 hitbox
        if (Math.abs(px - c.x) < 0.8 && Math.abs(pz - c.z) < 0.8 && py >= c.y + 0.2 && py <= c.y + 1.8) return true;
        if (Math.hypot(px - info.center.x, pz - info.center.z) < edge && py < info.top + 0.1 + margin) return false;
        // (skip the first stretch, the shooter's own block space)
        if (h > 1 && hits(px, py, pz)) return false;
    }
    return false;
}

async function planCrystalShot(bot, crystal, info, angles=null, avoid=[]) {
    /* Find somewhere on the island to stand where an arrow (flat or lobbed) can reach the crystal,
       away from any spots in avoid (where shooting didn't work). That means tracing a lot of arcs, so give the
       event loop a turn every so often: the bot has to keep moving and dodging while we think. */
    const to_center = Math.atan2(-info.center.z, -info.center.x); // pillars ring the island, aim back inward
    const base_angles = angles ?? [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05].map(a => to_center + a);
    const here = bot.entity.position;
    const hazards = dragonHazards(bot);
    // every spot and arc, cheapest first: a flat shot costs the walk there, a lob a bit more
    const candidates = [];
    for (const angle of base_angles) {
        for (let dist = 14; dist <= 70; dist += 4) {
            const x = info.center.x + Math.cos(angle) * dist;
            const z = info.center.z + Math.sin(angle) * dist;
            if (avoid.some(a => Math.hypot(a.x - x, a.z - z) < 8)) continue;
            if (hazards.inBreath(x, z, 3)) continue; // the clouds grow, and we'll stand there a while
            const walk = Math.hypot(x - here.x, z - here.z);
            candidates.push({x, z, high: false, cost: walk}, {x, z, high: true, cost: walk + 10});
        }
    }
    candidates.sort((a, b) => a.cost - b.cost);
    const solid = solidCells(bot);
    const ground = new Map();
    let slice_start = Date.now();
    for (const c of candidates) {
        if (Date.now() - slice_start > 20) {
            await new Promise(resolve => setTimeout(resolve, 0));
            slice_start = Date.now();
        }
        const key = `${c.x},${c.z}`;
        if (!ground.has(key)) ground.set(key, groundAt(bot, c.x, c.z, info.top - 2));
        const y = ground.get(key);
        if (y === null || y < 40) continue; // no island here
        if (crystalShotClear(info, crystal, {x: c.x, y, z: c.z}, c.high, solid)) return {x: c.x, y, z: c.z, high: c.high, cost: c.cost};
    }
    return null;
}

async function shootCrystal(bot, crystal, angles=null) {
    /* A few arrows from one spot; if they don't get through, try from somewhere else. Returns 'later' if we had to
       stop for the dragon (to dodge, or because it's coming down to perch). */
    const interrupted = () => {
        const h = dragonHazards(bot);
        return !!(h.incoming || h.inCloud) || dragonPerching(bot);
    };
    const tried = [];
    for (let attempt = 0; attempt < 3; attempt++) {
        const info = getPillarInfo(bot, crystal);
        const plan = await planCrystalShot(bot, crystal, info, angles, tried);
        if (!plan) {
            // its breath may be lying where we'd stand. it clears up in a while
            if (attempt === 0 && dragonHazards(bot).clouds.length > 0) return 'later';
            if (attempt === 0) log(bot, `Couldn't find a spot with a clear shot at the crystal at ${crystal.position.floored()}.`);
            break;
        }
        tried.push(plan);
        if (await walkDodging(bot, new pf.goals.GoalNear(plan.x, plan.y, plan.z, 1.5), () => dragonPerching(bot)) === 'later') return 'later';
        // (if we didn't get all the way there, try from wherever we got to)
        if (bot.interrupt_code || !isAlive(bot, crystal)) break;
        // re-check the arc from where we actually ended up
        const here = bot.entity.position;
        const high = crystalShotClear(info, crystal, here, false, solidCells(bot)) ? false : plan.high;
        if (await shootAt(bot, crystal, 3, high, interrupted)) return true;
        // stopped for the dragon: not this spot's fault
        if (interrupted() && isAlive(bot, crystal)) return 'later';
    }
    return !isAlive(bot, crystal);
}

async function guardRails(bot, gap_angle=null) {
    /* Box ourselves in on top of a 1x1 tower: a block on each side of our feet and one over our head. The
       dragon's wings shove anything near them sideways and upwards every tick they touch it, which lifts you
       right over a waist-high rail, so it takes the roof too. Rails go on support blocks placed against the side
       of the tower; the roof goes on a little column off to one side (across from gap_angle, so it's out of the
       way of shots through the gap). Returns where we put blocks, so they can be taken away again. */
    const feet = bot.entity.position.floored();
    const placed = [];
    const scaffold = () => getScaffoldItem(bot);
    const place = async (against, face, at) => {
        if (bot.interrupt_code || !scaffold()) return false;
        if (bot.blockAt(at)?.boundingBox === 'block') return true;
        try {
            await bot.equip(scaffold(), 'hand');
            await bot.placeBlock(bot.blockAt(against), face);
        } catch (err) { /* it often places anyway */ }
        if (bot.blockAt(at)?.boundingBox !== 'block') return false;
        placed.push(at);
        return true;
    };
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of sides) {
        const rail = feet.offset(dx, 0, dz), support = feet.offset(dx, -1, dz);
        if (bot.blockAt(rail)?.boundingBox === 'block') continue;
        if (bot.blockAt(support)?.boundingBox !== 'block' && !(await place(feet.offset(0, -1, 0), new Vec3(dx, 0, dz), support))) continue;
        await place(support, new Vec3(0, 1, 0), rail);
    }
    // the roof: two blocks up off a rail across from the gap, then one across over our head
    const across = gap_angle === null ? sides : [...sides].sort((a, b) =>
        Math.abs(a[0] * Math.cos(gap_angle) + a[1] * Math.sin(gap_angle)) - Math.abs(b[0] * Math.cos(gap_angle) + b[1] * Math.sin(gap_angle)));
    for (const [dx, dz] of across) {
        const rail = feet.offset(dx, 0, dz);
        if (bot.blockAt(rail)?.boundingBox !== 'block') continue;
        if (!(await place(rail, new Vec3(0, 1, 0), rail.offset(0, 1, 0)))) continue;
        if (!(await place(rail.offset(0, 1, 0), new Vec3(0, 1, 0), rail.offset(0, 2, 0)))) continue;
        if (await place(rail.offset(0, 2, 0), new Vec3(-dx, 0, -dz), feet.offset(0, 2, 0))) break;
    }
    return placed;
}

async function openCrystalCage(bot, crystal) {
    /* Tower up beside the pillar, break a window in the iron bars facing the island, then dig back down.
       Returns the direction (angle) of the opening so we can shoot through it from the ground, null if it can't
       be done, or 'later' if the dragon is about and we should come back to it.
       Up there we can't dodge anything and the fall is deadly, so only go up healthy and while the dragon is
       circling far away, eat a golden apple first for the extra hearts, break as few bars as will do, and come
       back down as soon as the dragon turns towards us or we get hurt. */
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const info = getPillarInfo(bot, crystal);
    if (info.bars.length === 0) return null;
    if (!getScaffoldItem(bot)) {
        log(bot, `Need blocks (cobblestone, end_stone...) to tower up to the caged crystal.`);
        return null;
    }
    if (bot.health < 16) {
        // top up and let health regenerate before going up
        const food = bot.inventory.items().find(i => ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'bread', 'baked_potato', 'cooked_chicken', 'golden_carrot'].includes(i.name));
        if (food && bot.food < 20) await consume(bot, food.name);
        for (let t = 0; t < 30 && bot.health < 16 && !bot.interrupt_code; t++) await sleep(500);
        if (bot.health < 14) {
            log(bot, `Too hurt (${Math.round(bot.health)}/20) to tower up to the caged crystal.`);
            return null;
        }
    }
    const angle = Math.atan2(-info.center.z, -info.center.x); // the island side of the pillar
    const bx = info.center.x + Math.cos(angle) * (info.radius + 1.2);
    const bz = info.center.z + Math.sin(angle) * (info.radius + 1.2);
    const by = groundAt(bot, bx, bz, info.top - 2);
    if (by === null) {
        log(bot, `No ground next to the pillar to build up from.`);
        return null;
    }
    const foot = new pf.goals.GoalNear(Math.floor(bx) + 0.5, by, Math.floor(bz) + 0.5, 1);
    const reached = await walkDodging(bot, foot, () => dragonPerching(bot));
    if (reached === 'later' || bot.interrupt_code) return 'later';
    if (!reached) {
        log(bot, `Couldn't get to the foot of the pillar with the crystal at ${crystal.position.floored()}.`);
        return null;
    }
    const dragon = () => Object.values(bot.entities).find(e => e.name === 'ender_dragon');
    // only climb while it circles far off: when it perches it charges anyone who isn't close by, and when it
    // strafes it comes at us with a fireball
    const dragonAway = () => {
        const d = dragon();
        if (!d) return true;
        const phase = dragonPhase(d);
        if (phase !== null && ![DRAGON_PHASE.HOLDING_PATTERN, DRAGON_PHASE.TAKEOFF, DRAGON_PHASE.HOVERING].includes(phase)) return false;
        return Math.hypot(d.position.x - info.center.x, d.position.z - info.center.z) > 40;
    };
    // up there, give up as soon as it turns towards us
    const comingForUs = () => {
        const d = dragon();
        if (!d) return false;
        const dist = d.position.distanceTo(bot.entity.position);
        if (dist < 20 || dragonHazards(bot).incoming) return true;
        const phase = dragonPhase(d);
        return phase !== null && ![DRAGON_PHASE.HOLDING_PATTERN, DRAGON_PHASE.TAKEOFF, DRAGON_PHASE.HOVERING].includes(phase);
    };
    for (let t = 0; t < 40 && !dragonAway(); t++) {
        if (bot.interrupt_code || dragonPerching(bot)) return 'later';
        const hazards = dragonHazards(bot);
        if (hazards.incoming || hazards.inCloud) return 'later';
        await sleep(500);
    }
    if (!dragonAway()) return 'later';
    log(bot, `Crystal at ${crystal.position.floored()} is caged. Towering up to break the bars.`);
    // the extra hearts last a couple of minutes, don't eat another for every try
    const apple = bot.inventory.items().find(i => i.name === 'enchanted_golden_apple' || i.name === 'golden_apple');
    if (apple && Date.now() - (bot._climb_apple_time ?? 0) > 90000 && await consume(bot, apple.name))
        bot._climb_apple_time = Date.now();
    const start_y = Math.floor(bot.entity.position.y);
    const start = bot.entity.position.clone();
    const knockedOff = () => Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z) > 1.5;
    let rails = [];
    // the roof, and anything left floating in line with the gap, would be in the way of our shots through it
    const inTheWay = (p) => {
        const dx = p.x - Math.floor(start.x), dz = p.z - Math.floor(start.z);
        return (dx === 0 && dz === 0) || Math.abs(dx * Math.cos(angle) + dz * Math.sin(angle)) >= 0.3;
    };
    const climbDown = async (why) => {
        if (why) log(bot, why);
        for (const p of [...rails].reverse().filter(inTheWay)) {
            if (bot.interrupt_code) break;
            if (bot.blockAt(p)?.boundingBox === 'block') await breakBlockAt(bot, p.x, p.y, p.z);
        }
        const y = Math.floor(bot.entity.position.y);
        if (y > start_y) {
            await centerOnBlock(bot);
            await digDown(bot, y - start_y);
        }
    };
    // feet level with the crystal's base puts our eyes level with the bars
    if (!(await towerUp(bot, info.top + 1 - start_y, comingForUs))) {
        // the dragon got in the way: try again when it's gone. otherwise (no headroom, out of blocks) give up
        const later = comingForUs() || knockedOff();
        await climbDown(comingForUs() ? `The dragon is coming, climbing back down.` : null);
        return later ? 'later' : null;
    }
    rails = await guardRails(bot, angle);

    // the bars on the side facing us, level with the crystal; the middle ones first, that's where we shoot through
    const dir = {x: Math.cos(angle), z: Math.sin(angle)};
    const facing = (b) => {
        const dx = b.position.x + 0.5 - info.center.x, dz = b.position.z + 0.5 - info.center.z;
        return {depth: dx * dir.x + dz * dir.z, side: Math.abs(-dx * dir.z + dz * dir.x)};
    };
    const eye = () => bot.entity.position.offset(0, 1.62, 0);
    // shots from the ground come up steeply, so clear the whole face, bottom rows included. the rails keep us up here
    const near_face = getPillarInfo(bot, crystal).bars
        .filter(b => facing(b).depth > 1.2 && b.position.y >= info.top && b.position.y <= info.top + 2)
        .filter(b => eye().distanceTo(b.position.offset(0.5, 0.5, 0.5)) < 4.5)
        .sort((a, b) => facing(a).side - facing(b).side || a.position.y - b.position.y);
    // an arrow from the ground needs the bars within about a block of the line through the middle of the gap
    // gone (on a diagonal that's bars on both faces either side of the corner)
    const gapDone = () => near_face.every(b => facing(b).side >= 1.1 || bot.blockAt(b.position)?.name !== 'iron_bars');
    let broken = 0;
    let approach_seen = null;
    for (const bar of near_face) {
        if (bot.interrupt_code) break;
        if (bot.health < 10) {
            log(bot, `Getting hurt up here, climbing down.`);
            break;
        }
        if (comingForUs()) {
            // heading in to land from far away, it takes 25s or more before it could come for us: enough to
            // finish a small gap now we're up here (otherwise, with few crystals left, it lands so often we
            // might never get one made)
            const d = dragon();
            const far_landing = d && dragonPhase(d) === DRAGON_PHASE.LANDING_APPROACH && !dragonHazards(bot).incoming &&
                d.position.distanceTo(bot.entity.position) > 40;
            approach_seen ??= Date.now();
            if (!far_landing || gapDone() || Date.now() - approach_seen > 8000) {
                log(bot, `The dragon is coming, climbing back down.`);
                break;
            }
        }
        if (bot.blockAt(bar.position)?.name !== 'iron_bars') continue;
        if (await breakBlockAt(bot, bar.position.x, bar.position.y, bar.position.z)) broken++;
        // every bar up here is time the dragon has to come back: stop as soon as the gap is big enough
        if (broken >= 3 && gapDone()) break;
    }
    await climbDown(`Broke ${broken} iron bars. Climbing back down before shooting, crystals explode.`);
    // (on a second try the bars facing us may all be gone already)
    if (broken > 0 || near_face.every(b => bot.blockAt(b.position)?.name !== 'iron_bars')) return angle;
    return bot.interrupt_code ? null : 'later';
}

function dragonHazards(bot) {
    /* The dragon's breath clouds near us (they grow to radius 7 and hurt anything in them every second), and
       anything coming at us: a fireball (it turns into a cloud where it lands, and the cloud jumps onto anyone
       within 4 blocks of that spot), or the dragon itself charging. */
    const here = bot.entity.position;
    const clouds = Object.values(bot.entities)
        .filter(e => e.name === 'area_effect_cloud' && e.position.distanceTo(here) < 40)
        .map(e => ({x: e.position.x, y: e.position.y, z: e.position.z, r: (typeof e.metadata?.[8] === 'number' ? e.metadata[8] : 3) + 1.2}));
    const inBreath = (x, z, margin=0) => clouds.some(c => Math.hypot(x - c.x, z - c.z) < c.r + margin);
    // remember where each fireball was first seen: it flies in a straight line from there. the dragon fires them
    // from far away and they speed up a lot, so spot them early
    const seen = bot._dragon_fireballs ??= new Map();
    let incoming = null;
    for (const e of Object.values(bot.entities)) {
        if (e.name !== 'dragon_fireball') continue;
        if (!seen.has(e.id)) seen.set(e.id, e.position.clone());
        if (e.position.distanceTo(here) > 80) continue;
        const aim = here.offset(0, 1, 0);
        let dir = e.position.minus(seen.get(e.id));
        if (dir.norm() < 1) dir = aim.minus(e.position); // only just fired, and they're fired at us
        dir = dir.normalize();
        const to_us = aim.minus(e.position);
        const along = to_us.dot(dir);
        if (along < -2) continue; // already past us
        // where it comes down on our level, and how close it passes us on the way
        let impact = null;
        if (dir.y < -0.05) {
            const t = (here.y - e.position.y) / dir.y;
            impact = {x: e.position.x + dir.x * t, z: e.position.z + dir.z * t};
        }
        const miss = to_us.minus(dir.scaled(Math.max(along, 0))).norm();
        const impact_miss = impact ? Math.hypot(impact.x - here.x, impact.z - here.z) : Infinity;
        if (Math.min(miss, impact_miss) < 6) {
            incoming = {what: 'fireball', position: e.position, dir, impact, lateral: 4};
            break;
        }
    }
    for (const id of seen.keys()) if (!bot.entities[id]) seen.delete(id);
    // its wings fling anything within about 10 blocks of its body, high into the air. so whenever it comes past
    // low down (taking off, swooping round, charging), get off its path like with a fireball. when it perches and
    // nobody is within 20 blocks, it charges straight at the nearest player's position
    const dragon = Object.values(bot.entities).find(e => e.name === 'ender_dragon');
    const now = Date.now();
    const track = bot._dragon_track;
    if (dragon && (!track || track.id !== dragon.id || now - track.t > 1000))
        bot._dragon_track = {id: dragon.id, pos: dragon.position.clone(), t: now, vel: null};
    else if (dragon && now - track.t >= 200)
        bot._dragon_track = {id: dragon.id, pos: dragon.position.clone(), t: now, vel: dragon.position.minus(track.pos).scaled(1000 / (now - track.t))};
    const phase = dragonPhase(dragon);
    const vel = bot._dragon_track?.vel;
    const flying = dragon && phase !== null && !SITTING_PHASES.includes(phase) && phase !== DRAGON_PHASE.DYING;
    if (!incoming && flying && vel && dragon.position.y - here.y < 8 && dragon.position.y - here.y > -6) {
        const speed2 = vel.x * vel.x + vel.z * vel.z;
        if (speed2 > 1) {
            // how close it passes us if it keeps going this way (it speeds up a lot, so don't count on it being slow)
            const rx = here.x - dragon.position.x, rz = here.z - dragon.position.z;
            const t = Math.max(0, (rx * vel.x + rz * vel.z) / speed2);
            if (t > 0 && Math.hypot(rx - vel.x * t, rz - vel.z * t) < 11 && Math.hypot(rx, rz) < 40)
                incoming = {what: 'dragon', position: dragon.position.clone(), dir: vel.normalize(), impact: null, lateral: 12};
        }
    }
    if (dragon && phase === DRAGON_PHASE.CHARGING_PLAYER) {
        if (bot._dragon_charge?.id !== dragon.id) bot._dragon_charge = {id: dragon.id, from: dragon.position.clone(), to: here.clone()};
        const {from, to} = bot._dragon_charge;
        const dir = to.minus(from);
        const len = Math.hypot(dir.x, dir.z);
        if (!incoming && len > 1) {
            // where along its path the dragon and we are
            const along = p => ((p.x - from.x) * dir.x + (p.z - from.z) * dir.z) / len;
            const lateral = Math.abs((here.x - from.x) * dir.z - (here.z - from.z) * dir.x) / len;
            if (lateral < 11 && along(dragon.position) < along(here) + 6)
                incoming = {what: 'dragon', position: from, dir: dir.normalize(), impact: null, lateral: 11};
        }
    }
    else bot._dragon_charge = null;
    const inCloud = clouds.find(c => Math.hypot(here.x - c.x, here.z - c.z) < c.r && Math.abs(here.y - c.y) < 3);
    return {clouds, inBreath, incoming, inCloud};
}

function hazardEscape(bot, hazards) {
    /* The nearest spot on solid ground that's out of every cloud and out of the way of whatever is coming. */
    const here = bot.entity.position;
    const fb = hazards.incoming;
    const safe = (x, z) => {
        if (hazards.inBreath(x, z, 1)) return false;
        if (fb) {
            // well away from where a fireball lands (the cloud jumps 4 blocks onto us), and off the line of flight
            if (fb.impact && Math.hypot(x - fb.impact.x, z - fb.impact.z) < 7) return false;
            const flat = Math.hypot(fb.dir.x, fb.dir.z);
            if (flat > 0.3) {
                const ox = x - fb.position.x, oz = z - fb.position.z;
                if (ox * fb.dir.x + oz * fb.dir.z > 0 && Math.abs(ox * fb.dir.z - oz * fb.dir.x) / flat < fb.lateral) return false;
            }
        }
        return true;
    };
    // the nearest such spot, but one we can sprint straight to (no pillar or step in the way) beats a slightly
    // nearer one we'd have to path around to
    const DETOUR = 6;
    let fallback = null;
    for (const radius of [3, 5, 7, 9, 12, 15]) {
        if (fallback && radius > fallback.radius + DETOUR) break;
        for (let a = 0; a < 16; a++) {
            const x = here.x + Math.cos(a * Math.PI / 8) * radius, z = here.z + Math.sin(a * Math.PI / 8) * radius;
            if (!safe(x, z)) continue;
            const y = groundAt(bot, x, z, here.y + 3);
            if (y === null || Math.abs(y - here.y) > 3) continue; // the island's edge, or a pillar
            if (straightRunClear(bot, x, z)) return {x, y, z, radius, straight: true};
            if (!fallback) fallback = {x, y, z, radius, straight: false};
        }
    }
    return fallback;
}

function breathMovements(bot, clouds, keepOut=null) {
    /* Pathfinder movements for the dragon fight: no digging, never tower up, and walk around its breath (and
       anywhere else keepOut(x, y, z) says, like the reach of the dragon's head and wings). */
    const movements = makeMovements(bot, {destructive: false});
    movements.allow1by1towers = false;
    // the island is flat enough, and parkour moves are slow to plan
    movements.allowParkour = false;
    if (clouds.length > 0 || keepOut) {
        movements.exclusionAreasStep.push(block => {
            const x = block.position.x + 0.5, z = block.position.z + 0.5;
            // enough to walk around, not so much that the search balloons when we have to cross
            if (keepOut?.(x, block.position.y, z)) return 10;
            return clouds.some(c => Math.hypot(x - c.x, z - c.z) < c.r + 1 && Math.abs(block.position.y - c.y) < 3) ? 6 : 0;
        });
    }
    return movements;
}

function straightRunClear(bot, x, z) {
    /* Is there ground all the way to x,z at our own level, give or take a step, so we can just run there? */
    const here = bot.entity.position;
    const y0 = Math.floor(here.y);
    const dist = Math.hypot(x - here.x, z - here.z);
    for (let d = 0.5; d <= dist; d += 0.5) {
        const y = groundAt(bot, here.x + (x - here.x) * d / dist, here.z + (z - here.z) * d / dist, y0 + 2);
        if (y === null || Math.abs(y - y0) > 1) return false;
    }
    return true;
}

async function dodgeDragon(bot, hazards) {
    /* Get out of its breath, or the way of a fireball or the charging dragon. Returns once clear, or after a few seconds.
       Every second in the breath hurts, so sprint straight out when the ground allows, rather than wait for a path. */
    const escape = hazardEscape(bot, hazards);
    if (!escape) return false;
    let run = escape.straight;
    const usePathfinder = () => {
        bot.clearControlStates();
        bot.pathfinder.setMovements(breathMovements(bot, hazards.clouds));
        bot.pathfinder.setGoal(new pf.goals.GoalNear(escape.x, escape.y, escape.z, 1));
    };
    if (run) stopPathfinding(bot);
    else usePathfinder();
    const start = Date.now();
    let progress_at = Date.now(), best_left = Infinity;
    try {
        while (Date.now() - start < 4000 && !bot.interrupt_code) {
            const p = bot.entity.position;
            const dx = escape.x - p.x, dz = escape.z - p.z;
            const left = Math.hypot(dx, dz);
            if (left < 1) break;
            if (left < best_left - 0.3) {
                best_left = left;
                progress_at = Date.now();
            }
            else if (run && Date.now() - progress_at > 600) {
                // something in the way after all
                run = false;
                usePathfinder();
            }
            if (run) {
                await bot.look(Math.atan2(-dx, -dz), 0, true);
                // hop up a step in the way
                const ahead = groundAt(bot, p.x + dx / left * 0.8, p.z + dz / left * 0.8, Math.floor(p.y) + 2);
                bot.setControlState('jump', ahead !== null && ahead > Math.floor(p.y) + 0.5);
                bot.setControlState('sprint', true);
                bot.setControlState('forward', true);
            }
            await new Promise(resolve => setTimeout(resolve, 50));
            const h = dragonHazards(bot);
            if (!h.incoming && !h.inCloud) break;
        }
    } finally {
        bot.clearControlStates();
        stopPathfinding(bot);
    }
    return true;
}

async function walkDodging(bot, goal, stop=null, timeout=30000) {
    /* Walk to a goal around the dragon's breath. Stops and returns 'later' as soon as something comes at us,
       breath reaches us, or stop() says so, so the caller can deal with that first. */
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const heuristic = () => goal.heuristic(bot.entity.position.floored());
    let best = heuristic();
    let last_progress = Date.now();
    let clouds_key = null;
    const start = Date.now();
    try {
        while (Date.now() - start < timeout) {
            if (bot.interrupt_code) return false;
            if (goal.isEnd(bot.entity.position.floored())) return true;
            const hazards = dragonHazards(bot);
            if (hazards.incoming || hazards.inCloud || stop?.()) return 'later';
            // re-plan around the clouds whenever they change
            const key = hazards.clouds.map(c => `${Math.round(c.x)},${Math.round(c.z)},${Math.round(c.r)}`).join(';');
            if (key !== clouds_key || !bot.pathfinder.goal) {
                clouds_key = key;
                bot.pathfinder.setMovements(breathMovements(bot, hazards.clouds));
                bot.pathfinder.setGoal(goal);
            }
            const h = heuristic();
            if (h < best - 0.5) {
                best = h;
                last_progress = Date.now();
            }
            else if (Date.now() - last_progress > 8000) return false;
            await sleep(100);
        }
        return false;
    } finally {
        stopPathfinding(bot);
    }
}

function strandedHigh(bot) {
    /* Standing on top of something tall (a pillar the dragon threw us onto), with the ground all around far
       below? Then there's no path down, and the pathfinder will happily run us off the edge. */
    const here = bot.entity.position;
    if (!bot.entity.onGround) return false;
    let drops = 0;
    for (let a = 0; a < 8; a++) {
        const y = groundAt(bot, here.x + Math.cos(a * Math.PI / 4) * 7, here.z + Math.sin(a * Math.PI / 4) * 7, here.y + 2);
        if (y === null || y < here.y - 8) drops++;
    }
    return drops >= 6;
}

async function getDownSafely(bot) {
    /* Dig straight down through whatever we're stuck on top of. Slow through obsidian, but the walls of the hole
       also keep the dragon's wings from throwing us around. Standing on a lone block with nothing under it,
       ride a waterfall down instead. Returns false if we couldn't. */
    const here = bot.entity.position;
    let ground = null;
    for (let a = 0; a < 8 && ground === null; a++)
        ground = groundAt(bot, here.x + Math.cos(a * Math.PI / 4) * 7, here.z + Math.sin(a * Math.PI / 4) * 7, here.y - 8);
    const depth = Math.floor(here.y) - (ground ?? Math.floor(here.y) - 20);
    log(bot, `Stuck up on top of something ${depth} blocks high. Getting down.`);
    await centerOnBlock(bot);
    if (await digDown(bot, depth)) return true;
    if (bot.interrupt_code || !strandedHigh(bot)) return false;
    return await waterfallDown(bot);
}

async function waterfallDown(bot) {
    /* Pour water out where we stand: it spills over the edges and falls all the way down, and falling through
       water doesn't hurt. Wait for it to reach the bottom, then step off into it. */
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const bucket = bot.inventory.items().find(i => i.name === 'water_bucket');
    if (!bucket) {
        log(bot, `No water bucket to get down safely with.`);
        return false;
    }
    const start_y = bot.entity.position.y;
    const feet = bot.entity.position.floored();
    // a side where the water will pour over the edge
    const side = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dx, dz]) =>
        isAirLike(bot.blockAt(feet.offset(dx, 0, dz))) && isAirLike(bot.blockAt(feet.offset(dx, -1, dz))));
    if (!side) return false;
    stopPathfinding(bot);
    await bot.equip(bucket, 'hand');
    await bot.look(bot.entity.yaw, -Math.PI / 2, true);
    bot.activateItem();
    await sleep(200);
    bot.deactivateItem();
    if (bot.blockAt(feet)?.name !== 'water') {
        log(bot, `Couldn't pour the water out.`);
        return false;
    }
    log(bot, `Poured water out to ride it down.`);
    // flowing water falls about 4 blocks a second
    await sleep(Math.min(12000, 1000 + (start_y - 60) * 300));
    const target = feet.offset(side[0] + 0.5, 0, side[1] + 0.5);
    await bot.look(Math.atan2(-(target.x - bot.entity.position.x), -(target.z - bot.entity.position.z)), 0, true);
    bot.setControlState('forward', true);
    await sleep(400);
    bot.setControlState('forward', false);
    for (let t = 0; t < 150; t++) {
        if (bot.entity.onGround && !bot.entity.isInWater && bot.entity.position.y < start_y - 3) break;
        await sleep(100);
    }
    const dropped = start_y - bot.entity.position.y;
    log(bot, dropped > 3 ? `Got down ${Math.round(dropped)} blocks.` : `Couldn't get down the waterfall.`);
    return dropped > 3;
}

async function healIfHurt(bot, below=12) {
    /* Eat a golden apple (or food, if hungry) when hurt. Returns true if we ate something. */
    if (bot.health >= below) return false;
    const items = bot.inventory.items();
    const food = items.find(i => i.name === 'enchanted_golden_apple' || i.name === 'golden_apple') ||
        (bot.food < 20 ? items.find(i => ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'bread', 'baked_potato', 'golden_carrot', 'cooked_chicken'].includes(i.name)) : null);
    if (!food) return false;
    return await consume(bot, food.name);
}

function dragonFighter(bot, portal_y) {
    /* The dragon fight, one step at a time: step() looks at what the dragon is doing and acts on it for a moment.
       It returns true once the dragon is dead, false if we should give up, and null to keep going.
       What to do depends on its phase: shoot it while it flies, and hit its head while it's perched (arrows do
       nothing then), staying out of its breath, which lingers on the ground as clouds. */
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    let last_attack = 0;
    let last_shot = 0;
    let flip_yaw = false;
    let missed_head_hits = 0;
    let last_seen = Date.now();
    let last_move = 0;
    let last_health = null;
    let last_status = 0;
    let last_heal = 0;
    let last_getdown = 0;
    let goal_key = null;
    const moveTo = (x, z, range, y=null, keepOut=null) => {
        // only re-plan when the target actually changes, or every few seconds
        const key = `${Math.round(x)},${Math.round(z)},${range}`;
        if (key === goal_key && Date.now() - last_move < 3000) return;
        goal_key = key;
        last_move = Date.now();
        bot.pathfinder.setMovements(breathMovements(bot, dragonHazards(bot).clouds, keepOut));
        bot.pathfinder.setGoal(y !== null ? new pf.goals.GoalNear(x, y, z, range) : new pf.goals.GoalNearXZ(x, z, range));
    };

    const step = async ({engage=true} = {}) => {
        /* engage: attack it when it perches. Not worth it while crystals are still healing it faster than we
           can hurt it; then we only stay close enough that it doesn't charge at us. */
        if (bot.interrupt_code) return false;
        const dragon = Object.values(bot.entities).find(e => e.name === 'ender_dragon');
        if (!dragon) {
            // either dead or out of tracking range. the exit portal only opens once it's dead
            await sleep(1000);
            if (world.getNearestBlock(bot, 'end_portal', 64)) {
                log(bot, `The ender dragon is dead! Walk into the exit portal (enterPortal with 'end_portal') to finish the game.`);
                return true;
            }
            if (Date.now() - last_seen > 60000) {
                log(bot, `Can't find the ender dragon anywhere.`);
                return false;
            }
            if (Math.hypot(bot.entity.position.x, bot.entity.position.z) > 30) moveTo(8, 8, 3);
            return null;
        }
        last_seen = Date.now();
        const phase = dragonPhase(dragon);
        if (phase === DRAGON_PHASE.DYING) {
            stopPathfinding(bot);
            await sleep(500);
            return null;
        }

        // heal up between hits, before it gets dangerous
        if (bot.health < 12 && Date.now() - last_heal > 5000) {
            last_heal = Date.now();
            if (await healIfHurt(bot, 12)) return null;
        }

        // sidestep fireballs and its charges (across their line of flight) and get out of its breath
        const here = bot.entity.position;
        const hazards = dragonHazards(bot);
        if (hazards.incoming || hazards.inCloud) {
            goal_key = null;
            if (!(await dodgeDragon(bot, hazards))) await sleep(150);
            return null;
        }
        if (strandedHigh(bot)) {
            // up on a pillar: there's no path down, and the pathfinder would run us off the edge looking for one.
            // dig down now and then, and meanwhile shoot it from up here
            stopPathfinding(bot);
            goal_key = null;
            if (Date.now() - last_getdown > 15000) {
                last_getdown = Date.now();
                await getDownSafely(bot);
            }
            else if (!SITTING_PHASES.includes(phase) && hasBowAndArrows(bot) && Date.now() - last_shot > 1500 &&
                    bot.entity.position.distanceTo(dragon.position) < 70 &&
                    !Object.values(bot.entities).some(e => e.name === 'end_crystal' && Math.hypot(e.position.x, e.position.z) < 80)) {
                await fireArrowAt(bot, dragon, {abort: () => { const h = dragonHazards(bot); return !!(h.incoming || h.inCloud); }});
                last_shot = Date.now();
            }
            await sleep(200);
            return null;
        }

        // a spot this far from the dragon (or the portal) on solid ground, out of the breath, the closest one to us
        const clearSpot = (cx, cz, radius) => {
            let best = null;
            for (let a = 0; a < 16; a++) {
                const x = cx + Math.cos(a * Math.PI / 8) * radius, z = cz + Math.sin(a * Math.PI / 8) * radius;
                if (hazards.inBreath(x, z)) continue;
                const y = groundAt(bot, x, z, 80);
                if (y === null || y < 50) continue;
                // it flies in and out of the middle low down, through points 20 blocks out due north, east, south
                // and west of the portal, so wait on the diagonals in between
                const off_line = Math.min(Math.abs(x), Math.abs(z));
                const d = Math.hypot(x - here.x, z - here.z) + (off_line < 8 ? 40 : 0);
                if (!best || d < best.d) best = {x, y, z, d};
            }
            return best;
        };
        // taking off, landing, or flying low: its wings throw you ~40 blocks and its head and neck hit hard
        const dragon_d = Math.hypot(here.x - dragon.position.x, here.z - dragon.position.z);
        const keep_clear = phase === DRAGON_PHASE.TAKEOFF || phase === DRAGON_PHASE.LANDING ||
            (phase !== null && !SITTING_PHASES.includes(phase) && dragon.position.y < here.y + 10);
        if (keep_clear && dragon_d < 13) {
            const spot = clearSpot(dragon.position.x, dragon.position.z, 15);
            if (spot) moveTo(spot.x, spot.z, 1.5, spot.y);
            await sleep(150);
            return null;
        }

        const health = getEntityHealth(dragon);
        if (Date.now() - last_status > 20000 && health !== null) {
            log(bot, `Dragon health: ${Math.round(health)}/200.`);
            last_status = Date.now();
        }
        const d_center = Math.hypot(dragon.position.x, dragon.position.z);
        // phases are in the dragon's metadata on modern versions; fall back to where it is
        const perched = phase !== null ? SITTING_PHASES.includes(phase) : (d_center < 10 && dragon.position.y < portal_y + 8);
        const landing = phase === DRAGON_PHASE.LANDING || phase === DRAGON_PHASE.LANDING_APPROACH;
        const dist = bot.entity.position.distanceTo(dragon.position);

        if (perched) {
            const c = dragon.position;
            const from_center = Math.hypot(here.x - c.x, here.z - c.z);
            if (!engage) {
                // within 20 blocks so it doesn't charge, and out of its breath, which lands up to 14 blocks in front of it
                if (from_center < 15.5 || from_center > 19) {
                    const spot = clearSpot(c.x, c.z, 17);
                    if (spot) moveTo(spot.x, spot.z, 1, spot.y);
                }
                await sleep(150);
                return null;
            }
            // its head (the only part that takes full damage) is 6.5 blocks out from its middle, and it turns its head to
            // whoever is close. the head and neck hurt anything within a block of them, and the wings (4.5 blocks out to
            // each side) shove anything within 4 blocks of them, so: stand about 9.4 blocks out in front of it, close
            // enough to hit the head but out of its reach, and walk round the outside of all that to get there
            const parts = dragonPartPositions(dragon, flip_yaw, true);
            const eye = bot.entity.position.offset(0, 1.62, 0);
            const head_dist = eye.distanceTo(parts.head);
            const hurtZones = [
                {c: parts.head, half: 0.5 + 1 + 0.4, y0: parts.head.y - 1.5, y1: parts.head.y + 1.5},
                {c: parts.neck, half: 1.5 + 1 + 0.4, y0: parts.neck.y - 2.5, y1: parts.neck.y + 2.5},
                ...parts.wings.map(w => ({c: w, half: 2 + 4 + 0.4, y0: c.y - 2, y1: c.y + 4})),
            ];
            const SAFE = 8.8, RING = 9.4, CLEAR = 16;
            const keepOut = (x, y, z) => Math.hypot(x - c.x, z - c.z) < SAFE ||
                hurtZones.some(h => Math.abs(x - h.c.x) < h.half && Math.abs(z - h.c.z) < h.half && y < h.y1 && y + 1.8 > h.y0);
            // ground on a ring round it, starting from our own direction from it so we never cut across in front
            const ringSpot = (radius) => {
                const base = Math.atan2(here.z - c.z, here.x - c.x);
                for (let k = 0; k <= 20; k++) {
                    for (const sign of k === 0 ? [1] : [1, -1]) {
                        const a = base + sign * k * 0.15;
                        const x = c.x + Math.cos(a) * radius, z = c.z + Math.sin(a) * radius;
                        if (hazards.inBreath(x, z)) continue;
                        const y = groundAt(bot, x, z, c.y + 2);
                        if (y === null || keepOut(x, y, z)) continue;
                        return {x, y, z};
                    }
                }
                return null;
            };
            if (phase === DRAGON_PHASE.SITTING_FLAMING) {
                // it breathes on the ground in front of its head, right where we stand to hit it. the cloud starts
                // hurting a second after it appears, so run straight out until it's done
                if (from_center < CLEAR - 1) {
                    const spot = ringSpot(CLEAR);
                    if (spot) moveTo(spot.x, spot.z, 1, spot.y, keepOut);
                }
                await sleep(100);
                return null;
            }
            const on_ring = from_center <= RING + 0.8 && !keepOut(here.x, here.y, here.z);
            if (on_ring && head_dist < 5.5) {
                stopPathfinding(bot);
                goal_key = null;
            }
            else {
                // go round the outside to the front, where its head points (it turns towards us anyway while it looks
                // around), or else the nearest bit of the ring
                const front = Math.atan2(parts.head.z - c.z, parts.head.x - c.x);
                const fx = c.x + Math.cos(front) * RING, fz = c.z + Math.sin(front) * RING;
                const fy = groundAt(bot, fx, fz, c.y + 2);
                const spot = fy !== null && !hazards.inBreath(fx, fz) && !keepOut(fx, fy, fz) ? {x: fx, y: fy, z: fz} : ringSpot(RING);
                if (spot) moveTo(spot.x, spot.z, 0.7, spot.y, keepOut);
            }
            await equipHighestAttack(bot);
            const cooldown = mc.getAttackCooldown(bot.heldItem?.name) * 1000;
            if (Date.now() - last_attack > cooldown) {
                // the server accepts hits up to ~6 blocks from a part's hitbox
                let target = null;
                if (head_dist < 5.5) target = {id: dragon.id + DRAGON_HEAD, position: parts.head};
                else if (eye.distanceTo(parts.body) < 6) target = {id: dragon.id + DRAGON_BODY, position: parts.body};
                if (target) {
                    if (target.id === dragon.id + DRAGON_HEAD && last_health !== null && health !== null) {
                        // head swings that don't hurt it mean our facing estimate is mirrored
                        if (health >= last_health) missed_head_hits++;
                        else missed_head_hits = 0;
                        if (missed_head_hits >= 2) {
                            flip_yaw = !flip_yaw;
                            missed_head_hits = 0;
                        }
                    }
                    last_health = health;
                    await bot.lookAt(target.position, true);
                    bot.attack(target);
                    last_attack = Date.now();
                }
            }
        }
        else {
            // flying: shoot it if we can, and wait near the portal for it to perch. 14 blocks out is close enough
            // to get to its head quickly (and if we're further than 20 when it perches, it charges us), but clear
            // of its wings when it lands. if we're only keeping it from charging, wait out of reach of its breath
            const [near, far, wait_at] = engage ? [12, 18, 14] : [15.5, 19, 17];
            const from_portal = Math.hypot(here.x, here.z);
            if (from_portal < near || from_portal > far) {
                const wait = clearSpot(0, 0, wait_at);
                if (wait) moveTo(wait.x, wait.z, 1.5, wait.y);
            }
            // most arrows at it in flight miss, and while a crystal is up it heals them off anyway: keep the arrows
            // for the crystals then
            const crystals_up = Object.values(bot.entities).some(e => e.name === 'end_crystal' && Math.hypot(e.position.x, e.position.z) < 80);
            if (hasBowAndArrows(bot) && !crystals_up && dist < 70 && Date.now() - last_shot > 1500 && (!landing || dist > 12) &&
                (!landing || from_portal < far)) {
                stopPathfinding(bot);
                goal_key = null;
                // give up the shot if something comes at us or breath reaches us while drawing
                await fireArrowAt(bot, dragon, {abort: () => { const h = dragonHazards(bot); return !!(h.incoming || h.inCloud); }});
                last_shot = Date.now();
            }
        }
        await sleep(100);
        return null;
    };
    return {step};
}

export async function fightEnderDragon(bot) {
    /**
     * Fight the ender dragon in the end: shoot down the end crystals with a bow, then attack the dragon when it perches on the portal fountain and shoot it while it flies. Bring a bow, lots of arrows, blocks, food, and armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the dragon was killed, false otherwise.
     * @example
     * await skills.fightEnderDragon(bot);
     **/
    // we re-plan paths all the time here, and the pathfinder thinks for up to 40ms each physics tick. when ticks
    // run long, physics catches up with several at once and the bot freezes for half a second, which is deadly
    // here. think in smaller slices instead
    const tick_timeout = bot.pathfinder.tickTimeout;
    bot.pathfinder.tickTimeout = 15;
    try {
        return await dragonFight(bot);
    } finally {
        bot.pathfinder.tickTimeout = tick_timeout;
    }
}

async function dragonFight(bot) {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    if (getDimension(bot) !== 'the_end') {
        log(bot, `You need to be in the end to fight the dragon.`);
        return false;
    }
    bot.modes.pause('cowardice');
    bot.modes.pause('hunting');
    bot.modes.pause('item_collecting');
    bot.modes.pause('elbow_room');
    bot.modes.pause('unstuck');
    // never look an enderman in the eyes while we're busy
    bot.modes.pause('idle_staring');
    // right after arriving the island may still be loading, and the bot freezes in unloaded chunks
    try { await bot.waitForChunksToLoad(); } catch (err) { /* go anyway */ }

    // 1. get onto the main island. we may spawn on the obsidian platform out over the void
    const to_center = Math.hypot(bot.entity.position.x, bot.entity.position.z);
    if (to_center > 40) {
        log(bot, `Heading to the main island.`);
        if (!getScaffoldItem(bot)) log(bot, `Warning: no blocks to bridge with.`);
        await travelTo(bot, 0, 0, 30);
        if (bot.interrupt_code) return false;
    }
    const fight = dragonFighter(bot, findExitPortalTop(bot) ?? 64);

    // 2. destroy the end crystals, they heal the dragon. caged ones get their bars broken first
    const given_up = new Set();
    const cage_opened = new Map(); // crystal id -> angle of the gap we made
    const cage_failed = new Map(); // crystal id -> times opening its cage didn't work out
    const no_shot = new Map(); // caged crystal id -> how many bars were left when we found no way to shoot it
    let crystal_time = 0;
    let last_getdown = 0;
    let last_round = Date.now();
    let last_crystal_heal = 0;
    let waiting_out_perch = false;
    // (a crystal left up heals it faster than we can hurt it, so this is worth most of the time we have)
    for (let round = 0; round < 60 && crystal_time < 9 * 60 * 1000; round++) {
        // (always let timers run between rounds: some rounds end without waiting on anything)
        await sleep(50);
        if (bot.interrupt_code) return false;
        // whenever it comes down to perch, go back near the portal: it looks for someone within 20 blocks when it
        // lands, and charges at anyone further away
        if (dragonPerching(bot) || (waiting_out_perch && Object.values(bot.entities).some(e => e.name === 'ender_dragon' &&
                dragonPhase(e) === DRAGON_PHASE.TAKEOFF))) {
            if (!waiting_out_perch) log(bot, `The dragon is coming down to perch. Staying close so it doesn't charge, the crystals heal it too fast to hurt it yet.`);
            waiting_out_perch = true;
            const result = await fight.step({engage: false});
            if (result !== null) return result;
            last_round = Date.now();
            round--;
            continue;
        }
        waiting_out_perch = false;
        crystal_time += Date.now() - last_round;
        last_round = Date.now();
        if (strandedHigh(bot)) {
            // (walking anywhere from up here would run us off the edge)
            if (Date.now() - last_getdown > 15000) {
                last_getdown = Date.now();
                await getDownSafely(bot);
            }
            await sleep(500);
            continue;
        }
        // the dragon doesn't wait for us to finish: dodge its fireballs and breath, and heal up
        const hazards = dragonHazards(bot);
        if (hazards.incoming || hazards.inCloud) {
            if (!(await dodgeDragon(bot, hazards))) await sleep(300);
            round--;
            continue;
        }
        // golden apples heal over a few seconds, so don't eat another one straight away
        if (Date.now() - last_crystal_heal > 6000 && await healIfHurt(bot, 14)) {
            last_crystal_heal = Date.now();
            continue;
        }
        // open crystals first, they're quick and safe. caged ones mean towering up next to the pillar
        const caged = e => getPillarInfo(bot, e).bars.length > 0 && !cage_opened.has(e.id);
        const crystals = Object.values(bot.entities)
            .filter(e => e.name === 'end_crystal' && !given_up.has(e.id) && Math.hypot(e.position.x, e.position.z) < 80)
            .map(e => ({e, caged: caged(e), dist: e.position.distanceTo(bot.entity.position)}))
            .sort((a, b) => (a.caged - b.caged) || (a.dist - b.dist))
            .map(c => c.e);
        if (crystals.length === 0) break;
        if (!hasBowAndArrows(bot)) {
            log(bot, `Need a bow and arrows to destroy the end crystals.`);
            break;
        }
        const crystal = crystals[0];
        const info = getPillarInfo(bot, crystal);
        let angles = null;
        if (cage_opened.has(crystal.id)) {
            // shoot through the gap we made: stay close to that direction
            const a = cage_opened.get(crystal.id);
            angles = [a, a + 0.15, a - 0.15, a + 0.3, a - 0.3];
        }
        else if (info.bars.length > 0 && (no_shot.get(crystal.id) === info.bars.length || !(await planCrystalShot(bot, crystal, info)))) {
            // (planning a shot that turns out impossible traces a lot of arcs: don't redo it until the bars change)
            no_shot.set(crystal.id, info.bars.length);
            const gap = await openCrystalCage(bot, crystal);
            if (gap === 'later') {
                // (doesn't count as a try: the time limit still applies)
                round--;
                continue;
            }
            if (gap === null) {
                cage_failed.set(crystal.id, (cage_failed.get(crystal.id) ?? 0) + 1);
                if (cage_failed.get(crystal.id) >= 2) {
                    log(bot, `Couldn't open the cage around the crystal at ${crystal.position.floored()}.`);
                    given_up.add(crystal.id);
                }
                continue;
            }
            cage_opened.set(crystal.id, gap);
            continue;
        }
        const destroyed = await shootCrystal(bot, crystal, angles);
        if (destroyed === 'later') {
            round--;
            await sleep(500);
            continue;
        }
        if (!destroyed && isAlive(bot, crystal) && cage_opened.has(crystal.id) && (cage_failed.get(crystal.id) ?? 0) < 1) {
            // the gap wasn't enough after all: go back up and make it bigger
            cage_failed.set(crystal.id, 1);
            cage_opened.delete(crystal.id);
            no_shot.delete(crystal.id);
            continue;
        }
        if (!destroyed && isAlive(bot, crystal)) {
            log(bot, `Missed the crystal at ${crystal.position.floored()} too many times, moving on.`);
            given_up.add(crystal.id);
        }
    }
    const left = Object.values(bot.entities).filter(e => e.name === 'end_crystal' && Math.hypot(e.position.x, e.position.z) < 80).length;
    if (left > 0)
        log(bot, `${left} crystals are still up. The dragon can still be killed but will heal near them.`);

    // 3. fight the dragon
    const start = Date.now();
    while (Date.now() - start < 15 * 60 * 1000) {
        const result = await fight.step();
        if (result !== null) return result;
    }
    log(bot, `Fought the dragon for 15 minutes without killing it.`);
    return false;
}

// ----------------------------------------------------------------------------------------------
// Gathering the end-game materials: obsidian, blaze rods, ender pearls
// ----------------------------------------------------------------------------------------------

function isPortalObsidian(bot, block) {
    // don't tear down a nether portal we built
    return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
        .some(([x, y, z]) => bot.blockAt(block.position.offset(x, y, z))?.name === 'nether_portal');
}

async function mineSafeObsidian(bot, num) {
    // mine obsidian that won't drop its item into lava and isn't part of a portal
    const unsafe = world.getNearestBlocks(bot, ['obsidian'], 48, 200).filter(b => {
        const below = bot.blockAt(b.position.offset(0, -1, 0));
        return below?.name === 'lava' || isPortalObsidian(bot, b);
    }).map(b => b.position);
    const available = world.getNearestBlocks(bot, ['obsidian'], 48, 200).length - unsafe.length;
    if (available <= 0) return false;
    return await collectBlock(bot, 'obsidian', Math.min(num, available), unsafe);
}

export async function makeObsidian(bot, num=10) {
    /**
     * Make and mine obsidian by pouring water onto lava source blocks. Needs a water_bucket (or a bucket and nearby water) and a diamond_pickaxe.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} num, how much obsidian to end up with. Defaults to 10.
     * @returns {Promise<boolean>} true if you have the requested obsidian, false otherwise.
     * @example
     * await skills.makeObsidian(bot, 10);
     **/
    const count = () => world.getInventoryCounts(bot)['obsidian'] || 0;
    const inv = world.getInventoryCounts(bot);
    if (!inv['diamond_pickaxe'] && !inv['netherite_pickaxe']) {
        log(bot, `Need a diamond_pickaxe to mine obsidian.`);
        return false;
    }
    if (getDimension(bot) === 'the_nether') {
        log(bot, `Water evaporates in the nether, make obsidian in the overworld.`);
        return false;
    }
    const tried = [];
    for (let attempt = 0; attempt < 25 && count() < num; attempt++) {
        if (bot.interrupt_code) return false;
        // use up obsidian that's already here first
        if (await mineSafeObsidian(bot, num - count())) continue;

        if (!bot.inventory.items().some(i => i.name === 'water_bucket')) {
            if (!bot.inventory.items().some(i => i.name === 'bucket')) {
                log(bot, `Need a water_bucket, or a bucket (3 iron_ingot) to fill with water.`);
                return false;
            }
            log(bot, `Filling a bucket with water.`);
            if (!(await collectBlock(bot, 'water', 1))) {
                log(bot, `Couldn't find water to fill the bucket.`);
                return false;
            }
        }
        // lava sources with other lava next to them turn into the most obsidian per pour
        const lava = world.getNearestBlocksWhere(bot, b => b.name === 'lava' && b.metadata === 0, 64, 40)
            .filter(b => !tried.some(p => p.distanceTo(b.position) < 3))
            .filter(b => isAirLike(bot.blockAt(b.position.offset(0, 1, 0))));
        if (lava.length === 0) {
            log(bot, `No lava source blocks nearby. Explore to find a lava pool (common in caves below y=0 and on the surface).`);
            return false;
        }
        const target = lava[0];
        tried.push(target.position);
        log(bot, `Pouring water onto lava at ${target.position}.`);
        await useToolOnBlock(bot, 'water_bucket', target);
        await new Promise(resolve => setTimeout(resolve, 1500));
        // pick the water back up so it doesn't flood everything (and we can reuse it)
        const water = world.getNearestBlocksWhere(bot, b => b.name === 'water' && b.metadata === 0, 8, 5)
            .find(b => b.position.distanceTo(target.position) < 3);
        if (water) {
            await useToolOnBlock(bot, 'bucket', water);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        await mineSafeObsidian(bot, num - count());
    }
    const have = count();
    log(bot, `You have ${have} obsidian.`);
    return have >= num;
}

export async function collectBlazeRods(bot, num=7) {
    /**
     * In the nether: find a nether fortress and kill blazes until you have enough blaze rods. Fights from range with a bow if you have one. Bring armor and food.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} num, how many blaze rods to collect. Defaults to 7.
     * @returns {Promise<boolean>} true if you have the requested blaze rods, false otherwise.
     * @example
     * await skills.collectBlazeRods(bot, 7);
     **/
    if (getDimension(bot) !== 'the_nether') {
        log(bot, `Blazes live in nether fortresses. Go to the nether first.`);
        return false;
    }
    const count = () => world.getInventoryCounts(bot)['blaze_rod'] || 0;
    const start = Date.now();
    let waiting_since = null;
    bot.modes.pause('unstuck'); // camping by a spawner isn't being stuck
    while (count() < num && Date.now() - start < 20 * 60 * 1000) {
        if (bot.interrupt_code) return false;
        const blaze = world.getNearestEntityWhere(bot, e => e.name === 'blaze', 32);
        if (blaze) {
            waiting_since = null;
            await attackEntity(bot, blaze, true); // shoots it if it's hovering above, melees otherwise
            continue;
        }
        const spawner = world.getNearestBlock(bot, 'spawner', 64);
        if (spawner) {
            // camp a few blocks from the spawner, blazes appear around it
            if (bot.entity.position.distanceTo(spawner.position) > 8) {
                await goToPosition(bot, spawner.position.x, spawner.position.y, spawner.position.z, 5);
            }
            waiting_since = waiting_since ?? Date.now();
            if (Date.now() - waiting_since > 90000) {
                log(bot, `No blazes have spawned in a while. The spawner may be blocked, or lit up by torches.`);
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
        }
        const bricks = world.getNearestBlocks(bot, ['nether_bricks'], 128, 400);
        if (bricks.length > 0) {
            // walk deeper into the fortress to find the blaze spawner
            const far = bricks[Math.floor(bricks.length * (0.5 + Math.random() * 0.5)) - 1] ?? bricks[0];
            log(bot, `In a nether fortress, searching for a blaze spawner.`);
            await goToPosition(bot, far.position.x, far.position.y + 1, far.position.z, 3);
            continue;
        }
        log(bot, `No nether fortress in sight, exploring.`);
        if (!(await explore(bot, 150))) await moveAway(bot, 20);
    }
    const have = count();
    log(bot, `You have ${have} blaze_rod.`);
    return have >= num;
}

export async function collectEnderPearls(bot, num=12) {
    /**
     * Hunt endermen for ender pearls until you have enough. Endermen are common in warped forests in the nether and at night in the overworld.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} num, how many ender pearls to collect. Defaults to 12.
     * @returns {Promise<boolean>} true if you have the requested ender pearls, false otherwise.
     * @example
     * await skills.collectEnderPearls(bot, 12);
     **/
    // eyes already crafted count as pearls
    const count = () => {
        const inv = world.getInventoryCounts(bot);
        return (inv['ender_pearl'] || 0) + (inv['ender_eye'] || 0);
    };
    const start = Date.now();
    let explored = 0;
    while (count() < num && Date.now() - start < 20 * 60 * 1000) {
        if (bot.interrupt_code) return false;
        const enderman = world.getNearestEntityWhere(bot, e => e.name === 'enderman', 48);
        if (enderman) {
            explored = 0;
            await attackEntity(bot, enderman, true);
            continue;
        }
        if (getDimension(bot) === 'overworld' && bot.time.timeOfDay < 13000 && explored === 0) {
            log(bot, `Endermen mostly spawn at night in the overworld (or in the nether's warped forests).`);
        }
        if (++explored > 8) {
            log(bot, `Couldn't find any endermen after exploring a lot.`);
            break;
        }
        await explore(bot, 120);
    }
    const have = count();
    log(bot, `You have ${have} ender pearls (counting eyes of ender).`);
    return have >= num;
}
