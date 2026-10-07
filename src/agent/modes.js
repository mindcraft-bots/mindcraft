import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import settings from './settings.js'
import convoManager from './conversation.js';

async function say(agent, message) {
    agent.bot.modes.behavior_log += message + '\n';
    if (agent.shut_up || !settings.narrate_behavior) return;
    agent.openChat(message);
}

// a mode is a function that is called every tick to respond immediately to the world
// it has the following fields:
// on: whether 'update' is called every tick
// active: whether an action has been triggered by the mode and hasn't yet finished
// paused: whether the mode is paused by another action that overrides the behavior (eg followplayer implements its own self defense)
// update: the function that is called every tick (if on is true)
// when a mode is active, it will trigger an action to be performed but won't wait for it to return output

// the order of this list matters! first modes will be prioritized
// while update functions are async, they should *not* be awaited longer than ~100ms as it will block the update loop
// to perform longer actions, use the execute function which won't block the update loop
const modes_list = [
    {
        // the stages pause unstuck (it ended them while a path was being planned), and an opening then stood still
        // "moving" towards stone for over a minute until the runner's stone pickaxe deadline reset the run. this
        // doesn't interrupt anything: it drops the stalled goal, so the path call fails and the stage tries another
        // block (or tunnels to it)
        name: 'path_stall',
        description: 'Give up on a path that has stopped moving. Interrupts nothing.',
        interrupts: ['all'],
        on: true,
        active: false,
        prev_location: null,
        prev_dig: null,
        since: 0,
        max_stall: 15, // seconds "moving" without moving or digging something new
        max_planning: 25, // seconds with a goal and no path: an opening "planned" a path for over a minute on one spot
        update: async function (agent) {
            const bot = agent.bot;
            if (!bot._path_stall_hooked) {
                // fights and following set a goal that moves with its target, and standing still next to it is fine
                bot.on('goal_updated', (goal, dynamic) => { bot._goal_dynamic = !!dynamic; });
                bot._path_stall_hooked = true;
            }
            const dig = bot.targetDigBlock?.position?.toString() || null;
            const pathing = bot.pathfinder.goal && !bot._goal_dynamic;
            if (!pathing || !this.prev_location ||
                    this.prev_location.distanceTo(bot.entity.position) >= 1 || dig !== this.prev_dig) {
                this.prev_location = bot.entity.position.clone();
                this.prev_dig = dig;
                this.since = Date.now();
                return;
            }
            const limit = bot.pathfinder.isMoving() ? this.max_stall : this.max_planning;
            if (Date.now() - this.since > limit * 1000) {
                console.log(`path_stall: no progress for ${limit}s at ${bot.entity.position.floored()}, dropping the path`);
                bot.modes.behavior_log += 'My path stalled, trying another way.\n';
                this.since = Date.now();
                bot.pathfinder.setGoal(null);
            }
        }
    },
    {
        name: 'self_preservation',
        description: 'Respond to drowning, burning, and damage at low health. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        fall_blocks: ['sand', 'gravel', 'concrete_powder'], // includes matching substrings like 'sandstone' and 'red_sand'
        good_food: ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod',
            'golden_carrot', 'baked_potato', 'bread', 'cooked_rabbit', 'pumpkin_pie', 'mushroom_stew', 'apple', 'carrot'],
        last_heal: 0,
        underwater_since: null,
        fireball_id: null,
        fireball_dist: null,
        update: async function (agent) {
            const bot = agent.bot;
            let block = bot.blockAt(bot.entity.position);
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (!block) block = {name: 'air'}; // hacky fix when blocks are not loaded
            if (!blockAbove) blockAbove = {name: 'air'};
            // the eyes (1.62 up) can be underwater while the block just above the feet isn't
            const head_in_water = skills.isWaterBlock(blockAbove) || skills.isWaterBlock(bot.blockAt(bot.entity.position.offset(0, 1.62, 0)));
            // a ghast fireball killed the bot from 19 health seconds after it reached the nether. one coming closer
            // gets blocked with the shield, or punched back
            const fireball = world.getNearestEntityWhere(bot, e => e.name === 'fireball', 20);
            const fb_dist = fireball ? fireball.position.distanceTo(bot.entity.position) : null;
            const incoming = fireball && this.fireball_id === fireball.id && fb_dist < this.fireball_dist - 0.1;
            this.fireball_id = fireball?.id; this.fireball_dist = fb_dist;
            if (incoming) {
                execute(this, agent, async () => {
                    await skills.blockFireball(bot, fireball);
                });
                return;
            }
            if (!head_in_water) this.underwater_since = null;
            else if (!this.underwater_since) this.underwater_since = Date.now();
            // a full breath is 20 and lasts 15 seconds. come up while there's still time, whatever we're doing:
            // paths to things underwater dive and never surface, and moving away when hurt swims along under the water.
            // the server doesn't always report air before it runs low, so time the dive as well
            const low_air = bot.oxygenLevel != null && bot.oxygenLevel < 12;
            if (head_in_water && (low_air || Date.now() - this.underwater_since > 7000)) {
                say(agent, 'Coming up for air!');
                execute(this, agent, async () => {
                    await skills.swimToAir(bot);
                });
            }
            else if (blockAbove.name === 'water') {
                // does not call execute so does not interrupt other actions
                if (!bot.pathfinder.goal) {
                    bot.setControlState('jump', true);
                }
            }
            else if (blockAbove.boundingBox === 'block' && blockAbove.diggable && Date.now() - bot.lastDamageTime < 3000) {
                // suffocating inside a block, e.g. gravel fell on us: moving away can't work from in there, so dig out
                say(agent, 'I\'m stuck in a block!');
                execute(this, agent, async () => {
                    await skills.digOut(bot);
                });
            }
            else if (this.fall_blocks.some(name => blockAbove.name.includes(name))) {
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 2);
                });
            }
            else if (block.name === 'lava' || block.name === 'fire' ||
                blockAbove.name === 'lava' || blockAbove.name === 'fire') {
                say(agent, 'I\'m on fire!');
                // out of the lava the shortest way first, then water on the flames if we have some (not in the nether,
                // where water boils away at once: pouring it there used up the seconds a practice bot needed to get out
                // of the lava). pouring water while still standing in lava is what burned a casting bot to death.
                // and start for the edge right now, before the action we take over from has stopped
                if (block.name === 'lava' || blockAbove.name === 'lava') skills.startLavaEscape(bot);
                execute(this, agent, async () => {
                    if (await skills.escapeLava(bot)) return;
                    const nether = (bot.game.dimension || '').includes('nether');
                    const nearestWater = nether ? null : world.getNearestBlock(bot, 'water', 20);
                    if (nearestWater) {
                        const pos = nearestWater.position;
                        await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2);
                    }
                });
            }
            else if (bot.blockAt(bot.entity.position.offset(0, -0.2, 0))?.name === 'magma_block') {
                // a heart a second while we stand on it: a practice bot died on the nether's magma ("discovered the
                // floor was lava"). paths keep off it, so this is standing still on one, fighting or waiting
                say(agent, 'Standing on magma!');
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 3);
                });
            }
            else if (Date.now() - bot.lastDamageTime < 3000 && (bot.health < 5 || bot.lastDamageTaken >= bot.health)) {
                say(agent, 'I\'m dying!');
                execute(this, agent, async () => {
                    // hide from whatever is hurting us, or run from it: a random direction can lead straight into it
                    if (world.getNearestEntityWhere(bot, entity => mc.isThreat(bot, entity), 16)) {
                        if (!await skills.bunkerDown(bot))
                            await skills.avoidEnemies(bot, 16);
                    }
                    else
                        await skills.moveAway(bot, 20);
                });
            }
            else if (bot.health <= 10 && Date.now() - bot.lastDamageTime > 4000 && Date.now() - this.last_heal > 10000 &&
                     !world.getNearestEntityWhere(bot, entity => mc.isThreat(bot, entity), 12)) {
                // hurt but safe for the moment: heal up with a golden apple, or top up hunger so health regenerates
                const items = bot.inventory.items();
                const heal_item = items.find(i => i.name === 'enchanted_golden_apple' || i.name === 'golden_apple') ||
                    (bot.food < 18 ? items.find(i => this.good_food.includes(i.name)) : null);
                if (heal_item) {
                    this.last_heal = Date.now();
                    say(agent, `Healing up with ${heal_item.name.replace(/_/g, ' ')}.`);
                    execute(this, agent, async () => {
                        await skills.consume(bot, heal_item.name);
                    });
                }
            }
            else if (agent.isIdle()) {
                bot.clearControlStates(); // clear jump if not in danger or doing anything else
            }
        }
    },
    {
        name: 'unstuck',
        description: 'Attempt to get unstuck when in the same place for a while. Interrupts some actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        prev_location: null,
        distance: 2,
        stuck_time: 0,
        last_time: Date.now(),
        max_stuck_time: 12, // seconds without moving or making digging progress during an action: 20 wasted a lot of a speedrun
        prev_dig_block: null,
        update: async function (agent) {
            if (agent.isIdle()) { 
                this.prev_location = null;
                this.stuck_time = 0;
                return; // don't get stuck when idle
            }
            const bot = agent.bot;
            const cur_dig_block = bot.targetDigBlock;
            if (cur_dig_block && !this.prev_dig_block) {
                this.prev_dig_block = cur_dig_block;
            }
            if (this.prev_location && this.prev_location.distanceTo(bot.entity.position) < this.distance && cur_dig_block == this.prev_dig_block) {
                this.stuck_time += (Date.now() - this.last_time) / 1000;
            }
            else {
                this.prev_location = bot.entity.position.clone();
                this.stuck_time = 0;
                this.prev_dig_block = null;
            }
            const max_stuck_time = cur_dig_block?.name === 'obsidian' ? this.max_stuck_time * 2 : this.max_stuck_time;
            if (this.stuck_time > max_stuck_time) {
                say(agent, 'I\'m stuck!');
                this.stuck_time = 0;
                execute(this, agent, async () => {
                    // moveAway digs or towers out if it has to, and gives up on its own if it makes no progress
                    const start = bot.entity.position.clone();
                    try {
                        await skills.moveAway(bot, 5);
                    } catch (err) {
                        console.warn('unstuck: moveAway failed:', err.message);
                    }
                    if (bot.entity.position.distanceTo(start) >= 2)
                        say(agent, 'I\'m free.');
                    else
                        say(agent, 'I\'m still stuck.');
                });
            }
            this.last_time = Date.now();
        },
        unpause: function () {
            this.prev_location = null;
            this.stuck_time = 0;
            this.prev_dig_block = null;
        }
    },
    {
        name: 'cowardice',
        description: 'Run away from enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isThreat(agent.bot, entity), 16);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                say(agent, `Aaa! A ${enemy.name.replace("_", " ")}!`);
                execute(this, agent, async () => {
                    await skills.avoidEnemies(agent.bot, 24);
                });
            }
        }
    },
    {
        name: 'self_defense',
        description: 'Attack nearby enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const bot = agent.bot;
            const enemy = world.getNearestEntityWhere(bot, entity => mc.isThreat(bot, entity), 8);
            // creepers and skeletons are worth engaging even without a clear walking path, they'll come to us
            const engage = enemy && (enemy.position.distanceTo(bot.entity.position) < 4 || await world.isClearPath(bot, enemy));
            if (!engage) return;
            // a fight we can't win loses everything: bare hands against a zombie at night, or a crowd at low health.
            // run instead, and come back when we've healed or have a weapon
            const threats = world.getNearbyEntities(bot, 10).filter(entity => mc.isThreat(bot, entity)).length;
            const items = bot.inventory.items();
            const weapon = Math.max(1, ...items.map(item => mc.getMeleeDamage(item.name)));
            // a creeper's blast can kill from full health without armor, and backing off once it starts to fuse is
            // often too late. only take one on with a shield to block the blast, or a bow to shoot it from range
            const has_shield = items.some(item => item.name === 'shield') || bot.inventory.slots[45]?.name === 'shield';
            const has_bow = items.some(item => item.name === 'bow') && items.some(item => item.name.includes('arrow'));
            // archers keep hitting from range while we close in, and nothing blocks their arrows without a shield
            const archer = ['skeleton', 'stray', 'bogged', 'pillager'].includes(enemy.name);
            // swimming there are no crits, we move slowly, and our air runs out: get out instead of fighting there.
            // standing in shallow water is fine though: running from a drowned at a lake's edge every time cancelled
            // the bot's search for lava over and over
            const deep_water = bot.entity.isInWater && skills.isWaterBlock(bot.blockAt(bot.entity.position.offset(0, 1, 0)));
            const outmatched = bot.health <= 8 || threats >= 4 || deep_water || (weapon < 4 && (bot.health < 14 || threats >= 2)) ||
                (enemy.name === 'creeper' && !has_shield && !has_bow) || (archer && !has_shield && bot.health < 14);
            if (outmatched) {
                // hurt at night there's no outrunning them all: dig in and seal the hole instead
                const night = bot.time.timeOfDay >= 13000 && bot.time.timeOfDay < 23000;
                const hide = bot.health <= 8 || (night && bot.health <= 12);
                say(agent, `Too dangerous to fight the ${enemy.name}, ${hide ? 'hiding' : 'running'}!`);
                console.log(`[fight] not fighting ${enemy.name}: health ${bot.health}, ${threats} threats, weapon ${weapon}, deep water ${deep_water}, shield ${has_shield}, night ${night}`);
                execute(this, agent, async () => {
                    if (!hide || !await skills.bunkerDown(bot))
                        await skills.avoidEnemies(bot, 16);
                });
            }
            else {
                say(agent, `Fighting ${enemy.name}!`);
                execute(this, agent, async () => {
                    await skills.defendSelf(bot, 8);
                });
            }
        }
    },
    {
        name: 'night_shelter',
        description: 'At nightfall in the overworld, get off the surface: dig into a sealed hole and carry on underground until morning. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        last_try: 0,
        update: async function (agent) {
            // most deaths in a run came at night on the surface (skeletons, spiders, creepers, zombies), and the model
            // often ignored the hint to go underground. so do it for it, whatever it was doing
            const bot = agent.bot;
            if ((bot.game.dimension || '').replace('minecraft:', '') !== 'overworld') return;
            const t = bot.time.timeOfDay;
            if (t < 12800 || t >= 23000) return;
            if (Date.now() - this.last_try < 30000) return;
            if (bot.entity.isInWater) return; // self preservation gets us out of water first
            // not in the middle of a scripted stretch of a speedrun (on easy, with a sword): the nether stage goes up
            // for water, and a run went up, got dug in, went up again and got dug in again, four times over
            if (agent.actions.currentActionLabel?.startsWith('action:speedrun')) return;
            // already under cover? (the sky light read at our own head was 0 out in the open, so this never dug in)
            if (!world.isOpenToSky(bot, bot.entity.position)) return;
            this.last_try = Date.now();
            say(agent, 'Night is falling, digging in until morning.');
            execute(this, agent, async () => {
                if (await skills.bunkerDown(bot)) {
                    skills.log(bot, `It's night: you're dug in underground. Stay below ground until morning and mine what you need down here (iron_ore, coal_ore, gravel, lava), don't go back up to the surface.`);
                    return;
                }
                await skills.digStairsDown(bot, 6);
            });
        }
    },
    {
        name: 'hunting',
        description: 'Hunt nearby animals when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        update: async function (agent) {
            const huntable = world.getNearestEntityWhere(agent.bot, entity => mc.isHuntable(entity), 8);
            if (huntable && await world.isClearPath(agent.bot, huntable)) {
                execute(this, agent, async () => {
                    say(agent, `Hunting ${huntable.name}!`);
                    await skills.attackEntity(agent.bot, huntable);
                });
            }
        }
    },
    {
        name: 'item_collecting',
        description: 'Collect nearby items when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,

        wait: 2, // number of seconds to wait after noticing an item to pick it up
        prev_item: null,
        noticed_at: -1,
        update: async function (agent) {
            let item = world.getNearestEntityWhere(agent.bot, entity => entity.name === 'item' &&
                !mc.JUNK_ITEMS.includes(entity.getDroppedItem?.()?.name), 8);
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();
            if (item && item !== this.prev_item && await world.isClearPath(agent.bot, item) && empty_inv_slots > 1) {
                if (this.noticed_at === -1) {
                    this.noticed_at = Date.now();
                }
                if (Date.now() - this.noticed_at > this.wait * 1000) {
                    say(agent, `Picking up item!`);
                    this.prev_item = item;
                    execute(this, agent, async () => {
                        await skills.pickupNearbyItems(agent.bot);
                    });
                    this.noticed_at = -1;
                }
            }
            else {
                this.noticed_at = -1;
            }
        }
    },
    {
        name: 'torch_placing',
        description: 'Place torches when idle and there are no torches nearby.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                execute(this, agent, async () => {
                    const pos = agent.bot.entity.position;
                    await skills.placeBlock(agent.bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
                });
                this.last_place = Date.now();
            }
        }
    },
    {
        name: 'elbow_room',
        description: 'Move away from nearby players when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        distance: 0.5,
        update: async function (agent) {
            const player = world.getNearestEntityWhere(agent.bot, entity => entity.type === 'player', this.distance);
            if (player) {
                execute(this, agent, async () => {
                    // wait a random amount of time to avoid identical movements with other bots
                    const wait_time = Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, wait_time));
                    if (player.position.distanceTo(agent.bot.entity.position) < this.distance) {
                        await skills.moveAwayFromEntity(agent.bot, player, this.distance);
                    }
                });
            }
        }
    },
    {
        name: 'idle_staring',
        description: 'Animation to look around at entities when idle.',
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        update: function (agent) {
            const entity = agent.bot.nearestEntity();
            let entity_in_view = entity && entity.position.distanceTo(agent.bot.entity.position) < 10 && entity.name !== 'enderman';
            if (entity_in_view && entity !== this.last_entity) {
                this.staring = true;
                this.last_entity = entity;
                this.next_change = Date.now() + Math.random() * 1000 + 4000;
            }
            if (entity_in_view && this.staring) {
                let isbaby = entity.type !== 'player' && entity.metadata[16];
                let height = isbaby ? entity.height/2 : entity.height;
                agent.bot.lookAt(entity.position.offset(0, height, 0));
            }
            if (!entity_in_view)
                this.last_entity = null;
            if (Date.now() > this.next_change) {
                // look in random direction
                this.staring = Math.random() < 0.3;
                if (!this.staring) {
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI/2) - Math.PI/4;
                    agent.bot.look(yaw, pitch, false);
                }
                this.next_change = Date.now() + Math.random() * 10000 + 2000;
            }
        }
    },
    {
        name: 'cheat',
        description: 'Use cheats to instantly place blocks and teleport.',
        interrupts: [],
        on: false,
        active: false,
        update: function (agent) { /* do nothing */ }
    }
];

