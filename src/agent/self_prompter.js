import { commandExists, containsCommand, executeCommand } from './commands/index.js';
import {
    MAX_CONSECUTIVE_FAILURES,
    MAX_REPEATED_ACTIONS_WITHOUT_PROGRESS,
    getAutonomousCommandNames,
    getAutonomousStopReason,
    isAutonomousCommandNameAllowed
} from './autonomous_policy.js';

export { parseTaskDecision } from './autonomous_policy.js';

const STOPPED = 0;
const ACTIVE = 1;
const PAUSED = 2;
const FAILURE_PATTERN = /\b(fail(?:ed|ure)?|error|cannot|could not|not found|timeout|timed out|exception|invalid)\b/i;

function inventorySignature(bot) {
    const counts = {};
    for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] || 0) + item.count;
    return Object.keys(counts).sort().map(name => `${name}:${counts[name]}`).join(',');
}

function progressSignature(agent) {
    const pos = agent.bot.entity.position;
    return `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}|${agent.bot.health}|${agent.bot.food}|${inventorySignature(agent.bot)}`;
}

export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        this.cooldown = 2000;
        this.plan = [];
        this.current_step = '';
        this.last_result = '';
        this.last_command = '';
        this.last_signature = '';
        this.repeated_actions = 0;
        this.consecutive_failures = 0;
        this.steps_taken = 0;
    }

    start(prompt) {
        if (!prompt) return 'No prompt specified. Ignoring request.';
        if (this.prompt !== prompt || this.state === STOPPED) this.resetProgress();
        this.prompt = prompt;
        this.state = ACTIVE;
        console.log(`Autonomous task started: ${prompt}`);
        this.startLoop();
        return `Autonomous task started: ${prompt}`;
    }

    resetProgress() {
        this.plan = [];
        this.current_step = '';
        this.last_result = '';
        this.last_command = '';
        this.last_signature = '';
        this.repeated_actions = 0;
        this.consecutive_failures = 0;
        this.steps_taken = 0;
    }

    getProgress() {
        return {
            plan: this.plan,
            current_step: this.current_step,
            last_result: this.last_result,
            last_command: this.last_command,
            last_signature: this.last_signature,
            repeated_actions: this.repeated_actions,
            consecutive_failures: this.consecutive_failures,
            steps_taken: this.steps_taken
        };
    }

    restoreProgress(progress = {}) {
        this.plan = Array.isArray(progress.plan) ? progress.plan : [];
        this.current_step = progress.current_step || '';
        this.last_result = progress.last_result || '';
        this.last_command = progress.last_command || '';
        this.last_signature = progress.last_signature || '';
        this.repeated_actions = Math.max(0, Number(progress.repeated_actions) || 0);
        this.consecutive_failures = Math.max(0, Number(progress.consecutive_failures) || 0);
        this.steps_taken = Math.max(0, Number(progress.steps_taken) || 0);
    }

    statusText() {
        if (this.state === STOPPED) return 'No autonomous task is active.';
        const plan = this.plan.length ? this.plan.map((step, i) => `${i + 1}. ${step}`).join('\n') : 'Plan pending.';
        return `Goal: ${this.prompt}\nCurrent step: ${this.current_step || 'Planning'}\nSteps taken: ${this.steps_taken}\nFailures: ${this.consecutive_failures}\nPlan:\n${plan}`;
    }

    isActive() { return this.state === ACTIVE; }
    isStopped() { return this.state === STOPPED; }
    isPaused() { return this.state === PAUSED; }

    handleLoad(prompt, state, progress = null) {
        this.state = state ?? STOPPED;
        this.prompt = prompt || '';
        if (progress) this.restoreProgress(progress);
        if (this.state === ACTIVE && this.prompt) this.startLoop();
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.resetProgress();
        this.state = PAUSED;
    }

    async collectObservation() {
        const get = name => this.agent.prompter.getCommandOutput(name);
        const [stats, inventory, blocks, entities, craftable] = await Promise.all([
            get('!stats'), get('!inventory'), get('!nearbyBlocks'), get('!entities'), get('!craftable')
        ]);
        return [stats, inventory, blocks, entities, craftable].join('\n').slice(0, 7000);
    }

    async waitForNextStep() {
        if (this.cooldown > 0) {
            await new Promise(resolve => setTimeout(resolve, this.cooldown));
        }
    }

    async stopIfLimitReached() {
        const reason = getAutonomousStopReason({
            stepsTaken: this.steps_taken,
            consecutiveFailures: this.consecutive_failures
        });
        if (!reason) return false;

        const includeLastResult = this.consecutive_failures >= MAX_CONSECUTIVE_FAILURES && this.last_result;
        await this.finish(
            'blocked',
            includeLastResult ? `${reason} Last result: ${this.last_result}` : reason
        );
        return true;
    }

    async startLoop() {
        if (this.loop_active || this.state !== ACTIVE) return;
        this.loop_active = true;
        this.interrupt = false;

        try {
            while (!this.interrupt && this.state === ACTIVE) {
                if (await this.stopIfLimitReached()) break;

                const observation = await this.collectObservation();
                const signature = progressSignature(this.agent);
                const decision = await this.agent.prompter.promptTaskStep({
                    goal: this.prompt,
                    plan: this.plan,
                    current_step: this.current_step,
                    last_command: this.last_command,
                    last_result: this.last_result,
                    consecutive_failures: this.consecutive_failures,
                    repeated_actions: this.repeated_actions,
                    steps_taken: this.steps_taken,
                    allowed_commands: getAutonomousCommandNames(),
                    observation
                });

                this.plan = decision.plan.length ? decision.plan : this.plan;
                this.current_step = decision.current_step;

                if (decision.status !== 'active') {
                    await this.finish(decision.status, decision.reason);
                    break;
                }

                const commandName = containsCommand(decision.command);
                if (
                    !commandName ||
                    !commandExists(commandName) ||
                    !isAutonomousCommandNameAllowed(commandName)
                ) {
                    this.recordFailure(`Rejected unsafe or invalid autonomous command: ${decision.command}`);
                    await this.persistProgress();
                    if (await this.stopIfLimitReached()) break;
                    await this.waitForNextStep();
                    continue;
                }

                if (decision.command === this.last_command && signature === this.last_signature) {
                    this.repeated_actions++;
                } else {
                    this.repeated_actions = 0;
                }
                if (this.repeated_actions >= MAX_REPEATED_ACTIONS_WITHOUT_PROGRESS) {
                    this.recordFailure(`No progress after repeating ${decision.command}. Choose a different strategy.`);
                    this.last_command = decision.command;
                    this.last_signature = signature;
                    await this.persistProgress();
                    if (await this.stopIfLimitReached()) break;
                    await this.waitForNextStep();
                    continue;
                }

                this.last_command = decision.command;
                this.last_signature = signature;
                this.steps_taken++;
                console.log(`Autonomous step ${this.steps_taken}: ${decision.command} (${decision.reason})`);

                const result = await executeCommand(this.agent, decision.command);
                this.last_result = result || 'Command completed without a result message.';
                if (FAILURE_PATTERN.test(this.last_result)) this.consecutive_failures++;
                else this.consecutive_failures = 0;

                await this.agent.history.add('system',
                    `AUTONOMOUS TASK STEP ${this.steps_taken}\nGoal: ${this.prompt}\nStep: ${this.current_step}\nCommand: ${decision.command}\nResult: ${this.last_result}`
                );
                await this.persistProgress();

                if (await this.stopIfLimitReached()) break;
                await this.waitForNextStep();
            }
        } catch (error) {
            console.error('Autonomous task loop failed:', error);
            await this.finish('blocked', error.message);
        } finally {
            this.loop_active = false;
            this.interrupt = false;
        }
    }

    recordFailure(message) {
        this.last_result = message;
        this.consecutive_failures++;
        console.warn(message);
    }

    async persistProgress() {
        await this.agent.history.save();
    }

    async finish(status, reason) {
        const goal = this.prompt;
        this.state = STOPPED;
        this.interrupt = true;
        const shortReason = String(reason || '').replace(/\s+/g, ' ').slice(0, 200);
        const message = status === 'completed'
            ? `Goal completed: ${goal}`
            : `Goal blocked: ${goal}${shortReason ? `. ${shortReason}` : ''}`;
        this.last_result = message;
        this.agent.openChat(message);
        await this.agent.history.add('system', message);
        await this.agent.history.save();
    }

    update(delta) {
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            this.idle_time = this.agent.isIdle() ? this.idle_time + delta : 0;
            if (this.idle_time >= this.cooldown) {
                this.idle_time = 0;
                this.startLoop();
            }
        } else {
            this.idle_time = 0;
        }
    }

    async stopLoop() {
        this.interrupt = true;
        while (this.loop_active) await new Promise(resolve => setTimeout(resolve, 200));
    }

    async stop(stop_action = true) {
        this.state = STOPPED;
        this.interrupt = true;
        if (stop_action) await this.agent.actions.stop();
        await this.stopLoop();
    }

    async pause() {
        this.state = PAUSED;
        this.interrupt = true;
        await this.agent.actions.stop();
        await this.stopLoop();
    }

    shouldInterrupt(is_self_prompt) {
        return is_self_prompt && (this.state === ACTIVE || this.state === PAUSED) && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        if (!is_self_prompt && is_action) this.stopLoop();
    }
}
