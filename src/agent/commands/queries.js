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

export function getNextStepHint(bot) {
    // the next step (and food note) from !gameProgress, added to command results so the model doesn't have to spend
    // a turn on !gameProgress after every command
    return getGameProgress(bot).split('\n').filter(line => line.startsWith('Next step:') || line.startsWith('Food:') || line.startsWith('Keep about')).join('\n');
}

function getGameProgress(bot) {
    const inv = world.getInventoryCounts(bot);
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

    const steps = [
        {done: any('stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'), text: 'Stone tools',
            // pick up from where we are, so a re-read doesn't send the bot back for logs it already turned into a pickaxe
            // craftRecipe makes the planks, sticks and crafting table a recipe needs, so one command does each tool
            next: count('cobblestone') >= 3
                ? `You have ${count('cobblestone')} cobblestone: !craftRecipe("stone_pickaxe", 1) now, then a stone_sword (2) and, with 8 more, a furnace.`
                : has('wooden_pickaxe')
                ? 'You have a wooden_pickaxe: mine 3 cobblestone and !craftRecipe("stone_pickaxe", 1) straight away, then mine ~13 more with it for a stone_sword (2), a furnace (8) and spares.'
                : 'Collect 6 logs in one go, then !craftRecipe("wooden_pickaxe", 1): it makes the planks, sticks and crafting table it needs by itself.'},
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
                : '!collectBlocks("iron_ore", 12) to mine the nearest iron, even if it is in a cave or under the ground: it digs its way there. ' +
                  (bot.entity.position.y > 24 ? `Only if it finds none, dig down to y=16 where iron is common with !digDown(${Math.round(bot.entity.position.y - 16)}) and try again. ` : '') +
                  '12 covers the iron_pickaxe (3), bucket (3), shield (1), iron_sword (2) and flint_and_steel (1). Don\'t explore the surface for iron. Grab coal you pass for fuel, then smelt the raw_iron with one !smeltItem and craft the iron_pickaxe straight away.'},
        // a speedrun only needs a chestplate: the most protection for the iron, and leggings cost another trip
        {done: any('iron_sword', 'diamond_sword', 'netherite_sword') && has('shield') && armor.length >= 1, text: 'Sword, shield and a chestplate',
            next: 'Craft a shield first (1 iron_ingot, 6 planks: you block with it in fights) and an iron_sword, then an iron_chestplate (8 iron). Mine whatever iron you are short of in one trip.'},
        {done: any('diamond_pickaxe', 'netherite_pickaxe') || dimension !== 'overworld' || eyes > 0, text: 'Diamond pickaxe (to mine obsidian)',
            next: '!collectBlocks("diamond_ore", 3) to mine the nearest diamonds (deepslate ones count too): it digs its way there. ' +
                (bot.entity.position.y > -40 ? `Only if it finds none, dig down toward y=-58 with !digDown(${Math.round(bot.entity.position.y + 58)}) and try again. ` : '') +
                'Then !craftRecipe("diamond_pickaxe", 1).'},
        {done: (has('obsidian', 10) && any('flint_and_steel', 'fire_charge')) || dimension !== 'overworld' || eyes >= 12, text: '10 obsidian and flint_and_steel',
            next: 'Lava pools are common deep down, near diamond level: !makeObsidian(10) there (needs a water_bucket and the diamond_pickaxe). Craft flint_and_steel from iron_ingot and flint (from gravel) if you have none.'},
        {done: count('blaze_rod') + count('blaze_powder') / 2 >= 6 || eye_potential >= 12, text: 'Blaze rods (6+)',
            next: dimension === 'the_nether'
                ? 'Use !collectBlazeRods(7). It finds a fortress and kills blazes; bring armor, food, and a bow if you have one.'
                : 'Build a nether portal (!buildNetherPortal), go to the nether (!enterPortal nether_portal), find a fortress and kill blazes.'},
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
    const on_surface = bot.blockAt(bot.entity.position)?.skyLight > 7;
    // food only comes first when it's actually needed: getting hungry, or hurt with nothing to eat. sending a well-fed
    // bot off to find cows wasted minutes exploring, and pulled it through water
    const need_food = food < 4 && (bot.food <= 12 || (bot.health < 14 && bot.food < 18));
    if (dimension === 'overworld' && night && on_surface && !steps[2].done) {
        // a bot without armor on the surface at night keeps dying to zombies, skeletons and creepers (night falls about
        // 10 minutes into a fresh run). underground it's safe, and the iron and diamonds it needs next are down there
        survival = (has_sword ? '' : 'Craft a stone_sword first if you can (2 cobblestone, 1 stick). ') +
            'It\'s night and mobs are out: get off the surface. Dig down with !digDown(10) and mine underground (iron_ore for armor, coal_ore, diamonds deeper) until morning.';
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
    res += `\nNext step: ${survival || next.next}`;
    if (!survival && food < 4 && dimension === 'overworld')
        res += '\nFood: kill animals you pass on the way (cow, pig, sheep) and cook the meat, but don\'t go searching for them.';
    res += '\nGather everything a step needs in one trip and craft it together, instead of going back for more of the same thing.';
    if (steps[0].done && count('cobblestone') + count('dirt') + count('cobbled_deepslate') < 8)
        res += '\nKeep about 16 cobblestone or dirt with you for hiding and building (mine some on the way).';
    return res;
}