async function execute(mode, agent, func, timeout=-1) {
    // idle-time modes (picking up items, hunting) run while the model is thinking, and stopping the loop for them
    // threw away the command it was about to give. only the modes that interrupt actions take over from it
    if (mode.interrupts.includes('all') && agent.self_prompter.isActive())
        agent.self_prompter.stopLoop();
    let interrupted_action = agent.actions.currentActionLabel;
    mode.active = true;
    let code_return = await agent.actions.runAction(`mode:${mode.name}`, async () => {
        await func();
    }, { timeout });
    mode.active = false;
    console.log(`Mode ${mode.name} finished executing, code_return: ${code_return.message}`);

    let should_reprompt = 
        interrupted_action && // it interrupted a previous action
        !agent.actions.resume_func && // there is no resume function
        !agent.self_prompter.isActive() && // self prompting is not on
        !code_return.interrupted; // this mode action was not interrupted by something else

    if (should_reprompt) {
        // auto prompt to respond to the interruption
        let role = convoManager.inConversation() ? agent.last_sender : 'system';
        let logs = agent.bot.modes.flushBehaviorLog();
        agent.handleMessage(role, `(AUTO MESSAGE)Your previous action '${interrupted_action}' was interrupted by ${mode.name}.
        Your behavior log: ${logs}\nRespond accordingly.`);
    }
}

