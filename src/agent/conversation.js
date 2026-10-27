import settings from './settings.js';
import { containsCommand } from './commands/index.js';
import { sendBotChatToServer } from './mindserver_proxy.js';

let agent;
let agent_names = [];
let agents_in_game = [];

class Conversation {
    constructor(name) {
        this.name = name;
        this.active = false;
        this.ignore_until_start = false;
        this.blocked = false;
        this.in_queue = [];
        this.inMessageTimer = null;
        this.inMessageGeneration = 0;
    }

    _clearInMessageTimer() {
        if (this.inMessageTimer)
            clearTimeout(this.inMessageTimer);
        this.inMessageTimer = null;
        this.inMessageGeneration++;
    }

    reset() {
        this.active = false;
        this.ignore_until_start = false;
        this._clearInMessageTimer();
        this.in_queue = [];
    }

    end() {
        this.active = false;
        this.ignore_until_start = true;
        this._clearInMessageTimer();
        // Drop queued-but-unprocessed inbound bot messages when the conversation is
        // explicitly ended. If we append them here, they surface later as a stale
        // "new" user turn and can break prompt-cache prefix continuity. Messages
        // that are actually processed go through _processInMessageQueue instead.
        this.in_queue = [];

        if (agent.last_sender === this.name)
            agent.last_sender = null;
    }

    queue(message) {
        this.in_queue.push(message);
    }
}

const WAIT_TIME_START = 30000;
class ConversationManager {
    constructor() {
        this.convos = {};
        this.activeConversation = null;
        this.awaiting_response = false;
        this.connection_timeout = null;
        this.wait_time_limit = WAIT_TIME_START;
    }

    initAgent(a) {
        agent = a;
    }

    _getConvo(name) {
        if (!this.convos[name])
            this.convos[name] = new Conversation(name);
        return this.convos[name];
    }

    _startMonitor() {
        clearInterval(this.connection_monitor);
        let wait_time = 0;
        let last_time = Date.now();
        this.connection_monitor = setInterval(() => {
            if (!this.activeConversation) {
                this._stopMonitor();
                return; // will clean itself up
            }

            let delta = Date.now() - last_time;
            last_time = Date.now();
            let convo_partner = this.activeConversation.name;

            if (this.awaiting_response && agent.isIdle()) {
                wait_time += delta;
                if (wait_time > this.wait_time_limit) {
                    agent.handleMessage('system', `${convo_partner} hasn't responded in ${this.wait_time_limit/1000} seconds, respond with a message to them or your own action.`);
                    wait_time = 0;
                    this.wait_time_limit*=2;
                }
            }
            else if (!this.awaiting_response){
                this.wait_time_limit = WAIT_TIME_START;
                wait_time = 0;
            }

            if (!this.otherAgentInGame(convo_partner) && !this.connection_timeout) {
                this.connection_timeout = setTimeout(() => {
                    if (this.otherAgentInGame(convo_partner)){
                        this._clearMonitorTimeouts();
                        return;
                    }
                    if (!agent.self_prompter.isPaused()) {
                        this.endConversation(convo_partner);
                        agent.handleMessage('system', `${convo_partner} disconnected, conversation has ended.`);
                    }
                    else {
                        this.endConversation(convo_partner);
                    }
                }, 10000);
            }
        }, 1000);
    }

    _stopMonitor() {
        clearInterval(this.connection_monitor);
        this.connection_monitor = null;
        this._clearMonitorTimeouts();
    }

    _clearMonitorTimeouts() {
        this.awaiting_response = false;
        clearTimeout(this.connection_timeout);
        this.connection_timeout = null;
    }

    async startConversation(send_to, message) {
        const convo = this._getConvo(send_to);
        convo.reset();
        
        if (agent.self_prompter.isActive()) {
            await agent.self_prompter.pause();
        }
        if (convo.active)
            return;
        convo.active = true;
        this.activeConversation = convo;
        this._startMonitor();
        this.sendToBot(send_to, message, true, false);
    }

