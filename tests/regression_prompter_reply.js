import { Prompter } from '../src/models/prompter.js';
import settings from '../src/agent/settings.js';
settings.base_profile = 'assistant';
settings.num_examples = 2;

const profile = {
    name: 'Bot',
    model: 'ollama/llama3',
    cooldown: 0,
    conversing: 'CONVO: $CONVO',
};

const agent = {
    name: 'Bot',
    self_prompter: { isStopped: () => true, prompt: '' },
    history: { memory: '' },
    actions: { currentActionLabel: '' },
    task: { task_id: null },
};

let calls = 0;
const prompter = new Prompter(agent, profile);
prompter.chat_model = {
    async sendRequest(messages, prompt) {
        calls++;
        if (calls === 1) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return 'PLAYER_REPLY';
        }
        return 'NEWER_REPLY';
    },
};

const history = [{ role: 'user', content: 'hello' }];

// Player reply must survive a newer prompt that starts during generation.
let playerResultPromise = prompter.promptConvo(history, true);
await new Promise((resolve) => setTimeout(resolve, 10));
const newerDuringPlayer = prompter.promptConvo(history, false);
const playerResult = await playerResultPromise;
const newerResult = await newerDuringPlayer;

if (playerResult !== 'PLAYER_REPLY') {
    console.error('FAIL: player reply was superseded:', JSON.stringify(playerResult));
    process.exit(1);
}
console.log('PASS: player reply survives newer prompt during generation');

// Reset call counter for bot-to-bot scenario.
calls = 0;
let botCalls = 0;
prompter.chat_model = {
    async sendRequest(messages, prompt) {
        botCalls++;
        if (botCalls === 1) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return 'BOT_REPLY';
        }
        return 'NEWER_BOT_REPLY';
    },
};

// Bot-to-bot reply must still be superseded by a newer bot message.
let botResultPromise = prompter.promptConvo(history, false);
await new Promise((resolve) => setTimeout(resolve, 10));
const newerBot = prompter.promptConvo(history, false);
const botResult = await botResultPromise;
const newerBotResult = await newerBot;

if (botResult !== '') {
    console.error('FAIL: bot-to-bot reply was not superseded:', JSON.stringify(botResult));
    process.exit(1);
}
if (newerBotResult !== 'NEWER_BOT_REPLY') {
    console.error('FAIL: newer bot reply did not win:', JSON.stringify(newerBotResult));
    process.exit(1);
}
console.log('PASS: bot-to-bot reply is superseded by newer bot message');

console.log('All regressions passed.');
process.exit(0);