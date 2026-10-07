import { executeCommand } from './commands/index.js';
import { getScriptedStage } from './commands/queries.js';

const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        this.cooldown = 2000;
    }

    start(prompt) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        this.state = ACTIVE;
        this.prompt = prompt;
        this.startLoop();
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    async handleLoad(prompt, state) {
        if (state == undefined)
            state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE) {
            await this.start(prompt);
        }
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.state = PAUSED;
    }

    async startLoop() {
        if (this.loop_active) {
            console.warn('Self-prompt loop is already active. Ignoring request.');
            return;
        }
        console.log('starting self-prompt loop')
        this.loop_active = true;
        let no_command_count = 0;
        const MAX_NO_COMMAND = 3;
        while (!this.interrupt) {
            // in a speedrun, a scripted stretch that's the next step runs straight away instead of asking the model:
            // told to use !speedrunKit, it went on mining iron and gold by hand, 10 minutes of it
            // a mode still going (a fight, picking things up) first: asked while one was, the model went off to attack
            // a zombie in the middle of the kit
            if (this.agent.task?.task_type === 'beat_game')
                for (let t = 0; t < 30 && !this.agent.isIdle() && !this.interrupt; t++) await new Promise(r => setTimeout(r, 500));
            const stage = this.agent.task?.task_type === 'beat_game' && this.agent.isIdle() ? getScriptedStage(this.agent.bot) : null;
            if (stage) {
                console.log(`[autopilot] running !${stage}`);
                // through the task, which prints its progress to the run log as it goes and waits out resumes after a
                // mode cuts in
                const result = this.agent.task.runScripted
                    ? await this.agent.task.runScripted(`!${stage}`, 12, false)
                    : await executeCommand(this.agent, `!${stage}`);
                // the speedrun stages note their own tries (actions.js playStage): note the others', so a stretch that
                // stopped short is left to the model for a while instead of run again and again
                // (only once it's done or given up: one cut short by a fight just goes on)
                if (!stage.startsWith('speedrun') && /You have \d+|No blazes|No nether fortress|Go to the nether/.test(result || '')) {
                    const bot = this.agent.bot;
                    bot.stage_tries = bot.stage_tries || {};
                    bot.stage_tries[stage] = Date.now();
                }
                if (result)
                    await this.agent.history.add('system', `!${stage} ran (the next step, run for you): ${result}`);
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
            const msg = `You are self-prompting with the goal: '${this.prompt}'. Your next response MUST contain a command with this syntax: !commandName. Respond:`;

            let used_command = await this.agent.handleMessage('system', msg, -1);
            if (!used_command) {
                no_command_count++;
                if (no_command_count >= MAX_NO_COMMAND && this.agent.task?.data) {
                    // a task's goal must keep going: replies thrown away mid-generation count as no command, and
                    // stopping here left the bot idle for the rest of the run
                    console.warn(`No command in the last ${MAX_NO_COMMAND} auto-prompts, carrying on with the task.`);
                    no_command_count = 0;
                    await new Promise(r => setTimeout(r, 2000));
                }
                else if (no_command_count >= MAX_NO_COMMAND) {
                    let out = `Agent did not use command in the last ${MAX_NO_COMMAND} auto-prompts. Stopping auto-prompting.`;
                    this.agent.openChat(out);
                    console.warn(out);
                    this.state = STOPPED;
                    break;
                }
            }
            else {
                no_command_count = 0;
                await new Promise(r => setTimeout(r, this.cooldown));
            }
        }
        console.log('self prompt loop stopped')
        this.loop_active = false;
        this.interrupt = false;
    }

    update(delta) {
        // automatically restarts loop
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this.cooldown) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
        }
        else {
            this.idle_time = 0;
        }
    }

    async stopLoop() {
        // you can call this without await if you don't need to wait for it to finish
        if (this.interrupt)
            return;
        console.log('stopping self-prompt loop')
        this.interrupt = true;
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true) {
        this.interrupt = true;
        if (stop_action)
            await this.agent.actions.stop();
        this.stopLoop();
        this.state = STOPPED;
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop();
        this.stopLoop();
        this.state = PAUSED;
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && (this.state === ACTIVE || this.state === PAUSED) && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop();
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }
}