    startConversationFromOtherBot(name) {
        const convo = this._getConvo(name);
        convo.active = true;
        this.activeConversation = convo;
        this._startMonitor();
    }

    sendToBot(send_to, message, start=false, open_chat=true) {
        if (!this.isOtherAgent(send_to)) {
            console.warn(`${agent.name} tried to send bot message to non-bot ${send_to}`);
            return;
        }
        const convo = this._getConvo(send_to);
        
        if (settings.chat_bot_messages && open_chat)
            agent.openChat(`(To ${send_to}) ${message}`);
        
        if (convo.ignore_until_start)
            return;
        convo.active = true;
        
        const end = message.includes('!endConversation');
        const json = {
            'message': message,
            start,
            end,
        };

        this.awaiting_response = true;
        sendBotChatToServer(send_to, json);
    }

    async receiveFromBot(sender, received) {
        const convo = this._getConvo(sender);

        if (convo.ignore_until_start && !received.start)
            return;

        // check if any convo is active besides the sender
        if (this.inConversation() && !this.inConversation(sender)) {
            this.sendToBot(sender, `I'm talking to someone else, try again later. !endConversation("${sender}")`, false, false);
            this.endConversation(sender);
            return;
        }

        if (received.start) {
            convo.reset();
            this.startConversationFromOtherBot(sender);
        }

        this._clearMonitorTimeouts();
        convo.queue(received);
        convo.inMessageGeneration++;
        
        // responding to conversation takes priority over self prompting
        if (agent.self_prompter.isActive()){
            await agent.self_prompter.pause();
        }
    
        void _scheduleProcessInMessage(sender, received, convo);
    }

    responseScheduledFor(sender) {
        if (!this.isOtherAgent(sender) || !this.inConversation(sender))
            return false;
        const convo = this._getConvo(sender);
        return !!convo.inMessageTimer;
    }

    isOtherAgent(name) {
        return agent_names.some((n) => n === name);
    }

    otherAgentInGame(name) {
        return agents_in_game.some((n) => n === name);
    }
    
    updateAgents(agents) {
        agent_names = agents.map(a => a.name);
        agents_in_game = agents.filter(a => a.in_game).map(a => a.name);
    }

    getInGameAgents() {
        return agents_in_game;
    }
    
    inConversation(other_agent=null) {
        if (other_agent)
            return this.convos[other_agent]?.active;
        return Object.values(this.convos).some(c => c.active);
    }
    
    endConversation(sender) {
        if (this.convos[sender]) {
            this.convos[sender].end();
            if (this.activeConversation?.name === sender) {
                this._stopMonitor();
                this.activeConversation = null;
                if (agent.self_prompter.isPaused() && !this.inConversation()) {
                    void _resumeSelfPrompter();
                }
            }
        }
    }
    
    endAllConversations() {
        for (const sender in this.convos) {
            this.endConversation(sender);
        }
        if (agent.self_prompter.isPaused()) {
            void _resumeSelfPrompter();
        }
    }

    forceEndCurrentConversation() {
        if (this.activeConversation) {
            let sender = this.activeConversation.name;
            this.sendToBot(sender, '!endConversation("' + sender + '")', false, false);
            this.endConversation(sender);
        }
    }
}

const convoManager = new ConversationManager();
export default convoManager;

