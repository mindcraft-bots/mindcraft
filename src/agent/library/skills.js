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

function getScaffoldItem(bot) {
    const items = bot.inventory.items();
    for (const name of SCAFFOLD_BLOCKS) {
        const item = items.find(i => i.name === name);
        if (item) return item;
    }
    return null;
}

export async function craftRecipe(bot, itemName, num=1) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    if (mc.getItemCraftingRecipes(itemName).length == 0) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!`);
        return false;
    }

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

            // Try to place crafting table
            let hasTable = world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (hasTable) {
                let pos = world.getNearestFreeSpace(bot, 1, 6);
                await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                if (craftingTable) {
                    recipes = bot.recipesFor(mc.getItemId(itemName), null, 1, craftingTable);
                    placedTable = true;
                }
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
    const craftLimit = mc.calculateLimitingResource(inventory, requiredIngredients);
    
    await bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable);
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

    console.log('smelting...');
    const furnace = await bot.openFurnace(furnaceBlock);
    // check if the furnace is already smelting something
    let input_item = furnace.inputItem();
    if (input_item && input_item.type !== mc.getItemId(itemName) && input_item.count > 0) {
        // TODO: check if furnace is currently burning fuel. furnace.fuel is always null, I think there is a bug.
        // This only checks if the furnace has an input item, but it may not be smelting it and should be cleared.
        log(bot, `The furnace is currently smelting ${mc.getItemName(input_item.type)}.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }
    // check if the bot has enough items to smelt
    let inv_counts = world.getInventoryCounts(bot);
    if (!inv_counts[itemName] || inv_counts[itemName] < num) {
        log(bot, `You do not have enough ${itemName} to smelt.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }

    // fuel the furnace
    if (!furnace.fuelItem()) {
        let fuel = mc.getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        log(bot, `Using ${fuel.name} as fuel.`);

        const put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));

        if (fuel.count < put_fuel) {
            log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${itemName}; you need ${put_fuel}.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
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
    log(bot, `Successfully smelted ${itemName}, got ${total} ${mc.getItemName(smelted_item.type)}.`);
    return true;
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
            lowerShield();

            if (dist < best_dist - 0.5) {
                best_dist = dist;
                last_progress = now;
            }
            if (dist > reach && now - last_progress > 15000) {
                log(bot, `Can't reach ${entity.name}.`);
                return false;
            }

            setMode('chase');
            const cooldown = mc.getAttackCooldown(bot.heldItem?.name) * 1000;
            if (dist <= reach && now - last_attack >= cooldown) {
                // critical hit: attack while falling after a jump. skip it in water/when the target is right on top of us
                const can_crit = bot.entity.onGround && !bot.entity.isInWater && !bot.entity.isInLava && dist > 1.5 && entity.name !== 'creeper';
                if (can_crit) {
                    bot.setControlState('jump', true);
                    await sleep(50);
                    bot.setControlState('jump', false);
                    for (let t = 0; t < 8 && bot.entity.velocity.y > -0.05 && !bot.entity.onGround; t++) await sleep(50);
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
    let prev = null;
    const [from, to, step] = high ? [85, -60, -0.25] : [-60, 60, 0.25];
    for (let deg = from; high ? deg >= to : deg <= to; deg += step) {
        const pitch = deg * Math.PI / 180;
        const res = simulateArrow(pitch, horizontal_dist);
        if (!res) { prev = null; continue; }
        if (res.y >= dy) {
            if (!prev) return {pitch, ticks: res.ticks};
            // interpolate between this and the previous angle
            const f = (dy - prev.y) / (res.y - prev.y);
            return {pitch: prev.pitch + (pitch - prev.pitch) * f, ticks: prev.ticks + (res.ticks - prev.ticks) * f};
        }
        prev = {pitch, y: res.y, ticks: res.ticks};
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
        for (let k = 0; k < 8; k++) {
            h += vh / 8;
            y += vy / 8;
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

async function fireArrowAt(bot, entity, {high=false} = {}) {
    /* Draw the bow fully while tracking the target, then release with gravity and target movement accounted for. */
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
        if (bot.interrupt_code || !isAlive(bot, entity)) {
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
    if (!hasBowAndArrows(bot)) {
        log(bot, `Need a bow and arrows to shoot.`);
        return false;
    }
    bot.pathfinder.stop();
    bot.modes.pause('unstuck');
    for (let shot = 0; shot < maxShots; shot++) {
        if (bot.interrupt_code) return false;
        if (!isAlive(bot, entity)) break;
        if (!hasBowAndArrows(bot)) {
            log(bot, `Ran out of arrows.`);
            break;
        }
        const fired = await fireArrowAt(bot, entity, {high});
        if (!fired) break;
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    // give the last arrow time to land
    for (let t = 0; t < 30 && isAlive(bot, entity); t++) await new Promise(resolve => setTimeout(resolve, 100));
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
    let blocktypes = [blockType];
    if (blockType === 'coal' || blockType === 'diamond' || blockType === 'emerald' || blockType === 'iron' || blockType === 'gold' || blockType === 'lapis_lazuli' || blockType === 'redstone')
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

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks = ['obsidian'];

    for (let i=0; i<num; i++) {
        let blocks = world.getNearestBlocksWhere(bot, block => {
            if (!blocktypes.includes(block.name)) {
                return false;
            }
            if (exclude) {
                for (let position of exclude) {
                    if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) {
                        return false;
                    }
                }
            }
            if (isLiquid) {
                // collect only source blocks
                return block.metadata === 0;
            }
            
            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        }, 64, 1);

        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        const block = blocks[0];
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
        try {
            let success = false;
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else if (mc.mustCollectManually(blockType)) {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                await bot.dig(block);
                await pickupNearbyItems(bot);
                success = true;
            }
            else {
                await bot.collectBlock.collect(block);
                success = true;
            }
            if (success)
                collected++;
            await autoLight(bot);
        }
        catch (err) {
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
        await bot.dig(block, true);
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
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

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
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
        await bot.pathfinder.goto(inverted_goal);
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
        let item = bot.inventory.findInventoryItem(itemName);
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
    let item = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        log(bot, `You do not have any ${itemName} to put in the chest.`);
        return false;
    }
    let to_put = num === -1 ? item.count : Math.min(num, item.count);
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
        item = bot.inventory.findInventoryItem(itemName);
        name = itemName;
    }
    if (!item) {
        log(bot, `You do not have any ${name} to eat.`);
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

    const nonDestructiveMovements = makeMovements(bot, {digCost: 10, placeCost: 2});
    const dontBreakBlocks = ['glass', 'glass_pane'];
    for (let block of dontBreakBlocks) {
        nonDestructiveMovements.blocksCantBreak.add(mc.getBlockId(block));
    }

    const destructiveMovements = makeMovements(bot);

    let final_movements = destructiveMovements;

    const pathfind_timeout = 1000;
    if (await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout).status === 'success') {
        final_movements = nonDestructiveMovements;
        log(bot, `Found non-destructive path.`);
    }
    else if (await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status === 'success') {
        log(bot, `Found destructive path.`);
    }
    else {
        log(bot, `Path not found, but attempting to navigate anyway using destructive movements.`);
    }

    const doorCheckInterval = startDoorInterval(bot);
    // long or complicated paths need more thinking time than the default 5s
    bot.pathfinder.thinkTimeout = 10000;

    const max_attempts = 3;
    try {
        for (let attempt = 1; ; attempt++) {
            bot.pathfinder.setMovements(final_movements);
            try {
                await bot.pathfinder.goto(goal);
                return true;
            } catch (err) {
                // don't retry if we were told to stop, or the goal was swapped out from under us
                const retryable = !bot.interrupt_code && attempt < max_attempts &&
                    !/GoalChanged|interrupt|stopped/i.test(err.name + ' ' + err.message);
                if (!retryable) throw err;
                log(bot, `Pathfinding hiccup (${err.message}), retrying...`);
                // shake loose from whatever we were stuck on, then always allow digging
                bot.clearControlStates();
                bot.setControlState('jump', true);
                await new Promise(resolve => setTimeout(resolve, 400));
                bot.setControlState('jump', false);
                final_movements = destructiveMovements;
            }
        }
    } finally {
        clearInterval(doorCheckInterval);
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
                bot.pathfinder.stop();
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
        block = world.getNearestBlock(bot, blockType, range);
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
    await bot.pathfinder.goto(inverted_goal);
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
    while (enemy) {
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
    bot.pathfinder.stop();
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
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const start_y = Math.floor(bot.entity.position.y);
    const target_y = start_y + height;
    let failures = 0;
    bot.pathfinder.stop();
    while (Math.floor(bot.entity.position.y + 0.01) < target_y) {
        if (bot.interrupt_code) return false;
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
        for (let t = 0; t < 20 && bot.entity.position.y < y0 + 1.0; t++) await sleep(25);
        try {
            await bot.placeBlock(below, new Vec3(0, 1, 0));
        } catch (err) { /* the block often places even when this throws */ }
        bot.setControlState('jump', false);
        for (let t = 0; t < 20 && !bot.entity.onGround; t++) await sleep(50);
        if (Math.floor(bot.entity.position.y + 0.01) > feet.y) failures = 0;
        else failures++;
    }
    log(bot, `Pillared up ${Math.floor(bot.entity.position.y) - start_y} blocks to y=${Math.floor(bot.entity.position.y)}.`);
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
    try {
        const movements = makeMovements(bot, {destructive: false});
        movements.blocksToAvoid.delete(mc.getBlockId(portalType));
        bot.pathfinder.setMovements(movements);
        await bot.pathfinder.goto(new pf.goals.GoalBlock(p.x, p.y, p.z));
    } catch (err) {
        // the pathfinder can be shy about portal blocks, so walk the last bit by hand
        await goToPosition(bot, p.x, p.y, p.z, 1);
        await bot.lookAt(p.offset(0.5, 0.5, 0.5));
        bot.setControlState('forward', true);
        await new Promise(resolve => setTimeout(resolve, 600));
        bot.setControlState('forward', false);
    }

    // nether portals take ~4 seconds of standing still in survival
    const start = Date.now();
    while (Date.now() - start < 15000) {
        if (bot.interrupt_code) return false;
        if (getDimension(bot) !== start_dim) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // let chunks load
            const pos = bot.entity.position.floored();
            log(bot, `Went through the portal, now in the ${getDimension(bot)} at ${pos.x}, ${pos.y}, ${pos.z}.`);
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
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
    bot.pathfinder.stop();
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

function dragonPartPositions(dragon, flip=false) {
    /* Estimate where the head and body parts are, using the same offsets the server uses.
       mineflayer stores yaw as PI - notchian yaw (radians). flip mirrors the estimate in case
       the yaw we see is the other way round from the server's. */
    let yaw = Math.PI - dragon.yaw;
    if (flip) yaw += Math.PI;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const p = dragon.position;
    return {
        head: p.offset(sin * 6.5, 0.5, -cos * 6.5),
        body: p.offset(sin * 0.5, 1.5, -cos * 0.5),
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
        const a1 = bot.blockAt(new Vec3(Math.floor(x), y + 1, Math.floor(z)));
        const a2 = bot.blockAt(new Vec3(Math.floor(x), y + 2, Math.floor(z)));
        if (b && b.boundingBox === 'block' && b.name !== 'bedrock' && isAirLike(a1) && isAirLike(a2)) return y + 1;
    }
    return null;
}

function crystalShotClear(info, crystal, stand, high) {
    /* Trace the arrow from a standing spot to the crystal and check it doesn't clip the pillar's
       top edge or any remaining cage bars on the way. */
    const eye = new Vec3(stand.x, stand.y + 1.52, stand.z);
    const target = crystal.position.offset(0, 1, 0);
    const dist = Math.hypot(target.x - eye.x, target.z - eye.z);
    const sol = solveArrowPitch(dist, target.y - eye.y, high);
    if (!sol) return false;
    const dir_x = (target.x - eye.x) / dist, dir_z = (target.z - eye.z) / dist;
    const edge = info.radius + 0.5;
    const bar_cells = new Set(info.bars.map(b => `${b.position.x},${b.position.y},${b.position.z}`));
    const c = crystal.position;
    for (const {h, y} of arrowPath(sol.pitch, dist + 1.5)) {
        const px = eye.x + dir_x * h, pz = eye.z + dir_z * h, py = eye.y + y;
        // reached the crystal's 2x2x2 hitbox
        if (Math.abs(px - c.x) < 1 && Math.abs(pz - c.z) < 1 && py >= c.y && py <= c.y + 2) return true;
        if (Math.hypot(px - info.center.x, pz - info.center.z) < edge && py < info.top + 0.1) return false;
        if (bar_cells.has(`${Math.floor(px)},${Math.floor(py)},${Math.floor(pz)}`)) return false;
    }
    return false;
}

function planCrystalShot(bot, crystal, info, angles=null) {
    /* Find somewhere on the island to stand where an arrow (flat or lobbed) can reach the crystal. */
    const to_center = Math.atan2(-info.center.z, -info.center.x); // pillars ring the island, aim back inward
    const base_angles = angles ?? [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05].map(a => to_center + a);
    const options = [];
    for (const angle of base_angles) {
        for (let dist = 14; dist <= 70; dist += 4) {
            const x = info.center.x + Math.cos(angle) * dist;
            const z = info.center.z + Math.sin(angle) * dist;
            const y = groundAt(bot, x, z, info.top - 2);
            if (y === null || y < 40) continue; // no island here
            for (const high of [false, true]) {
                if (crystalShotClear(info, crystal, {x, y, z}, high)) {
                    const cost = Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z) + (high ? 10 : 0);
                    options.push({x, y, z, high, cost});
                    break;
                }
            }
        }
    }
    options.sort((a, b) => a.cost - b.cost);
    return options[0] ?? null;
}

async function shootCrystal(bot, crystal, angles=null) {
    const info = getPillarInfo(bot, crystal);
    const plan = planCrystalShot(bot, crystal, info, angles);
    if (!plan) {
        log(bot, `Couldn't find a spot with a clear shot at the crystal at ${crystal.position.floored()}.`);
        return false;
    }
    try {
        await goToGoal(bot, new pf.goals.GoalNear(plan.x, plan.y, plan.z, 1.5));
    } catch (err) { /* try from wherever we got to */ }
    if (bot.interrupt_code || !isAlive(bot, crystal)) return !isAlive(bot, crystal);
    // re-check the arc from where we actually ended up
    const here = bot.entity.position;
    const high = crystalShotClear(info, crystal, here, false) ? false : plan.high;
    return await shootEntity(bot, crystal, 6, high);
}

async function openCrystalCage(bot, crystal) {
    /* Tower up beside the pillar, break the iron bars facing us, then dig back down.
       Returns the direction (angle) of the opening so we can shoot through it from the ground. */
    const info = getPillarInfo(bot, crystal);
    if (info.bars.length === 0) return null;
    if (!getScaffoldItem(bot)) {
        log(bot, `Need blocks (cobblestone, end_stone...) to tower up to the caged crystal.`);
        return null;
    }
    const angle = Math.atan2(-info.center.z, -info.center.x); // the island side of the pillar
    const bx = info.center.x + Math.cos(angle) * (info.radius + 1.2);
    const bz = info.center.z + Math.sin(angle) * (info.radius + 1.2);
    const by = groundAt(bot, bx, bz, info.top - 2);
    if (by === null) {
        log(bot, `No ground next to the pillar to build up from.`);
        return null;
    }
    log(bot, `Crystal at ${crystal.position.floored()} is caged. Towering up to break the bars.`);
    const reached = await goToPosition(bot, Math.floor(bx) + 0.5, by, Math.floor(bz) + 0.5, 0.5);
    if (!reached || bot.interrupt_code) return null;
    const start_y = Math.floor(bot.entity.position.y);
    // feet level with the crystal's base puts our eyes level with the bars
    if (!(await pillarUp(bot, info.top + 1 - start_y))) return null;

    const eye = () => bot.entity.position.offset(0, 1.62, 0);
    const reachable = getPillarInfo(bot, crystal).bars
        .filter(b => eye().distanceTo(b.position.offset(0.5, 0.5, 0.5)) < 4.5)
        .sort((a, b) => eye().distanceTo(a.position) - eye().distanceTo(b.position));
    let broken = 0;
    for (const bar of reachable) {
        if (bot.interrupt_code) return null;
        if (bot.blockAt(bar.position)?.name !== 'iron_bars') continue;
        if (await breakBlockAt(bot, bar.position.x, bar.position.y, bar.position.z)) broken++;
    }
    log(bot, `Broke ${broken} iron bars. Climbing back down before shooting, crystals explode.`);
    await digDown(bot, Math.floor(bot.entity.position.y) - start_y);
    return broken > 0 ? angle : null;
}

export async function fightEnderDragon(bot) {
    /**
     * Fight the ender dragon in the end: shoot down the end crystals with a bow, then attack the dragon when it perches on the portal fountain and shoot it while it flies. Bring a bow, lots of arrows, blocks, food, and armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the dragon was killed, false otherwise.
     * @example
     * await skills.fightEnderDragon(bot);
     **/
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

    // 1. get onto the main island. we may spawn on the obsidian platform out over the void
    const to_center = Math.hypot(bot.entity.position.x, bot.entity.position.z);
    if (to_center > 40) {
        log(bot, `Heading to the main island.`);
        if (!getScaffoldItem(bot)) log(bot, `Warning: no blocks to bridge with.`);
        await travelTo(bot, 0, 0, 30);
        if (bot.interrupt_code) return false;
    }
    const portal_y = findExitPortalTop(bot) ?? 64;

    // 2. destroy the end crystals, they heal the dragon. caged ones get their bars broken first
    const given_up = new Set();
    const cage_opened = new Map(); // crystal id -> angle of the gap we made
    for (let round = 0; round < 30; round++) {
        if (bot.interrupt_code) return false;
        const crystals = Object.values(bot.entities)
            .filter(e => e.name === 'end_crystal' && !given_up.has(e.id) && Math.hypot(e.position.x, e.position.z) < 80)
            .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
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
            angles = [a, a + 0.15, a - 0.15];
        }
        else if (info.bars.length > 0 && !planCrystalShot(bot, crystal, info)) {
            const gap = await openCrystalCage(bot, crystal);
            if (gap === null) {
                log(bot, `Couldn't open the cage around the crystal at ${crystal.position.floored()}.`);
                given_up.add(crystal.id);
                continue;
            }
            cage_opened.set(crystal.id, gap);
            continue;
        }
        const destroyed = await shootCrystal(bot, crystal, angles);
        if (!destroyed && isAlive(bot, crystal)) {
            log(bot, `Missed the crystal at ${crystal.position.floored()} too many times, moving on.`);
            given_up.add(crystal.id);
        }
    }
    if (given_up.size > 0)
        log(bot, `${given_up.size} crystals are still up. The dragon can still be killed but will heal near them.`);

    // 3. fight the dragon
    const start = Date.now();
    let last_attack = 0;
    let last_shot = 0;
    let flip_yaw = false;
    let missed_head_hits = 0;
    let last_seen = Date.now();
    let last_approach = 0;
    let last_health = null;
    let last_status = 0;
    while (Date.now() - start < 15 * 60 * 1000) {
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
            if (Math.hypot(bot.entity.position.x, bot.entity.position.z) > 30) {
                try { await goToGoal(bot, new pf.goals.GoalNearXZ(8, 8, 3)); } catch (err) { /* keep looking */ }
            }
            continue;
        }
        last_seen = Date.now();

        // dodge dragon's breath
        const breath = world.getNearestEntityWhere(bot, e => e.name === 'area_effect_cloud', 5);
        if (breath) {
            bot.pathfinder.setMovements(makeMovements(bot, {destructive: false}));
            bot.pathfinder.setGoal(new pf.goals.GoalInvert(new pf.goals.GoalFollow(breath, 7)), true);
            await sleep(500);
            continue;
        }

        const health = getEntityHealth(dragon);
        if (Date.now() - last_status > 20000 && health !== null) {
            log(bot, `Dragon health: ${Math.round(health)}/200.`);
            last_status = Date.now();
        }
        const d_center = Math.hypot(dragon.position.x, dragon.position.z);
        const perched = d_center < 10 && dragon.position.y < portal_y + 8;
        const dist = bot.entity.position.distanceTo(dragon.position);

        if (perched) {
            // go stand by its head (the only part that takes full damage) and hit it
            const parts = dragonPartPositions(dragon, flip_yaw);
            const eye = bot.entity.position.offset(0, 1.62, 0);
            const head_dist = eye.distanceTo(parts.head);
            if (head_dist > 3.5 && Date.now() - last_approach > 1000) {
                bot.pathfinder.setMovements(makeMovements(bot, {destructive: false}));
                bot.pathfinder.setGoal(new pf.goals.GoalNear(parts.head.x, portal_y + 1, parts.head.z, 2));
                last_approach = Date.now();
            }
            else if (head_dist <= 3.5) {
                bot.pathfinder.setGoal(null);
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
            // it's flying: shoot it if we can, otherwise wait near (not on) the fountain for it to land
            bot.pathfinder.setGoal(null);
            if (hasBowAndArrows(bot) && dist < 70 && Date.now() - last_shot > 1500) {
                await fireArrowAt(bot, dragon);
                last_shot = Date.now();
            }
            else if (Math.hypot(bot.entity.position.x, bot.entity.position.z) > 14) {
                try {
                    await goToGoal(bot, new pf.goals.GoalNearXZ(8, 8, 3));
                } catch (err) { /* keep fighting */ }
            }
        }
        await sleep(100);
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
