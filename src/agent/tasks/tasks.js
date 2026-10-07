import { readFileSync , writeFileSync, existsSync} from 'fs';
import { executeCommand } from '../commands/index.js';
import { ConstructionTaskValidator, Blueprint } from './construction_tasks.js';
import { CookingTaskInitiator } from './cooking_tasks.js';
import { BeatGameTaskValidator } from './beat_game_tasks.js';
import * as world from '../library/world.js';

const PROGRESS_FILE = './hells_kitchen_progress.json';

const hellsKitchenProgressManager = {
  readProgress: function() {
    try {
      if (existsSync(PROGRESS_FILE)) {
        const data = readFileSync(PROGRESS_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.error('Error reading progress file:', err);
    }
    return { taskId: null, agent0Complete: false, agent1Complete: false };
  },
  
  writeProgress: function(progress) {
    try {
      writeFileSync(PROGRESS_FILE, JSON.stringify(progress), 'utf8');
    } catch (err) {
      console.error('Error writing progress file:', err);
    }
  },
  
  resetTask: function(taskId) {
    const progress = { taskId, agent0Complete: false, agent1Complete: false };
    this.writeProgress(progress);
    return progress;
  },
  
  updateAgentProgress: function(taskId, agentId, isComplete) {
    const progress = this.readProgress();
    
    // If it's a different task, reset first
    if (progress.taskId !== taskId) {
      progress.taskId = taskId;
      progress.agent0Complete = false;
      progress.agent1Complete = false;
    }
    
    // Update the specific agent's status
    if (agentId === 0) progress.agent0Complete = isComplete;
    if (agentId === 1) progress.agent1Complete = isComplete;
    
    this.writeProgress(progress);
    return progress;
  },
  
  isTaskComplete: function(taskId) {
    const progress = this.readProgress();
    if (progress.taskId !== taskId) return false;
    return progress.agent0Complete && progress.agent1Complete;
  }
};


//todo: modify validator code to return an object with valid and score -> do more testing hahah
//todo: figure out how to log these things to the same place as bots/histories
// export class CraftTaskValidator {
//     constructor(data, agent) {
//         this.target = data.target;
//         this.number_of_target = data.number_of_target;
//         this.agent = agent;

/**
 * Validates the presence of required items in an agent's inventory
 * @param {Object} data - Task data containing target and quantity information
 * @param {Object} agent - Agent object with bot inventory
 * @returns {Object} Validation result with success status and missing items
 */
function checkItemPresence(data, agent) {

    try {
        // Special handling for hells_kitchen tasks
        if (data.task_id && data.task_id.endsWith('hells_kitchen') && Array.isArray(data.target) && data.target.length === 2) {
            
            // Get agent ID and target for this agent
            const agentId = agent.count_id;
            
            if (agentId === 0 || agentId === 1) {
                // Use only the corresponding element from the target list
                const targetForThisAgent = data.target[agentId];
                const modifiedData = {
                    ...data,
                    target: targetForThisAgent
                };
                
                // Check if this agent has their required item
                const agentResult = checkItemForSingleAgent(modifiedData, agent);
                
                // Update the file-based progress tracker
                const progress = hellsKitchenProgressManager.updateAgentProgress(
                    data.task_id, 
                    agentId, 
                    agentResult.success
                );
                
                // // Log the current state
                // console.log(`Agent ${agentId} has item: ${agentResult.success}`);
                // console.log(`Task state: Agent0=${progress.agent0Complete}, Agent1=${progress.agent1Complete}`);
                
                // Return combined result - success only if both agents have their items
                return {
                    success: progress.agent0Complete && progress.agent1Complete,
                    missingItems: agentResult.missingItems,
                    agentComplete: agentResult.success  // Individual agent status for debugging
                };
            }
        }
        
        // Non-hells_kitchen tasks use the standard check
        return checkItemForSingleAgent(data, agent);
        
    } catch (error) {
        console.error('Error checking item presence:', error);
        return {
            success: false,
            missingItems: [],
            error: error.message
        };
    }
}


/**
 * Helper function to check a single agent's inventory
 * Extracted from the original checkItemPresence logic
 */
function checkItemForSingleAgent(data, agent) {
    function isTargetDictionaryWithQuantities(target) {
        return typeof target === 'object' && 
               !Array.isArray(target) && 
               target !== null &&
               Object.values(target).every(value => typeof value === 'number');
    }
    
    function normalizeTargets(target) {
        if (typeof target === 'string') {
            return { [target]: 1 };
        } else if (Array.isArray(target)) {
            return target.reduce((acc, item) => {
                acc[item] = 1;
                return acc;
            }, {});
        } else if (typeof target === 'object' && target !== null) {
            return target;
        }
        throw new Error('Invalid target format');
    }
    
    function normalizeQuantities(targets, quantities) {
        if (quantities === undefined) {
            return Object.keys(targets).reduce((acc, key) => {
                acc[key] = 1;
                return acc;
            }, {});
        } else if (typeof quantities === 'number') {
            return Object.keys(targets).reduce((acc, key) => {
                acc[key] = quantities;
                return acc;
            }, {});
        } else if (typeof quantities === 'object' && quantities !== null) {
            return quantities;
        }
        throw new Error('Invalid number_of_target format');
    }
    
    // First normalize targets to always have a consistent format
    const targets = normalizeTargets(data.target);
    
    // Determine the required quantities
    const requiredQuantities = isTargetDictionaryWithQuantities(data.target) 
        ? data.target 
        : normalizeQuantities(targets, data.number_of_target);

    // Count items in inventory
    const inventoryCount = {};
    agent.bot.inventory.slots.forEach((slot) => {
        if (slot) {
            const itemName = slot.name.toLowerCase();
            inventoryCount[itemName] = (inventoryCount[itemName] || 0) + slot.count;
        }
    });

    // Check if all required items are present in sufficient quantities
    const missingItems = [];
    let allTargetsMet = true;

    for (const [item, requiredCount] of Object.entries(requiredQuantities)) {
        const itemName = item.toLowerCase();
        const currentCount = inventoryCount[itemName] || 0;
        if (currentCount < requiredCount) {
            allTargetsMet = false;
            missingItems.push({
                item: itemName,
                required: requiredCount,
                current: currentCount,
                missing: requiredCount - currentCount
            });
        }
    }

    return {
        success: allTargetsMet,
        missingItems: missingItems
    };
}



class CookingCraftingTaskValidator {
    constructor(data, agent) {
        this.data = data;
        this.agent = agent;
    } 
    validate() {
        const result = checkItemPresence(this.data, this.agent);
        let score = 0;
        if (result.success) {
            score = 1;
        }
        return {
            "valid": result.success, 
            "score": score,
        };
    }
}

export class Task {
    constructor(agent, task_data, taskStartTime = null, taskSplits = []) {
        this.agent = agent;
        this.data = null;
        this.created = Date.now(); // when this process took the task on, as opposed to when the task started

        if (taskStartTime !== null)
            this.taskStartTime = taskStartTime;
        else
            this.taskStartTime = Date.now();
        this.validator = null;
        this.reset_function = null;
        this.blocked_actions = [];
        this.task_data = task_data;
        if (task_data) {
            console.log('Starting task', task_data.task_id);
            console.log("Task start time set to", this.taskStartTime);
            if (task_data.task_id.endsWith('hells_kitchen')) {
                // Reset hells_kitchen progress when a new task starts
                hellsKitchenProgressManager.resetTask(task_data.task_id);
                console.log('Reset Hells Kitchen progress for new task');
            }
            this.data = task_data;
            this.task_type = this.data.type;
            if (this.task_type === 'construction' && this.data.blueprint) {
                this.blueprint = new Blueprint(this.data.blueprint);
                this.goal = this.data.goal + ' \n' + this.blueprint.explain() + " \n" + "make sure to place the lower levels of the blueprint first";
                this.conversation = this.data.conversation + ' \n' + this.blueprint.explain();
            } else {
                this.goal = this.data.goal;
                this.conversation = this.data.conversation;
            }
            this.taskTimeout = this.data.timeout || 300;
            // Set validator based on task_type

            // do goal initialization here

            // let agentGoal = this.getAgentGoal();
            // if (agentGoal) {
            //     agentGoal += "You have to collaborate with other agents/bots, namely " + this.available_agents.filter(n => n !== this.name).join(', ') + " to complete the task as soon as possible by dividing the work among yourselves.";
            //     console.log(`Setting goal for agent ${this.agent.count_id}: ${agentGoal}`);
            //     await executeCommand(this.agent, `!goal("${agentGoal}")`);
            // }

            if (this.task_type === 'construction') {
                this.validator = new ConstructionTaskValidator(this.data, this.agent);
            } else if (this.task_type === 'cooking' || this.task_type === 'techtree') {
                this.validator = new CookingCraftingTaskValidator(this.data, this.agent);

            } else if (this.task_type === 'beat_game') {
                this.validator = new BeatGameTaskValidator(this.data, this.agent, this.taskStartTime, taskSplits);
            } else {
                this.validator = null;
            }

            if (this.data.blocked_actions) {
                this.blocked_actions = this.data.blocked_actions[this.agent.count_id.toString()] || [];
            } else {
                this.blocked_actions = [];
            }
            this.restrict_to_inventory = !!this.data.restrict_to_inventory;
            // a task's goal has to keep going until the task ends: !stfu turns self-prompting off just like !endGoal
            if (this.data.goal)
                this.blocked_actions.push('!endGoal', '!stfu');
            if (this.conversation)
                this.blocked_actions.push('!endConversation');
        }
        else {
            console.log('No task.');
        }

        this.name = this.agent.name;
        this.available_agents = []
    }

    updateAvailableAgents(agents) {
        this.available_agents = agents
    }

    // Add this method if you want to manually reset the hells_kitchen progress
    resetHellsKitchenProgress() {
        if (this.task_id && this.task_id.endsWith('hells_kitchen')) {
            hellsKitchenProgressManager.resetTask(this.task_id);
            console.log('Hells Kitchen progress reset manually');
        }
    }

    getAgentGoal() {
        if (!this.data || !this.data.goal) {
            return null;
        }

        let add_string = '';

        if (this.task_type === 'cooking') {


            if (this.data.agent_count > 2) {

                if (this.name.toLowerCase().startsWith('andy')) {
                    add_string = '\nIn the end, all the food items should be given to you by other bots. Make sure to talk to all the agents using startConversation command to coordinate the task instead of talking to just one agent. You can even end current conversation with any agent using endConversation command and then talk to a new agent using startConversation command.';
                } 
                else {
                    add_string = '\nIn the end, all the food items should be given to one single bot whose name starts with andy or Andy. Make sure to talk to all the agents using startConversation command to coordinate the task instead of talking to just one agent. You can even end current conversation with any agent using endConversation command and then talk to a new agent using startConversation command.';
                }   
            } 
            else {
                if (this.data.task_id && this.data.task_id.endsWith('hells_kitchen')) {
                    add_string = '';
                } 
                else {
                add_string = '\nIn the end, all the food items should be given to one single bot.';
                }
            }
        }

        if (this.task_type === 'techtree') {
            if (this.data.agent_count > 2) {
                add_string = '\nMake sure to share resources among all agents and to talk to all the agents using startConversation command to coordinate the task instead of talking to just one agent. You can even end current conversation with any agent using endConversation command and then talk to a new agent using startConversation command.'
            }
        }

        // If goal is a string, all agents share the same goal
        if (typeof this.data.goal === 'string') {
            return this.data.goal + add_string;
        }

        // If goal is an object, get the goal for this agent's count_id
        if (typeof this.data.goal === 'object' && this.data.goal !== null) {
            const agentId = this.agent.count_id.toString();
            return (this.data.goal[agentId] || '') + add_string;
        }

        return null;
    }

    isDone() {
        if (this.initializing)
            return false;
        let res = null;
        if (this.validator)
            res = this.validator.validate();
        if (res && res.valid) {
            // Find all the agents and clear their inventories
            for (let agent of this.available_agents) {
                this.agent.bot.chat(`/clear ${agent}`);
            }
            // this.agent.bot.chat(`/clear @a`);
            return {"message": 'Task successful', "score": res.score};
        }
        let other_names = this.available_agents.filter(n => n !== this.name);
        const elapsedTime = (Date.now() - this.taskStartTime) / 1000;

        // only a task for several bots can be missing one, and only after this process has had time to hear who's
        // there: restarted 13 minutes into a run, a bot ended it at once, before the list of agents had arrived
        if (this.data.agent_count > 1 && (Date.now() - this.created) / 1000 >= 30 && elapsedTime >= 30 && this.available_agents.length !== this.data.agent_count) {
            console.log('No other agents found. Task unsuccessful.');
            return {"message": 'No other agents found', "score": 0};
        }
        
        if (this.taskTimeout) {
            if (elapsedTime >= this.taskTimeout) {
                console.log('Task timeout reached. Task unsuccessful.');
                if (res) {
                    return {"message": 'Task timeout reached', "score": res.score};
                } else {
                    return {"message": 'Task timeout reached', "score": 0};
                }
                
            }
        }
        return false;
    }

    async setAgentGoal() {
        let agentGoal = this.getAgentGoal();
        if (agentGoal && this.data.agent_count + this.data.human_count > 1) {
            agentGoal += "You have to collaborate with other agents/bots, namely " + this.available_agents.filter(n => n !== this.name).join(', ') + " to complete the task as soon as possible by dividing the work among yourselves.";
            console.log(`Setting goal for agent ${this.agent.count_id}: ${agentGoal}`);
        }
        await executeCommand(this.agent, `!goal("${agentGoal}")`);
    }

    async initBotTask() {
        // the update loop is already checking the task, so don't score it off last session's inventory while it's reset
        this.initializing = true;
        try {
            await this.setUpTask();
        } finally {
            this.initializing = false;
        }
    }

    async setUpTask() {
        // make it day first thing: the rest of the setup takes a few seconds, and a bot that logged in at night where
        // the last run ended was shot by a skeleton before it was done
        if (this.task_type === 'beat_game')
            this.agent.bot.chat('/time set day');
        await this.agent.bot.chat(`/clear ${this.name}`);
        console.log(`Cleared ${this.name}'s inventory.`);

        //wait for a bit so inventory is cleared
        await new Promise((resolve) => setTimeout(resolve, 500));

        if (this.data === null)
            return;
        
        if (this.task_type === 'cooking') {
            this.initiator = new CookingTaskInitiator(this.data, this.agent.bot);
        } else {
            this.initiator = null;
        }

        //wait for a bit so bots are teleported (nobody is teleported any more, and a speedrun's clock is running)
        if (this.data.agent_count > 1)
            await new Promise((resolve) => setTimeout(resolve, 3000));

        if (this.agent.count_id === 0 && this.data.human_count > 0) {
            console.log('Clearing human player inventories');
            for (let i = 0; i < this.data.human_count; i++) {
                const username = this.data.usernames[i];
                await this.agent.bot.chat(`/clear ${username}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        if (this.data.initial_inventory) {
            console.log("Setting inventory...");
            let initialInventory = {};
            
            initialInventory = this.data.initial_inventory[this.agent.count_id.toString()] || {};
            console.log("Initial inventory for agent", this.agent.count_id, ":", initialInventory);
            console.log("")

            if (this.data.human_count > 0 && this.agent.count_id === 0) {
                // this.num_humans = num_keys - this.data.num_agents;
                if (this.data.human_count !== this.data.usernames.length) {
                    console.log(`Number of human players ${this.human_count} does not match the number of usernames provided. ${this.data.usernames.length}`);
                    throw new Error(`Number of human players ${this.human_count} does not match the number of usernames provided. ${this.data.usernames.length}`);
                    return;
                }
                
                const starting_idx = this.data.agent_count;
                for (let i = 0; i < this.data.human_count; i++) {
                    const username = this.data.usernames[i];
                    const inventory = this.data.initial_inventory[starting_idx + i];
                    console.log(Object.keys(inventory));
                    for (let key of Object.keys(inventory)) {
                        const itemName = key.toLowerCase();
                        const quantity = inventory[key];
                        console.log(`Give ${username} ${quantity} ${itemName}`);
                        await this.agent.bot.chat(`/give ${username} ${itemName} ${quantity}`);
                    }
                }
            }
            console.log(this.data.initial_inventory);

            // Assign inventory items
            for (let key of Object.keys(initialInventory)) {
                const itemName = key.toLowerCase();
                const quantity = initialInventory[key];
                await this.agent.bot.chat(`/give ${this.name} ${itemName} ${quantity}`);
                console.log(`Gave ${this.name} ${quantity} ${itemName}`);
            }

            // Wait briefly for inventory commands to complete
            await new Promise((resolve) => setTimeout(resolve, 500));
        }

        if (this.initiator && this.agent.count_id === 0) {
            await this.initiator.init();
        }

        await this.prepareWorld();

        if (this.data.agent_count && this.data.agent_count > 1) {
            // TODO wait for other bots to join
            await new Promise((resolve) => setTimeout(resolve, 10000));
            if (this.available_agents.length < this.data.agent_count) {
                console.log(`Missing ${this.data.agent_count - this.available_agents.length} bot(s).`);
                this.agent.killAll();
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (this.data.conversation && this.agent.count_id === 0) {
            let other_name = this.available_agents.filter(n => n !== this.name)[0];
            let waitCount = 0;
            while (other_name === undefined && waitCount < 20) {
                other_name = this.available_agents.filter(n => n !== this.name)[0];
                await new Promise((resolve) => setTimeout(resolve, 1000));
                waitCount++;
            }
            if (other_name === undefined && this.data.agent_count > 1) {
                console.log('No other agents found. Task unsuccessful.');
                this.agent.killAll();
            }
            await executeCommand(this.agent, `!startConversation("${other_name}", "${this.data.conversation}")`);
        }
        // the opening never changes, so play it straight through before the model takes over: thinking between
        // each of its steps took over a minute on a local model
        if (this.task_type === 'beat_game')
            await this.playOpening();
        await this.setAgentGoal();
    }

    async playOpening() {
        // the run is set up by now (inventory cleared, on the surface), so score it again: the splits the opening
        // reaches only printed once it was over, and the runner resets a run with no stone pickaxe split by 2:30
        this.initializing = false;
        const opening = await this.runScripted('!speedrunOpening', 6);
        // then everything for the nether, once the opening got the iron pickaxe: the model took 10-20 minutes over it
        const pickaxe = this.agent.bot.inventory.items().some(i => i.name === 'iron_pickaxe' || i.name === 'diamond_pickaxe');
        const kit = pickaxe ? await this.runScripted('!speedrunKit', 12) : null;
        // then into the nether, once the kit has the buckets and flint_and_steel
        const items = this.agent.bot.inventory.items();
        const buckets = items.filter(i => ['bucket', 'water_bucket', 'lava_bucket'].includes(i.name)).reduce((n, i) => n + i.count, 0);
        const lighter = items.some(i => i.name === 'flint_and_steel' || i.name === 'fire_charge');
        const nether = kit && buckets >= 2 && lighter ? await this.runScripted('!speedrunNether', 12) : null;
        // the model takes over from here: tell it how far they got, and where they stopped if they did
        for (const [name, command, result] of [['Opening', '!speedrunOpening', opening], ['Kit', '!speedrunKit', kit], ['Nether', '!speedrunNether', nether]]) {
            if (!result) continue;
            console.log(`${name} result: ${result}`);
            await this.agent.history.add('system', `${command} ran first. ${result}`);
        }
    }

    async runScripted(command, minutes, wait_for_resume = true) {
        const bot = this.agent.bot;
        // a scripted stretch of the run is one long action, and its output only came back at the end, where nothing
        // printed it: echo it to the run log as it goes (the runner looks there for the first logs, and resets a run
        // with none by 90 seconds, so every run with the opening was reset)
        let printed = 0;
        let echoed = '';
        const echo = () => {
            const output = bot.output || '';
            if (output.length < printed) printed = 0;
            const out = output.slice(printed).trim();
            printed = output.length;
            if (out) {
                console.log(out);
                echoed += out + '\n';
            }
        };
        const timer = setInterval(echo, 1000);
        let result;
        try {
            result = await executeCommand(this.agent, command);
            // a mode cutting in (self defense, digging out of fallen gravel) stops it, and it resumes once the mode is
            // done (no resume after a death): wait for that before the model takes over. not while self-prompting,
            // where nothing resumes: the self-prompter's autopilot runs it again instead
            const deadline = Date.now() + minutes * 60000;
            while (wait_for_resume && (this.agent.actions.resume_func || this.agent.actions.executing) && Date.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 1000));
            this.agent.actions.cancelResume();
        } finally {
            clearInterval(timer);
        }
        // a resumed run's result goes nowhere, so use the end of what it printed
        return result || (echoed && `Its last output:\n${echoed.slice(-600)}`);
    }
    
    async moveToSurface() {
        // a fresh run starts where the last one stopped, which can be underground, underwater, in the nether or the end.
        // start it on the overworld surface instead, like a new world. spreadplayers never lands on water or lava,
        // so look further out when the column straight up is sea, and fall back to the world spawn
        const bot = this.agent.bot;
        const dimension = (bot.game.dimension || '').replace('minecraft:', '');
        const pos = bot.entity.position.clone();
        // somewhere crawling with mobs (a dark forest, a cave mouth) killed three runs in a row before they had a
        // sword, so start those somewhere else nearby
        const mobs = Object.values(bot.entities).filter(e => e.type === 'hostile' && e.position.distanceTo(pos) < 16).length;
        // open sky from the blocks above, not the sky light at our feet, which read 0 out in the open
        if (dimension === 'overworld' && !bot.entity.isInWater && world.isOpenToSky(bot, pos) && mobs < 2) {
            console.log(`${this.name} is already on the surface at ${pos.floored()}.`);
            return;
        }
        if (mobs >= 2) console.log(`${mobs} hostile mobs around ${pos.floored()}, starting somewhere else.`);
        // spreadplayers refuses a range of 1 ("too many entities for space"), so the tightest that works is a few blocks
        const tries = mobs >= 2 ? [[pos, 96], [pos, 192]] : [[pos, 4], [pos, 32], [pos, 128]];
        if (bot.spawnPoint) tries.push([bot.spawnPoint, 64]);
        for (const [center, range] of tries) {
            const moved = new Promise((resolve) => {
                const done = () => { clearTimeout(timer); resolve(true); };
                const timer = setTimeout(() => { bot.removeListener('forcedMove', done); resolve(false); }, 3000);
                bot.once('forcedMove', done);
            });
            bot.chat(`/execute in minecraft:overworld run spreadplayers ${Math.floor(center.x)} ${Math.floor(center.z)} 0 ${range} false ${this.name}`);
            if (await moved) {
                console.log(`Starting ${this.name} on the surface at ${bot.entity.position.floored()}.`);
                return;
            }
        }
        console.log(`Couldn't move ${this.name} to the surface, so it starts at ${pos.floored()}.`);
    }

    async prepareWorld() {
        // bots used to be teleported to a human player and spread out here. that's gone: the /tp read the bot's
        // position before the server had moved it, so the spread started from wherever it logged out and could
        // leave it inside a wall. bots now start where they are
        let bot = this.agent.bot;

        if (this.task_type === 'beat_game') {
            await this.moveToSurface();
            // a new world starts in the morning. starting a run empty-handed at night got the bot killed within minutes
            bot.chat('/time set day');
            // and clear: in rain, zombies and skeletons don't burn in daylight, and a run started in a storm died to
            // them twice before it had a sword
            bot.chat('/weather clear');
            // on easy, the difficulty Java speedruns are played on: zombies and skeletons in the mines killed 7 of 18
            // runs in a day on normal, in fights with 3 or 4 at once
            bot.chat('/difficulty easy');
            // and with full health and hunger: they carry over from the last session, and one run started on 4 health
            bot.chat(`/effect clear ${this.name}`);
            bot.chat(`/effect give ${this.name} minecraft:instant_health 1 10 true`);
            bot.chat(`/effect give ${this.name} minecraft:saturation 1 20 true`);
        }

        if (this.data.agent_count && this.data.agent_count > 1) {
            // TODO wait for other bots to join
            await new Promise((resolve) => setTimeout(resolve, 10000));
            if (this.available_agents.length < this.data.agent_count) {
                console.log(`Missing ${this.data.agent_count - this.available_agents.length} bot(s).`);
                this.agent.killAll();
            }
        }

        if (this.data.type === 'construction'){
            //Ensures construction is cleaned out first. -> relies on cheats which are turned off?
            if (this.blueprint){
                console.log('Cleaning out construction blueprint');
                const result = this.blueprint.autoDelete();
                const commands = result.commands;
                const nearbyPosition = result.nearbyPosition;
                console.log("nearby position", nearbyPosition);
                const first_coord = this.data.blueprint.levels[0].coordinates;
                bot.chat(`/tp @a ${first_coord[0]} ${first_coord[1]} ${first_coord[2]}`);
                if (this.agent.agent_id === 0 && this.data.human_count > 0) {
                    for (let i = 0; i < this.data.human_count; i++) {
                        const username = this.data.usernames[i];
                        await bot.chat(`/tp ${username} ${nearbyPosition.x} ${nearbyPosition.y} ${nearbyPosition.z}`);
                    }
                }
                for (const command of commands) {
                    bot.chat(command);
                }
            }
            else{
                console.log('no construction blueprint?')
            }
        }
    }
}