/*
This function controls conversation flow by deciding when the bot responds.
The logic is as follows:
- If neither bot is busy, respond quickly with a small delay.
- If only the other bot is busy, respond with a long delay to allow it to finish short actions (ex check inventory)
- If I'm busy but other bot isn't, let LLM decide whether to respond
- If both bots are busy, don't respond until someone is done, excluding a few actions that allow fast responses
- New messages received during the delay will reset the delay following this logic, and be queued to respond in bulk
*/
const talkOverActions = ['stay', 'followPlayer', 'mode:']; // all mode actions
const fastDelay = 200;
const longDelay = 5000;
async function _scheduleProcessInMessage(sender, received, convo) {
    if (convo.inMessageTimer) {
        clearTimeout(convo.inMessageTimer);
        convo.inMessageGeneration++;
    }
    const pending = compileQueuedBotMessages(convo.in_queue);
    const decisionMessage = pending?.message || received.message || '';
    const otherAgentBusy = isOtherBotActionNotice(decisionMessage);

    const scheduleResponse = (delay) => {
        const generation = convo.inMessageGeneration;
        const timer = setTimeout(() => _processInMessageQueue(sender, convo, generation, timer), delay);
        convo.inMessageTimer = timer;
    };

    const currentAction = agent.actions?.currentActionLabel || '';
    const canTalkOver = talkOverActions.some(a => currentAction.includes(a));
    const agentBusy = Boolean(currentAction) || !agent.isIdle() || (agent.active_message_handlers || 0) > 0;

    if (agentBusy && otherAgentBusy && !canTalkOver) {
        convo.in_queue = [];
        convo.inMessageTimer = null;
    }
    else if (otherAgentBusy) {
        // The other bot is reporting an action; give it a moment so consecutive
        // action notices can be consumed together with stable boundaries.
        scheduleResponse(longDelay);
    }
    else if (agentBusy && !canTalkOver) {
        const decisionGeneration = convo.inMessageGeneration;
        const shouldRespond = await agent.prompter.promptShouldRespondToBot(
            `${sender}: ${_tagMessage(decisionMessage)}`,
            { cacheScope: 'botResponder' }
        );
        if (decisionGeneration !== convo.inMessageGeneration)
            return;
        console.log(`${agent.name} decided to ${shouldRespond?'respond':'ignore'} ${sender}`);
        if (shouldRespond) {
            scheduleResponse(fastDelay);
        }
        else {
            convo.in_queue = [];
            convo.inMessageTimer = null;
        }
    }
    else {
        scheduleResponse(fastDelay);
    }
}

function isOtherBotActionNotice(message) {
    const text = String(message || '').trim();
    return Boolean(containsCommand(text) || /^\*used\s+\w+\*/.test(text) || /^State update:/i.test(text));
}

function _processInMessageQueue(name, expectedConvo=null, expectedGeneration=null, expectedTimer=null) {
    const convo = convoManager._getConvo(name);
    if (expectedConvo && convo !== expectedConvo)
        return false;
    if (expectedGeneration !== null && convo.inMessageGeneration !== expectedGeneration)
        return false;
    if (expectedTimer && convo.inMessageTimer !== expectedTimer)
        return false;

    const received = _compileInMessages(convo);
    if (!received?.message?.trim()) {
        convo.inMessageTimer = null;
        return false;
    }

    _handleFullInMessage(name, received);
    return true;
}

export function compileQueuedBotMessages(queue) {
    if (!queue.length)
        return null;

    const messages = queue.map(pack => pack.message ?? '');
    return {
        ...queue[queue.length - 1],
        start: queue.some(pack => pack.start),
        end: queue.some(pack => pack.end),
        message: messages.join('\n'),
    };
}

function _compileInMessages(convo) {
    const compiled = compileQueuedBotMessages(convo.in_queue);
    convo.in_queue = [];
    return compiled;
}

function _handleFullInMessage(sender, received) {
    console.log(`${agent.name} responding to "${received.message}" from ${sender}`);
    
    const convo = convoManager._getConvo(sender);
    convo.active = true;

    let message = _tagMessage(received.message);
    if (received.end) {
        convoManager.endConversation(sender);
        message = `Conversation with ${sender} ended with message: "${message}"`;
        sender = 'system'; // bot will respond to system instead of the other bot
    }
    else if (received.start)
        agent.shut_up = false;
    convo.inMessageTimer = null;
    agent.handleMessage(sender, message);
}


function _tagMessage(message) {
    return "(FROM OTHER BOT)\n" + message;
}

async function _resumeSelfPrompter() {
    await new Promise(resolve => setTimeout(resolve, 5000));
    if (agent.self_prompter.isPaused() && !convoManager.inConversation()) {
        agent.self_prompter.start();
    }
}