let _agent = null;
const modes_map = {};
for (let mode of modes_list) {
    modes_map[mode.name] = mode;
}

class ModeController {
    /*
    SECURITY WARNING:
    ModesController must be reference isolated. Do not store references to external objects like `agent`.
    This object is accessible by LLM generated code, so any stored references are also accessible.
    This can be used to expose sensitive information by malicious prompters.
    */
    constructor() {
        this.behavior_log = '';
    }

    exists(mode_name) {
        return modes_map[mode_name] != null;
    }

    setOn(mode_name, on) {
        modes_map[mode_name].on = on;
    }

    isOn(mode_name) {
        return modes_map[mode_name].on;
    }

    pause(mode_name) {
        modes_map[mode_name].paused = true;
    }

    unpause(mode_name) {
        const mode = modes_map[mode_name];
        //if  unpause func is defined and mode is currently paused
        if (mode.unpause && mode.paused) {
            mode.unpause();
        }
        mode.paused = false;
    }

    unPauseAll() {
        for (let mode of modes_list) {
            if (mode.paused) console.log(`Unpausing mode ${mode.name}`);
            this.unpause(mode.name);
        }
    }

    getMiniDocs() { // no descriptions
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on})`;
        }
        return res;
    }

    getDocs() {
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on}): ${mode.description}`;
        }
        return res;
    }

    async update() {
        if (_agent.isIdle()) {
            this.unPauseAll();
        }
        for (let mode of modes_list) {
            let interruptible = mode.interrupts.some(i => i === 'all') || mode.interrupts.some(i => i === _agent.actions.currentActionLabel);
            if (mode.on && !mode.paused && !mode.active && (_agent.isIdle() || interruptible)) {
                await mode.update(_agent);
            }
            if (mode.active) break;
        }
    }

    flushBehaviorLog() {
        const log = this.behavior_log;
        this.behavior_log = '';
        return log;
    }

    getJson() {
        let res = {};
        for (let mode of modes_list) {
            res[mode.name] = mode.on;
        }
        return res;
    }

    loadJson(json) {
        for (let mode of modes_list) {
            if (json[mode.name] != undefined) {
                mode.on = json[mode.name];
            }
        }
    }
}

export function initModes(agent) {
    _agent = agent;
    // the mode controller is added to the bot object so it is accessible from anywhere the bot is used
    agent.bot.modes = new ModeController();
    if (agent.task) {
        agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
    }
    let modes_json = agent.prompter.getInitModes();
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
}
