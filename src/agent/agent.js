import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { executeCommandToolCall } from './commands/tool_adapter.js';
import { isNativeToolResponse } from '../models/native_tools.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import { ReactMessageManager } from './react_message_manager.js';
import convoManager from './conversation.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;
        this.active_message_handlers = 0;
        this.active_native_tool_calls = new Map();
        this.message_handler_queue = Promise.resolve();
        this.human_message_queue = [];
        this.human_message_flush_timer = null;
        this.human_message_interrupt_promise = Promise.resolve();
        this.message_interrupt_epoch = 0;
        this.active_llm_abort_controller = null;

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.react_messages = new ReactMessageManager(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initPromptResources();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);
     
            process.exit(1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;
                if (isMinecraftCommandEchoMessage(message)) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??');
                }
                else {
                    this.handleMessage(username, message);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        };

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message && !hasLoadedConversation(save_data)) {
            await this.handleMessage('system', init_message, 2);
        }
        else if (!hasLoadedConversation(save_data)) {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.emit('mindcraft_interrupt');
        this.bot.stopDigging();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
        if (!this.collectBlockCancelPromise) {
            this.collectBlockCancelPromise = this.bot.collectBlock.cancelTask()
                .catch(() => {})
                .finally(() => {
                    this.collectBlockCancelPromise = null;
                });
        }
        return this.collectBlockCancelPromise;
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleSelfPrompt(message, max_responses=null) {
        return this.handleMessage('system', message, max_responses, { transient: true });
    }

    async handleMessage(source, message, max_responses=null, options={}) {
        if (this._shouldBatchHumanMessage(source, message, options)) {
            return this._enqueueHumanMessage(source, message, max_responses, options);
        }
        if (this._shouldBypassMessageQueue(source, message)) {
            this.message_interrupt_epoch = (this.message_interrupt_epoch || 0) + 1;
            this.abortActiveLLMRequest('Interrupted by human command.');
            return this._runMessageHandler(source, message, max_responses, options);
        }
        return this._enqueueMessageHandler(source, message, max_responses, options);
    }

    _enqueueMessageHandler(source, message, max_responses=null, options={}) {
        const interruptEpoch = this.message_interrupt_epoch || 0;
        const previous = this.message_handler_queue || Promise.resolve();
        const queued = previous
            .catch(() => {})
            .then(() => this._runMessageHandler(source, message, max_responses, options, { interruptEpoch }));
        this.message_handler_queue = queued.catch(() => {});
        return queued;
    }

    _shouldBatchHumanMessage(source, message, options={}) {
        if (options?.transient) return false;
        if (!this._isPriorityHumanSource(source)) return false;
        return !containsCommand(message);
    }

    _isPriorityHumanSource(source) {
        const self_prompt = source === 'system' || source === this.name;
        return !self_prompt && !convoManager.isOtherAgent(source);
    }

    _enqueueHumanMessage(source, message, max_responses=null, options={}) {
        let resolveQueued;
        let rejectQueued;
        const queuedPromise = new Promise((resolve, reject) => {
            resolveQueued = resolve;
            rejectQueued = reject;
        });
        this.message_interrupt_epoch = (this.message_interrupt_epoch || 0) + 1;
        this.human_message_queue.push({ source, message, max_responses, options, resolveQueued, rejectQueued });
        this._schedulePriorityHumanMessageInterrupt();
        if (!this.human_message_flush_timer) {
            this.human_message_flush_timer = setTimeout(() => {
                this.human_message_flush_timer = null;
                void this._flushHumanMessageQueue()
                    .catch(error => console.error('Error flushing human message queue:', error));
            }, 0);
        }
        return queuedPromise;
    }

    _schedulePriorityHumanMessageInterrupt() {
        const previousInterrupt = this.human_message_interrupt_promise || Promise.resolve();
        this.human_message_interrupt_promise = previousInterrupt
            .catch(error => console.warn('Failed to interrupt active turn for new user/admin message:', error))
            .then(() => this._interruptActiveTurnForNewHumanMessage())
            .catch(error => console.warn('Failed to interrupt active turn for new user/admin message:', error));
    }

    async _flushHumanMessageQueue() {
        await (this.human_message_interrupt_promise || Promise.resolve());
        const batch = this.human_message_queue.splice(0);
        if (batch.length === 0) return false;
        const compiled = this._compileHumanMessageBatch(batch);
        try {
            const result = await this._enqueueMessageHandler(compiled.source, compiled.message, compiled.max_responses, compiled.options);
            for (const item of batch) item.resolveQueued?.(result);
            return result;
        } catch (error) {
            for (const item of batch) item.rejectQueued?.(error);
            throw error;
        }
    }

    _compileHumanMessageBatch(batch) {
        const sources = [...new Set(batch.map(item => item.source))];
        const sameSource = sources.length === 1;
        const source = sameSource ? sources[0] : 'users';
        const message = sameSource
            ? batch.map(item => item.message).join('\n')
            : batch.map(item => `${item.source}: ${item.message}`).join('\n');
        const last = batch[batch.length - 1] || {};
        return {
            source,
            message,
            max_responses: last.max_responses ?? null,
            options: last.options || {}
        };
    }

    async _interruptActiveTurnForNewHumanMessage() {
        this.abortActiveLLMRequest('Interrupted by newer user/admin message.');
        const actionWasExecuting = Boolean(this.actions?.executing);
        if (actionWasExecuting) {
            if (typeof this.actions.stop === 'function') {
                await this.actions.stop();
            }
            else if (this.bot) {
                this.requestInterrupt();
            }
        }
        const closed = await this.finishInterruptedNativeToolCalls('Tool interrupted by newer user/admin message.');
        if (closed > 0 && !actionWasExecuting && this.bot && typeof this.requestInterrupt === 'function') {
            this.requestInterrupt();
        }
    }

    beginActiveLLMRequest() {
        const controller = new AbortController();
        this.active_llm_abort_controller = controller;
        return controller;
    }

    endActiveLLMRequest(controller) {
        if (this.active_llm_abort_controller === controller) {
            this.active_llm_abort_controller = null;
        }
    }

    abortActiveLLMRequest(reason = 'Interrupted.') {
        const controller = this.active_llm_abort_controller;
        if (!controller || controller.signal?.aborted) return false;
        try {
            controller.abort(new Error(reason));
        } catch {
            controller.abort();
        }
        return true;
    }

    async _runMessageHandler(source, message, max_responses=null, options={}, runOptions={}) {
        this.active_message_handlers = (this.active_message_handlers || 0) + 1;
        try {
            return await this._handleMessageImpl(source, message, max_responses, options, runOptions);
        } finally {
            this.active_message_handlers = Math.max(0, (this.active_message_handlers || 1) - 1);
        }
    }

    _shouldBypassMessageQueue(source, message) {
        const self_prompt = source === 'system' || source === this.name;
        if (self_prompt || convoManager.isOtherAgent(source)) return false;
        const commandName = containsCommand(message);
        return ['!stop', '!stfu', '!restart'].includes(commandName);
    }

    async _handleMessageImpl(source, message, max_responses=null, options={}, runOptions={}) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        console.log('received message from', source, ':', message);

        const interruptEpoch = Number.isFinite(runOptions?.interruptEpoch)
            ? runOptions.interruptEpoch
            : (this.message_interrupt_epoch || 0);
        const isStaleTurn = () => interruptEpoch !== (this.message_interrupt_epoch || 0);
        const checkInterrupt = () => isStaleTurn() || this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);

        if (checkInterrupt()) {
            console.log(`${this.name} skipped stale message from ${source} before starting a ReAct turn.`);
            return used_command;
        }
        
        if (!this.react_messages) {
            this.react_messages = new ReactMessageManager(this);
        }
        const behaviorLog = this.bot.modes.flushBehaviorLog();
        const reactTurn = this.react_messages.startTurn({ source, message, options, behaviorLog });

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (i > 0 && checkInterrupt()) break;
            let history = await reactTurn.buildRequestMessages();
            const llmAbortController = this.beginActiveLLMRequest();
            let res;
            try {
                res = await this.prompter.promptConvo(history, {
                    turnStateKey: reactTurn.turnStateKey,
                    signal: llmAbortController.signal
                });
            } finally {
                this.endActiveLLMRequest(llmAbortController);
            }
            if (isStaleTurn()) {
                console.log(`${this.name} dropped stale response to ${source} after newer user message.`);
                break;
            }

            if (isNativeToolResponse(res)) {
                console.log(`${this.name} native tool calls from ${source}: ${formatNativeToolCallsForLog(res.tool_calls)}`);

                if (checkInterrupt()) {
                    await this._cancelNativeToolCalls(res, 'Tool call interrupted before execution by a newer message, stop command, or shutdown.');
                    used_command = true;
                    this.history.save();
                    break;
                }
                const executedAny = await this._executeNativeToolCalls(res, source, self_prompt, checkInterrupt);
                if (!executedAny) break;
                used_command = true;
                this.history.save();
                continue;
            }

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response');
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                if (this.prompter.isNativeToolMode()) {
                    this.history.add(this.name, res, this.prompter.consumeLastConversationResponseMetadata?.());
                    this.history.add('system', `Text command ${command_name} was not executed. AI actions must use native tool calls; human !command syntax is still supported.`);
                    console.warn('Agent produced text command while native tool mode is enabled:', command_name);
                    continue;
                }
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res, this.prompter.consumeLastConversationResponseMetadata?.());
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name);
                    continue;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                let execute_res = await executeCommand(this, res);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res)
                    this.history.add('system', execute_res);
                else
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res, this.prompter.consumeLastConversationResponseMetadata?.());
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    async _cancelNativeToolCalls(nativeToolResponse, reason) {
        const metadata = nativeToolResponseMetadata(nativeToolResponse);
        for (const toolCall of nativeToolResponse.tool_calls || []) {
            await this.history.addNativeToolCall(toolCall, undefined, metadata);
            await this.history.addNativeToolResult(toolCall, reason || 'Tool call interrupted before execution.');
        }
    }

    _getActiveNativeToolCalls() {
        if (!this.active_native_tool_calls) {
            this.active_native_tool_calls = new Map();
        }
        return this.active_native_tool_calls;
    }

    _getNativeToolCallId(toolCall) {
        return toolCall?.id || toolCall?.function?.id || null;
    }

    _trackActiveNativeToolCall(toolCall) {
        const id = this._getNativeToolCallId(toolCall);
        if (!id) return;
        this._getActiveNativeToolCalls().set(id, { toolCall, completed: false });
    }

    async _completeActiveNativeToolCall(toolCall, result) {
        const id = this._getNativeToolCallId(toolCall);
        if (!id) {
            await this.history.addNativeToolResult(toolCall, result);
            return true;
        }
        const active = this._getActiveNativeToolCalls();
        const entry = active.get(id);
        if (!entry) return false;
        if (entry.completed) return false;
        entry.completed = true;
        active.delete(id);
        await this.history.addNativeToolResult(toolCall, result);
        return true;
    }

    async finishInterruptedNativeToolCalls(reason = 'Tool interrupted by user stop command.') {
        const active = Array.from(this._getActiveNativeToolCalls().values());
        for (const entry of active) {
            await this._completeActiveNativeToolCall(entry.toolCall, reason);
        }
        if (active.length > 0) {
            this.history.save();
        }
        return active.length;
    }

    async _executeNativeToolCalls(nativeToolResponse, source, self_prompt, shouldAbort = () => false) {
        let executedAny = false;
        const metadata = nativeToolResponseMetadata(nativeToolResponse);
        for (const toolCall of nativeToolResponse.tool_calls) {
            if (shouldAbort()) break;
            const commandName = toolCall.name ? (toolCall.name.startsWith('!') ? toolCall.name : `!${toolCall.name}`) : null;
            if (!commandName || !commandExists(commandName)) {
                const msg = `Native tool ${toolCall.name || '<missing>'} does not map to a command.`;
                await this.history.addNativeToolCall(toolCall, undefined, metadata);
                await this.history.addNativeToolResult(toolCall, msg);
                console.warn(msg);
                continue;
            }

            this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(commandName));
            const display = `*used ${toolCall.name}*`;
            await this.history.addNativeToolCall(toolCall, undefined, metadata);
            this._trackActiveNativeToolCall(toolCall);
            this.routeResponse(source, display);
            if (shouldAbort()) {
                await this._completeActiveNativeToolCall(toolCall, 'Tool call interrupted before execution by a newer message, stop command, or shutdown.');
                break;
            }

            console.log(`[native-tool] calling ${commandName} args=${formatToolArgsForLog(toolCall.arguments)}`);
            const execute_res = await executeCommandToolCall(this, toolCall);
            console.log(`[native-tool] ${commandName} result=${formatToolResultForLog(execute_res.result)}`);
            executedAny = true;

            await this._completeActiveNativeToolCall(toolCall, formatNativeToolResultForModel(toolCall, execute_res));
            if (shouldAbort()) break;
        }
        return executedAny;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        const output = prepareChatMessageForOutput(message);
        const spokenMessage = output.spokenMessage;
        message = output.chatMessage;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(spokenMessage, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }

    isHandlingMessage() {
        return (this.active_message_handlers || 0) > 0;
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        this.history.traceEvent('lifecycle_event', { message: msg, exit_code: code });
        this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}


