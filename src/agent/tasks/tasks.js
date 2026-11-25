import { readFileSync , writeFileSync, existsSync} from 'fs';
import { executeCommand } from '../commands/index.js';
import { getPosition } from '../library/world.js';
import { ConstructionTaskValidator, Blueprint } from './construction_tasks.js';
import { CookingTaskInitiator } from './cooking_tasks.js';
import { SchematicTaskValidator } from './schematic_task.js';
import { prepareSchematicTask } from './schematic_setup.js';

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
    constructor(agent, task_data, taskStartTime = null) {
        this.agent = agent;
        this.data = null;
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

            if (this.task_type === 'schematic') {
                this.validator = new SchematicTaskValidator(this.data, this.agent);
                this.schematicReady = false;
                this.schematicBuildCompleted = false;
            } else if (this.task_type === 'construction') {
                this.validator = new ConstructionTaskValidator(this.data, this.agent);
            } else if (this.task_type === 'cooking' || this.task_type === 'techtree') {
                this.validator = new CookingCraftingTaskValidator(this.data, this.agent);

            } else {
                this.validator = null;
            }

            if (this.data.blocked_actions) {
                this.blocked_actions = this.data.blocked_actions[this.agent.count_id.toString()] || [];
            } else {
                this.blocked_actions = [];
            }
            this.restrict_to_inventory = !!this.data.restrict_to_inventory;
            if (this.data.goal)
                this.blocked_actions.push('!endGoal');
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
        if (this.task_type === 'schematic') {
            if (this.schematicSetupFailed) return { message: 'Schematic setup failed', score: 0, error: this.schematicSetupFailed };
            if (Date.now() - this.taskStartTime >= this.taskTimeout * 1000) {
                this.schematicSetupFailed = 'Task timeout reached';
                return { message: 'Task timeout reached', score: 0 };
            }
            if (!this.schematicReady) return false;
        }
        let res = null;
        if (this.validator)
            res = this.validator.validate();
        if (res && res.valid && (this.task_type !== 'schematic' || (this.schematicBuildCompleted && !this.agent.actions.executing))) {
            // Find all the agents and clear their inventories
            if (this.task_type === 'schematic') this.agent.bot.chat(`/clear ${this.name}`);
            else for (let agent of this.available_agents) {
                this.agent.bot.chat(`/clear ${agent}`);
            }
            // this.agent.bot.chat(`/clear @a`);
            return {"message": 'Task successful', "score": res.score};
        }
        let other_names = this.available_agents.filter(n => n !== this.name);
        const elapsedTime = (Date.now() - this.taskStartTime) / 1000;

        if (elapsedTime >= 30 && this.available_agents.length !== this.data.agent_count) {
            console.log('No other agents found. Task unsuccessful.');
            return {"message": 'No other agents found', "score": 0};
        }
        
        if (this.taskTimeout) {
            if (elapsedTime >= this.taskTimeout) {
                console.log('Task timeout reached. Task unsuccessful.');
                if (res) {
                    return {"message": 'Task timeout reached', "score": res.score, "mismatches": res.mismatches};
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
        if (this.task_type === 'schematic') {
            try {
                await prepareSchematicTask(this);
                if (this.schematicSetupFailed || Date.now() - this.taskStartTime >= this.taskTimeout * 1000) throw new Error('Task timeout reached before goal');
                this.schematicReady = true;
                await this.setAgentGoal();
            } catch (error) {
                this.schematicSetupFailed = error.message;
                console.error('Schematic setup failed:', error);
                throw error;
            }
            return;
        }
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

        //wait for a bit so bots are teleported
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

        await this.teleportBots();

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
        await this.setAgentGoal();
    }
    
    async teleportBots() {
        console.log('\n\nTeleporting bots');
        function getRandomOffset(range) {
            return Math.floor(Math.random() * (range * 2 + 1)) - range;
        }

        let human_player_name = null;
        let bot = this.agent.bot;

        // Finding if there is a human player on the server
        for (const playerName in bot.players) {
            const player = bot.players[playerName];
            if (!this.available_agents.some((n) => n === playerName)) {
                console.log('Found human player:', player.username);
                human_player_name = player.username
                break;
            }
        }

        // go the human if there is one and not required for the task
        if (human_player_name && this.data.human_count === 0) {
            console.log(`Teleporting ${this.name} to human ${human_player_name}`)
            bot.chat(`/tp ${this.name} ${human_player_name}`)
        }
        else {
            console.log(`Teleporting ${this.name} to ${this.available_agents[0]}`)
            bot.chat(`/tp ${this.name} ${this.available_agents[0]}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 200));

        // now all bots are teleport on top of each other (which kinda looks ugly)
        // Thus, we need to teleport them to random distances to make it look better

        /*
        Note : We don't want randomness for construction task as the reference point matters a lot.
        Another reason for no randomness for construction task is because, often times the user would fly in the air,
        then set a random block to dirt and teleport the bot to stand on that block for starting the construction,
        */


        if (this.data.type !== 'construction') {
            const pos = getPosition(bot);
            const xOffset = getRandomOffset(5);
            const zOffset = getRandomOffset(5);
            bot.chat(`/tp ${this.name} ${Math.floor(pos.x + xOffset)} ${pos.y + 3} ${Math.floor(pos.z + zOffset)}`);
            await new Promise((resolve) => setTimeout(resolve, 200));
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
