import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { getCommandDocs } from './index.js';
import convoManager from '../conversation.js';
import { checkLevelBlueprint, checkBlueprint } from '../tasks/construction_tasks.js';
import { load } from 'cheerio';

const pad = (str) => {
    return '\n' + str + '\n';
}

// queries are commands that just return strings and don't affect anything in the world
export const queryList = [
    {
        name: "!stats",
        description: "Get your bot's location, health, hunger, and time of day.", 
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'STATS';
            let pos = bot.entity.position;
            // display position to 2 decimal places
            res += `\n- Position: x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`;
            res += `\n- Dimension: ${(bot.game.dimension || 'overworld').replace('minecraft:', '')}`;
            // Gameplay
            res += `\n- Gamemode: ${bot.game.gameMode}`;
            res += `\n- Health: ${Math.round(bot.health)} / 20`;
            res += `\n- Hunger: ${Math.round(bot.food)} / 20`;
            res += `\n- Biome: ${world.getBiomeName(bot)}`;
            let weather = "Clear";
            if (bot.rainState > 0)
                weather = "Rain";
            if (bot.thunderState > 0)
                weather = "Thunderstorm";
            res += `\n- Weather: ${weather}`;
            // let block = bot.blockAt(pos);
            // res += `\n- Artficial light: ${block.skyLight}`;
            // res += `\n- Sky light: ${block.light}`;
            // light properties are bugged, they are not accurate


            if (bot.time.timeOfDay < 6000) {
                res += '\n- Time: Morning';
            } else if (bot.time.timeOfDay < 12000) {
                res += '\n- Time: Afternoon';
            } else {
                res += '\n- Time: Night';
            }

            // get the bot's current action
            let action = agent.actions.currentActionLabel;
            if (agent.isIdle())
                action = 'Idle';
            res += `\- Current Action: ${action}`;


            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            res += '\n- Nearby Human Players: ' + (players.length > 0 ? players.join(', ') : 'None.');
            res += '\n- Nearby Bot Players: ' + (bots.length > 0 ? bots.join(', ') : 'None.');

            res += '\n' + agent.bot.modes.getMiniDocs() + '\n';
            return pad(res);
        }
    },
    {
        name: "!gameProgress",
        description: "Get a checklist of progress towards beating the game (killing the ender dragon) and the recommended next step.",
        perform: function (agent) {
            return pad(getGameProgress(agent.bot));
        }
    },
    {
        name: "!inventory",
        description: "Get your bot's inventory.",
        perform: function (agent) {
            let bot = agent.bot;
            let inventory = world.getInventoryCounts(bot);
            let res = 'INVENTORY';
            for (const item in inventory) {
                if (inventory[item] && inventory[item] > 0)
                    res += `\n- ${item}: ${inventory[item]}`;
            }
            if (res === 'INVENTORY') {
                res += ': Nothing';
            }
            else if (agent.bot.game.gameMode === 'creative') {
                res += '\n(You have infinite items in creative mode. You do not need to gather resources!!)';
            }

            let helmet = bot.inventory.slots[5];
            let chestplate = bot.inventory.slots[6];
            let leggings = bot.inventory.slots[7];
            let boots = bot.inventory.slots[8];
            res += '\nWEARING: ';
            if (helmet)
                res += `\nHead: ${helmet.name}`;
            if (chestplate)
                res += `\nTorso: ${chestplate.name}`;
            if (leggings)
                res += `\nLegs: ${leggings.name}`;
            if (boots)
                res += `\nFeet: ${boots.name}`;
            if (!helmet && !chestplate && !leggings && !boots)
                res += 'Nothing';

            return pad(res);
        }
    },
    {
        name: "!nearbyBlocks",
        description: "Get the blocks near the bot.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_BLOCKS';
            let blocks = world.getNearestBlocks(bot);
            let block_details = new Set();
            
            for (let block of blocks) {
                let details = block.name;
                if (block.name === 'water' || block.name === 'lava') {
                    details += block.metadata === 0 ? ' (source)' : ' (flowing)';
                }
                block_details.add(details);
            }
            for (let details of block_details) {
                res += `\n- ${details}`;
            }
            if (block_details.size === 0) {
                res += ': none';
            } 
            else {
                res += '\n- ' + world.getSurroundingBlocks(bot).join('\n- ');
                res += `\n- First Solid Block Above Head: ${world.getFirstBlockAboveHead(bot, null, 32)}`;
            }
            return pad(res);
        }
    },
    {
        name: "!craftable",
        description: "Get the craftable items with the bot's inventory.",
        perform: function (agent) {
            let craftable = world.getCraftableItems(agent.bot);
            let res = 'CRAFTABLE_ITEMS';
            for (const item of craftable) {
                res += `\n- ${item}`;
            }
            if (res == 'CRAFTABLE_ITEMS') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!entities",
        description: "Get the nearby players and entities.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_ENTITIES';
            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            for (const player of players) {
                res += `\n- Human player: ${player}`;
            }
            for (const bot of bots) {
                res += `\n- Bot player: ${bot}`;
            }

            let nearbyEntities = world.getNearbyEntities(bot);
            let entityCounts = {};
            let villagerIds = [];
            let babyVillagerIds = [];
            let villagerDetails = []; // Store detailed villager info including profession
            
            for (const entity of nearbyEntities) {
                if (entity.type === 'player' || entity.name === 'item')
                    continue;
                    
                if (!entityCounts[entity.name]) {
                    entityCounts[entity.name] = 0;
                }
                entityCounts[entity.name]++;
                
                if (entity.name === 'villager') {
                    if (entity.metadata && entity.metadata[16] === 1) {
                        babyVillagerIds.push(entity.id);
                    } else {
                        const profession = world.getVillagerProfession(entity);
                        villagerIds.push(entity.id);
                        villagerDetails.push({
                            id: entity.id,
                            profession: profession
                        });
                    }
                }
            }
            
            for (const [entityType, count] of Object.entries(entityCounts)) {
                if (entityType === 'villager') {
                    let villagerInfo = `${count} ${entityType}(s)`;
                    if (villagerDetails.length > 0) {
                        const detailStrings = villagerDetails.map(v => `(${v.id}:${v.profession})`);
                        villagerInfo += ` - Adults: ${detailStrings.join(', ')}`;
                    }
                    if (babyVillagerIds.length > 0) {
                        villagerInfo += ` - Baby IDs: ${babyVillagerIds.join(', ')} (babies cannot trade)`;
                    }
                    res += `\n- entities: ${villagerInfo}`;
                } else {
                    res += `\n- entities: ${count} ${entityType}(s)`;
                }
            }
            
            if (res == 'NEARBY_ENTITIES') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!modes",
        description: "Get all available modes and their docs and see which are on/off.",
        perform: function (agent) {
            return agent.bot.modes.getDocs();
        }
    },
    {
        name: '!savedPlaces',
        description: 'List all saved locations.',
        perform: async function (agent) {
            return "Saved place names: " + agent.memory_bank.getKeys();
        }
    }, 
    {
        name: '!checkBlueprintLevel',
        description: 'Check if the level is complete and what blocks still need to be placed for the blueprint',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = checkLevelBlueprint(agent, levelNum);
            console.log(res);
            return pad(res);
        }
    }, 
    {
        name: '!checkBlueprint',
        description: 'Check what blocks still need to be placed for the blueprint',
        perform: function (agent) {
            let res = checkBlueprint(agent);
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprint',
        description: 'Get the blueprint for the building',
        perform: function (agent) {
            let res = agent.task.blueprint.explain();
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprintLevel',
        description: 'Get the blueprint for the building',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = agent.task.blueprint.explainLevel(levelNum);
            console.log(res);
            return pad(res);
        }
    },
    {
        name: '!getCraftingPlan',
        description: "Provides a comprehensive crafting plan for a specified item. This includes a breakdown of required ingredients, the exact quantities needed, and an analysis of missing ingredients or extra items needed based on the bot's current inventory.",
        params: {
            targetItem: { 
                type: 'string', 
                description: 'The item that we are trying to craft' 
            },
            quantity: { 
                type: 'int',
                description: 'The quantity of the item that we are trying to craft',
                optional: true,
                domain: [1, Infinity, '[)'], // Quantity must be at least 1,
                default: 1
            }
        },
        perform: function (agent, targetItem, quantity = 1) {
            let bot = agent.bot;

            // Fetch the bot's inventory
            const curr_inventory = world.getInventoryCounts(bot); 
            const target_item = targetItem;
            let existingCount = curr_inventory[target_item] || 0;
            let prefixMessage = '';
            if (existingCount > 0) {
                curr_inventory[target_item] -= existingCount;
                prefixMessage = `You already have ${existingCount} ${target_item} in your inventory. If you need to craft more,\n`;
            }

            // Generate crafting plan
            try {
                let craftingPlan = mc.getDetailedCraftingPlan(target_item, quantity, curr_inventory);
                craftingPlan = prefixMessage + craftingPlan;
                return pad(craftingPlan);
            } catch (error) {
                console.error("Error generating crafting plan:", error);
                return `An error occurred while generating the crafting plan: ${error.message}`;
            }
            
            
        },
    },
    {
        name: '!searchWiki',
        description: 'Search the Minecraft Wiki for the given query.',
        params: {
            'query': { type: 'string', description: 'The query to search for.' }
        },
        perform: async function (agent, query) {
            const url = `https://minecraft.wiki/w/${query}`
            try {
                const response = await fetch(url);
                if (response.status === 404) {
                  return `${query} was not found on the Minecraft Wiki. Try adjusting your search term.`;
                }
                const html = await response.text();
                const $ = load(html);
            
                const parserOutput = $("div.mw-parser-output");
                
                parserOutput.find("table.navbox").remove();

                const divContent = parserOutput.text();
            
                return divContent.trim();
              } catch (error) {
                console.error("Error fetching or parsing HTML:", error);
                return `The following error occurred: ${error}`
              }
        }
    },
    {
        name: '!help',
        description: 'Lists all available commands and their descriptions.',
        perform: async function (agent) {
            return getCommandDocs(agent);
        }
    },
];