function hasLoadedConversation(saveData) {
    return Boolean(saveData)
        && (Boolean(saveData.memory)
            || (Array.isArray(saveData.turns) && saveData.turns.length > 0));
}

const MINECRAFT_COMMAND_ECHO_PATTERNS = [
    /^Removed \d+ (?:items?|item\(s\)) from .+\]?$/i,
    /^Gave \d+ .+ to .+$/i,
    /^Cleared (?:the )?inventory of .+$/i,
    /^Killed .+$/i,
    /^Summoned new .+$/i,
    /^Set block .+$/i,
    /^Changed the block at .+$/i,
    /^Applied effect .+$/i,
    /^Made .+ say .+$/i,
    /^Played sound .+$/i,
    /^Stopped sound .+$/i,
    /^Located .+ at .+$/i
];

export function isMinecraftCommandEchoMessage(message) {
    const text = String(message ?? '').trim();
    if (!text) return false;
    if (text.startsWith('/')) return true;
    return MINECRAFT_COMMAND_ECHO_PATTERNS.some(pattern => pattern.test(text));
}

export function prepareChatMessageForOutput(message) {
    let spokenMessage = String(message ?? '');
    let remaining = '';
    let command_name = containsCommand(spokenMessage);
    if (command_name && !commandExists(command_name)) {
        command_name = null;
    }
    const commandStart = command_name ? spokenMessage.indexOf(command_name) : -1;
    if (commandStart !== -1) {
        remaining = spokenMessage.substring(commandStart);
        spokenMessage = spokenMessage.substring(0, commandStart);
    }
    return {
        spokenMessage,
        chatMessage: `${spokenMessage.trim()} ${remaining}`
    };
}

function formatNativeToolCallsForLog(toolCalls = []) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        return '<none>';
    }
    return toolCalls
        .map((call, index) => `${index + 1}. ${call.name || '<missing>'}(${formatToolArgsForLog(call.arguments)})`)
        .join('; ');
}

function nativeToolResponseMetadata(nativeToolResponse) {
    if (!nativeToolResponse || typeof nativeToolResponse !== 'object') return {};
    return {
        thinking: nativeToolResponse.thinking,
        thinking_blocks: nativeToolResponse.thinking_blocks,
        thinking_key: nativeToolResponse.thinking_key
    };
}

function formatToolArgsForLog(args) {
    if (args == null || args === '') return '{}';
    if (typeof args === 'string') {
        try {
            return truncateForLog(JSON.stringify(JSON.parse(args)));
        } catch {
            return truncateForLog(args);
        }
    }
    try {
        return truncateForLog(JSON.stringify(args));
    } catch {
        return truncateForLog(String(args));
    }
}

function formatToolResultForLog(result) {
    if (result == null || result === '') return '<empty>';
    return truncateForLog(typeof result === 'string' ? result : JSON.stringify(result));
}

function formatNativeToolResultForModel(toolCall, executeResult) {
    const result = executeResult?.result;
    if (result != null && result !== '') {
        return result;
    }
    const name = toolCall?.name || toolCall?.function?.name || 'tool';
    if (executeResult?.ok === false) {
        return `Tool ${name} failed without returning details.`;
    }
    return `Tool ${name} completed.`;
}

function truncateForLog(value, max = 500) {
    const text = String(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
}