export function getScriptedStage(bot) {
    // the scripted stretch of a speedrun (speedrunOpening, speedrunKit or speedrunNether) that the next step is, if any
    // and it hasn't just stopped short: told to use it, the model still mined iron and gold by hand for 10 minutes
    getGameProgress(bot);
    return bot.next_stage;
}

export function getNextStepHint(bot) {
    // the next step (and food note) from !gameProgress, added to command results so the model doesn't have to spend
    // a turn on !gameProgress after every command
    return getGameProgress(bot).split('\n').filter(line => line.startsWith('Next step:') || line.startsWith('Food:') || line.startsWith('Keep about')).join('\n');
}

function getGameProgress(bot) {
    const inv = world.getInventoryCounts(bot);
    // ingots left smelting in a furnace count as had: crafting fetches them (skills.collectBackgroundSmelt)
    if (bot.background_smelt)
        inv[bot.background_smelt.output] = (inv[bot.background_smelt.output] || 0) + bot.background_smelt.expected;
    const has = (name, n = 1) => (inv[name] || 0) >= n;
    const count = (name) => inv[name] || 0;
    const any = (...names) => names.some(n => has(n));
    const dimension = (bot.game.dimension || 'overworld').replace('minecraft:', '');
    const armor = bot.inventory.slots.slice(5, 9).filter(Boolean).map(i => i.name);

    // how many items the fuel we carry can smelt, using the best single fuel (a furnace burns one kind at a time)
    const fuel_smelts = Math.floor(Math.max(0, ...Object.entries(inv).map(([name, c]) => c * mc.getFuelSmeltOutput(name))));

    // eyes of ender we have or can make right now
    const eyes = count('ender_eye');
    const eye_potential = eyes + Math.min(count('ender_pearl'), count('blaze_powder') + count('blaze_rod') * 2);

    // what casting a nether portal still needs (see skills.castNetherPortal), and whether one is already built here
    const buckets = count('bucket') + count('water_bucket') + count('lava_bucket');
    const blocks = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'basalt', 'end_stone', 'sandstone'].reduce((n, name) => n + count(name), 0);
    const portal_kit = [];
    if (buckets < 2) portal_kit.push(`${2 - buckets} more bucket(s) (3 iron_ingot each)`);
    if (!has('water_bucket')) portal_kit.push('a water_bucket: fill an empty bucket at any water with !useOn("bucket", "water")');
    if (!any('flint_and_steel', 'fire_charge')) portal_kit.push(has('flint')
        ? 'flint_and_steel: !craftRecipe("flint_and_steel", 1)'
        : 'flint_and_steel (1 iron_ingot and 1 flint: !collectBlocks("gravel", 8) until flint drops)');
    if (blocks < 36) portal_kit.push(`${36 - blocks} more cobblestone`);
    // piglins leave you alone if you wear any gold armor: speedrunners wear golden boots, the cheapest piece
    const gold_armor = ['golden_boots', 'golden_helmet', 'golden_leggings', 'golden_chestplate'];
    const has_gold_armor = armor.some(a => gold_armor.includes(a)) || any(...gold_armor);
    // only wanted past the nether (see skills.speedrunKit): asked for, the model went off mining gold
    if (!has_gold_armor && process.env.MINDCRAFT_NETHER_ONLY !== '1') {
        const gold = count('gold_ingot') + count('raw_gold');
        portal_kit.push(gold >= 4
            ? `golden_boots: ${count('raw_gold') > 0 ? 'smelt your raw_gold, then ' : ''}!craftRecipe("golden_boots", 1). You put them on automatically, and piglins in the nether won't attack you while you wear gold`
            : `golden_boots, so piglins in the nether don't attack you: 4 gold_ingot (you have ${gold}). !collectBlocks("gold_ore", ${4 - gold}) while you're mining at iron depth (y=0 to 30), then smelt the raw_gold with the iron`);
    }
    const portal_near = dimension === 'overworld' && !!world.getNearestBlock(bot, 'nether_portal', 24);
    // a portal already built here stands in for the kit, but only with the gear: later steps tick off the earlier ones,
    // and a bot that started a run next to an old portal walked into the nether empty-handed
    const geared = any('iron_sword', 'diamond_sword', 'netherite_sword') && has('shield') && armor.length >= 1;

    // the wood to start the run with, only looked up while it's needed
    const findLog = () => world.getNearestBlocksWhere(bot, b => b.name.endsWith('_log') && !b.name.startsWith('stripped'), 64, 1)[0]?.name;
    const nearest_log = any('stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe', 'wooden_pickaxe') ? null : findLog();
    // planks we have or can make from the logs we carry, any wood
    const planks = Object.entries(inv).reduce((n, [name, c]) => n + (name.endsWith('_planks') ? c : name.endsWith('_log') ? 4 * c : 0), 0);

    const steps = [
        {done: any('stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'), text: 'Stone tools',
            // pick up from where we are, so a re-read doesn't send the bot back for logs it already turned into a pickaxe
            // craftRecipe makes the planks, sticks and crafting table a recipe needs, so one command does each tool
            next: count('cobblestone') >= 3
                ? `You have ${count('cobblestone')} cobblestone: !craftRecipe("stone_pickaxe", 1) now, then a stone_sword (2) and, with 8 more, a furnace.`
                : has('wooden_pickaxe')
                // only 3: one run mined all 16 with the slow wooden pickaxe first; the rest comes faster with stone
                ? 'You have a wooden_pickaxe: !collectBlocks("stone", 3) now, nothing more, then !craftRecipe("stone_pickaxe", 1) straight away.'
                // name the wood that's actually here: told "logs", the model asked for oak_log in a spruce forest,
                // found none, and wandered off exploring
                : nearest_log
                // 3 logs are 12 planks: the table, sticks, the wooden pickaxe, and later the stone pickaxe and sword
                ? `Collect 3 logs with !collectBlocks("${nearest_log}", 3) (the nearest trees here), then !craftRecipe("wooden_pickaxe", 1): it makes the planks, sticks and crafting table it needs by itself.`
                : 'There are no trees nearby: !explore(100) to find some, then collect 3 logs and !craftRecipe("wooden_pickaxe", 1).'},
        {done: any('iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'), text: 'Iron pickaxe',
            next: count('iron_ingot') >= 3
                ? 'You have iron_ingot: craft the iron_pickaxe now.'
                : count('raw_iron') + count('iron_ingot') >= 3
                // say how far the fuel goes: short of fuel for all of it, the bot went back to the surface for logs
                // at night instead of smelting the 3 it needed for the pickaxe
                ? (fuel_smelts >= 3
                    ? `Smelt your raw_iron now with !smeltItem("raw_iron", ${Math.min(count('raw_iron'), fuel_smelts)}) (your fuel covers ${fuel_smelts}), then craft the iron_pickaxe.`
                    : 'You need fuel to smelt your raw_iron: mine coal_ore nearby (8 smelts each), or turn logs into planks. Then smelt and craft the iron_pickaxe.')
                // say exactly how: "or explore caves" sent the bot wandering the surface instead of digging
                // iron is at every height, and the nearest is usually close (a cave wall, just under the surface):
                // collecting it digs its own way there, which beats a long staircase to y=16 first
                // just 3 first: the pickaxe as soon as possible (a run resets if it has none by 5 minutes), the rest
                // gets mined afterwards with it while the first ingots smelt
                : '!collectBlocks("iron_ore", 3) to mine the nearest iron, even if it is in a cave or under the ground: it digs its way there. ' +
                  (bot.entity.position.y > 24 ? `Only if it finds none, dig down to y=16 where iron is common with !digDown(${Math.round(bot.entity.position.y - 16)}) and try again. ` : '') +
                  'Only 3 for now: smelt them and craft the iron_pickaxe straight away, then mine the rest of the iron (12 more) with it. Grab coal you pass for fuel.'},
        // a speedrun only needs a chestplate: the most protection for the iron, and leggings cost another trip
        {done: any('iron_sword', 'diamond_sword', 'netherite_sword') && has('shield') && armor.length >= 1, text: 'Sword, shield and a chestplate',
            // only what's still missing: the same advice every time had the bot craft 4 shields and 2 swords
            next: (() => {
                const have_shield = has('shield') || bot.inventory.slots[45]?.name === 'shield';
                const have_sword = any('iron_sword', 'diamond_sword', 'netherite_sword');
                const todo = [];
                if (!have_shield) {
                    // the model went looking for oaks among birches, so name the wood that's here
                    const log = planks < 6 ? findLog() : null;
                    todo.push('a shield (1 iron_ingot, 6 planks of any wood: you block with it in fights' +
                        (planks >= 6 ? ')' : log ? `; for the planks, !collectBlocks("${log}", 2) from the trees nearby)` : '; you need 2 logs of any wood for the planks)'));
                }
                if (!have_sword) todo.push('an iron_sword (2 iron_ingot)');
                if (armor.length < 1) todo.push('an iron_chestplate (8 iron_ingot), then put it on with !equip("iron_chestplate")');
                const iron_needed = (have_shield ? 0 : 1) + (have_sword ? 0 : 2) + (armor.length < 1 ? 8 : 0);
                const iron_have = count('iron_ingot') + count('raw_iron');
                const owned = [have_shield && 'a shield', have_sword && 'an iron_sword'].filter(Boolean);
                // fuel for the iron still to smelt: with no coal, smelting burned the wood the shield and sticks need
                const to_smelt = count('raw_iron') + Math.max(0, iron_needed - iron_have);
                const coal_smelts = 8 * (count('coal') + count('charcoal')) + 80 * count('coal_block');
                const coal_note = to_smelt > coal_smelts
                    ? ` Mine ${Math.ceil((to_smelt - coal_smelts) / 8)} coal_ore too, for fuel (each smelts 8): keep your wood for the shield and sticks.`
                    : '';
                return (owned.length ? `You already have ${owned.join(' and ')}: don't craft another. ` : '') +
                    `Still need ${todo.join(', ')}. ` +
                    (iron_have >= iron_needed
                        ? `You have enough iron (${iron_have}): ${count('raw_iron') > 0 ? 'smelt the raw_iron and ' : ''}craft them.`
                        : `That takes ${iron_needed} iron and you have ${iron_have}: mine ${iron_needed - iron_have} more iron_ore in one trip, then smelt it all at once.`) +
                    coal_note;
            })()},
        // no diamonds: the portal's obsidian frame is cast in place from lava and water, the way speedrunners do it
        {done: portal_kit.length === 0 || (portal_near && geared && has_gold_armor) || dimension !== 'overworld' || eyes > 0, text: `Portal kit (2 buckets, flint_and_steel, 36 cobblestone${process.env.MINDCRAFT_NETHER_ONLY === '1' ? '' : ', golden boots'})`,
            next: `To cast a nether portal without diamonds you still need: ${portal_kit.join('; ')}. Get it all in one trip.`},
        {done: count('blaze_rod') + count('blaze_powder') / 2 >= 6 || eye_potential >= 12, text: 'Blaze rods (6+)',
            next: dimension === 'the_nether'
                ? 'Use !collectBlazeRods(7). It finds a fortress and kills blazes; bring armor, food, and a bow if you have one.'
                : portal_near
                ? 'Your portal is here: !enterPortal nether_portal, then !collectBlazeRods(7).'
                : 'Find lava with !searchForBlock("lava", 128) (surface lava pools, or caves deep down near y=-54), then !castNetherPortal next to it: ' +
                  'it casts the obsidian frame from lava and water and lights it, no diamonds needed. Then !enterPortal nether_portal, find a fortress and kill blazes.'},
        {done: eye_potential >= 12 || count('ender_pearl') >= 12, text: 'Ender pearls (12)',
            next: 'Use !collectEnderPearls(12). Endermen are common at night in the overworld and in warped forests in the nether.'},
        {done: eyes >= 12, text: '12 eyes of ender',
            next: 'Craft blaze_powder from blaze_rod, then craft ender_eye from ender_pearl and blaze_powder until you have 12.'},
        // only the dragon fight needs a bow (to shoot the end crystals), so get it last instead of holding the run up early
        {done: has('bow') && count('arrow') >= 16, text: 'Bow and arrows',
            next: 'For the dragon fight: craft a bow (3 sticks, 3 string from spiders) and 16+ arrows (flint, stick, feather from chickens), or take them from skeletons you kill.'},
        {done: dimension === 'the_end', text: 'Find the stronghold and open the end portal',
            next: dimension === 'the_nether'
                ? 'Go back to the overworld through your portal (!enterPortal nether_portal).'
                : 'Use !goToStronghold, then !activateEndPortal. Before entering, stock up: bow, 64 arrows, 64 cobblestone, food, iron armor, sword. Then !enterPortal end_portal.'},
        {done: false, text: 'Kill the ender dragon',
            next: 'Use !fightEnderDragon. When it dies, !enterPortal end_portal to finish the game.'},
    ];

    // later milestones imply the earlier ones (no need for a pickaxe once you hold 12 eyes)
    for (let i = steps.length - 2; i >= 0; i--) {
        if (steps[i + 1].done) steps[i].done = true;
    }

    // staying alive comes before the next milestone: health only regenerates with 18+ hunger, and a death loses everything
    const banned = bot.autoEat?.options?.bannedFood || [];
    const food = Object.entries(inv).filter(([name]) => bot.registry.foodsByName[name] && !banned.includes(name))
        .reduce((n, [, c]) => n + c, 0);
    const raw_meat = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon'].filter(name => has(name));
    const night = bot.time.timeOfDay >= 13000 && bot.time.timeOfDay < 23000;
    const has_sword = any('stone_sword', 'iron_sword', 'diamond_sword', 'netherite_sword');
    let survival = null;
    let night_note = null; // underground at night, where the scripted stretches still work
    // things worth mining while sheltering underground at night, by how far along we are
    const next_underground = !steps[1].done ? '!collectBlocks("iron_ore", 3) for the iron_pickaxe, and some coal_ore'
        : !steps[3].done ? 'iron_ore, gold_ore (for golden boots), coal_ore and gravel (for flint), and look for lava to cast the portal'
        : 'coal_ore and cobblestone';
    // the blocks above, not the sky light at our feet: that read 0 out in the open, so the bot always seemed underground
    const on_surface = world.isOpenToSky(bot, bot.entity.position);
    // food only comes first when it's actually needed: getting hungry, or hurt with nothing to eat. sending a well-fed
    // bot off to find cows wasted minutes exploring, and pulled it through water
    const need_food = food < 4 && (bot.food <= 12 || (bot.health < 14 && bot.food < 18));
    if (dimension === 'overworld' && night && on_surface && !steps[2].done) {
        // a bot without armor on the surface at night keeps dying to zombies, skeletons and creepers (night falls about
        // 10 minutes into a fresh run). underground it's safe, and the iron and lava it needs next are down there
        survival = (has_sword ? '' : 'Craft a stone_sword first if you can (2 cobblestone, 1 stick). ') +
            'It\'s night and mobs are out: get off the surface. Dig down with !digDown(10) and mine underground (iron_ore, coal_ore, gravel for flint; lava pools for the portal are deeper) until morning.';
    }
    else if (dimension === 'overworld' && night && !on_surface) {
        // the night_shelter mode digs the bot in at dusk; keep it below ground doing what can be done there
        const mins = Math.ceil((24000 - bot.time.timeOfDay) / 20 / 60);
        night_note = `It's night (about ${mins} more minutes): stay underground, don't go up to the surface. `;
        survival = `It's night (about ${mins} more minutes): stay underground, don't go up to the surface. ` +
            (!has_sword && steps[0].done ? 'Craft a stone_sword first (2 cobblestone, 1 stick). ' : '') +
            `Meanwhile do the next step if it can be done down here, or mine what you'll need: ${next_underground}.`;
    }
    else if (dimension === 'overworld' && steps[0].done && !has_sword && !steps[2].done) {
        // the mining for iron happens in caves full of zombies, and a pickaxe is a poor weapon: one run died to the
        // first few with full health. a stone sword is a few seconds' work
        survival = `You have no sword: !craftRecipe("stone_sword", 1) now (2 cobblestone, 1 stick)${count('cobblestone') >= 2 ? '' : ' after mining 2 cobblestone'}, before you go into caves for iron.`;
    }
    else if (dimension === 'overworld' && steps[0].done && need_food) {
        if (raw_meat.length > 0)
            survival = `You're low on food: cook your raw meat with !smeltItem("${raw_meat[0]}", ${count(raw_meat[0])}) (needs a furnace, 8 cobblestone, and fuel).`;
        else
            survival = 'You\'re low on food: kill a few animals nearby with !attack (cow, pig, sheep or chicken), then cook the meat with !smeltItem.';
    }

    let res = 'GAME PROGRESS (goal: kill the ender dragon)';
    res += `\n- Dimension: ${dimension}${night ? ' (night)' : ''}`;
    res += `\n- Health ${Math.round(bot.health)}/20, hunger ${bot.food}/20, food items: ${food}`;
    for (const step of steps) {
        res += `\n- [${step.done ? 'x' : ' '}] ${step.text}`;
    }
    // once in the end, the dragon is the only thing that matters
    const next = dimension === 'the_end' ? steps[steps.length - 1] : steps.find(s => !s.done);
    // the scripted stretches do these steps without a turn per craft (after a death, or one that stopped early). given
    // the steps by hand as well, the model followed those instead (searching for iron 7 at a time), so they only show
    // when the scripted one has just been tried and stopped short
    // in the nether, the blaze rods: the model, told to use !collectBlazeRods, searched for blazes by hand 3 times in a
    // fortress and gave up on it
    const stage = dimension === 'the_nether' ? (next.text.startsWith('Blaze rods') ? ['collectBlazeRods(7)', 'Use !collectBlazeRods(7) now: it finds a fortress and its blaze spawner and kills blazes.'] : null)
        : dimension !== 'overworld' ? null
        : next === steps[0] || next === steps[1] ? ['speedrunOpening', 'Use !speedrunOpening now: it gets the wood, stone tools, furnace and iron pickaxe in one go.']
        // with the buckets and flint_and_steel, !speedrunNether fills the water and gets the cobblestone itself: told to
        // finish the kit first, the model went looking for lava step by step
        // and with part of the gear too: a kit a plank short of the shield, down a mine, had the model hunting for trees
        // with everything for the portal in its pockets
        : (next === steps[3] || next === steps[4] || (next === steps[2] && (any('iron_sword', 'diamond_sword') || armor.length >= 1))) &&
            !portal_near && buckets >= 2 && any('flint_and_steel', 'fire_charge')
            ? ['speedrunNether', 'Use !speedrunNether now: it fills the water bucket, finds a lava pool, casts the portal and goes through, all in one go.']
        : next === steps[2] || next === steps[3] ? ['speedrunKit', 'Use !speedrunKit now: it mines the iron, gold and gravel and makes the sword, shield, chestplate, buckets and flint_and_steel in one go.']
        : null;
    const tried = stage && Date.now() - (bot.stage_tries?.[stage[0]] || 0) < 3 * 60000;
    const step = !stage ? next.next : tried ? `!${stage[0]} stopped short just now, so by hand: ${next.next}` : stage[1];
    // at night underground the scripted stretches still work (they mine down there): told to mine what it'll need
    // instead, the model mined iron and gold by hand, a few at a time
    // and the opening even at night with nothing: after a death at night, told to dig down and hide, the model tried to
    // with no pickaxe at all (on easy, the opening's sword and quick start are the better bet)
    const use_stage = stage && !tried && (!survival || night_note || stage[0] === 'speedrunOpening');
    res += `\nNext step: ${use_stage ? (night_note || '') + stage[1] : survival || step}`;
    bot.next_stage = use_stage ? stage[0] : null; // for the self-prompter, which runs it without asking (getScriptedStage)
    if (!survival && food < 4 && dimension === 'overworld')
        res += '\nFood: kill animals you pass on the way (cow, pig, sheep) and cook the meat, but don\'t go searching for them.';
    res += '\nGather everything a step needs in one trip and craft it together, instead of going back for more of the same thing.';
    if (steps[0].done && count('cobblestone') + count('dirt') + count('cobbled_deepslate') < 8)
        res += '\nKeep about 16 cobblestone or dirt with you for hiding and building (mine some on the way).';
    return res;
}
