import assert from 'assert';
import { AsyncLocalStorage } from 'async_hooks';

// how long a running action gets to wind down after being asked to stop
const STOP_GRACE_MS = 10000;
// if actions have to be abandoned this often, something is badly wedged and a restart is the safer bet
const MAX_ABANDONED = 3;
const ABANDON_WINDOW_MS = 5 * 60 * 1000;

export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
        // every action runs with its own generation number. an action that refuses to stop is abandoned by
        // bumping the generation, which also makes bot.interrupt_code read true for it from then on
        this.generation = 0;
        this.context = new AsyncLocalStorage();
        this._abandon = null;
        this.abandon_times = [];
    }

    installInterruptFlag(bot) {
        /* bot.interrupt_code is checked all over the skills and generated code. Make it per action, so an
           abandoned action keeps seeing itself as interrupted even after the next action clears the flag. */
        let flag = false;
        const manager = this;
        Object.defineProperty(bot, 'interrupt_code', {
            configurable: true,
            enumerable: true,
            get() {
                const ctx = manager.context.getStore();
                if (ctx && ctx.generation !== manager.generation) return true;
                return flag;
            },
            set(value) {
                flag = value;
            }
        });
    }

    async resumeAction(actionLabel = null, actionFn = null, timeout = 10) {
        return this._executeResume(actionLabel, actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout);
        }
    }

    async stop() {
        if (!this.executing) return;
        const start = Date.now();
        // only stop the action that's running now: once it's done, a newer one may start (e.g. right after a
        // timeout), and that one must not be interrupted by this old request
        const gen = this.generation;
        while (this.executing && this.generation === gen) {
            this.agent.requestInterrupt();
            if (Date.now() - start > STOP_GRACE_MS) {
                if (!this._abandon) {
                    this.agent.cleanKill('Code execution refused stop after 10 seconds. Killing process.');
                    return;
                }
                this._abandonCurrent();
                break;
            }
            console.log('waiting for code to finish executing...');
            await new Promise(resolve => setTimeout(resolve, 300));
        }
    }

    _abandonCurrent() {
        /* The action ignored the interrupt (usually stuck awaiting something that never settles). Instead of
           killing the whole process, stop waiting for it: the manager goes idle right away, and the old action
           sees bot.interrupt_code as true if it ever wakes up again. */
        const label = this.currentActionLabel;
        console.warn(`Action "${label}" did not stop after ${STOP_GRACE_MS / 1000} seconds. Abandoning it.`);
        const now = Date.now();
        this.abandon_times = this.abandon_times.filter(t => now - t < ABANDON_WINDOW_MS);
        this.abandon_times.push(now);
        if (this.abandon_times.length >= MAX_ABANDONED) {
            this.agent.cleanKill(`Had to abandon ${this.abandon_times.length} stuck actions in a few minutes. Restarting.`);
            return;
        }
        const abandon = this._abandon;
        this._abandon = null;
        this.generation++;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.agent.stopBotActivity();
        abandon();
    }

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
            this.resume_count = 0;
            this.resume_timeout = timeout;
        }
        else if (this.resume_timeout !== undefined) {
            // resumed with the time limit it started with: the idle handler's default (10 minutes) cut a speedrun's
            // portal cast off partway, though the stage itself has no limit
            timeout = this.resume_timeout;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            // the same step interrupted again and again (stuck planning a path to one block, the unstuck mode moving
            // us away, back to it) looped a speedrun's kit for minutes: give up on it after a few tries. fights don't
            // count: a stage among a lot of mobs is interrupted by every one of them, and that's no reason to stop
            if (!new_resume && this.last_interrupter === 'mode:unstuck' && ++this.resume_count > 4) {
                console.log(`Resumed ${this.resume_name} ${this.resume_count - 1} times, giving up on it.`);
                this.cancelResume();
                return { success: false, message: null, interrupted: false, timedout: false };
            }
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout);
            this.currentActionLabel = '';
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10) {
        let TIMEOUT;
        let gen = null;
        let abandoned = false;
        let abandoned_timedout = false;
        try {
            if (this.last_action_time > 0) {
                let time_diff = Date.now() - this.last_action_time;
                if (time_diff < 20) {
                    this.recent_action_counter++;
                }
                else {
                    this.recent_action_counter = 0;
                }
                if (this.recent_action_counter > 3) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume(); // likely cause of repetition
                }
                if (this.recent_action_counter > 5) {
                    console.error('Infinite action loop detected, shutting down.');
                    this.agent.cleanKill('Infinite action loop detected, shutting down.');
                    return { success: false, message: 'Infinite action loop detected, shutting down.', interrupted: false, timedout: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');

            // await current action to finish (executing=false), with 10 seconds timeout
            // also tell agent.bot to stop various actions
            if (this.executing) {
                console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}"`);
                this.last_interrupter = actionLabel;
            }
            await this.stop();

            // clear bot logs and reset interrupt code
            this.agent.clearBotLogs();
            this.timedout = false;

            gen = ++this.generation;
            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;

            // timeout in minutes
            if (timeout > 0) {
                TIMEOUT = this._startTimeout(timeout);
            }

            // start the action, in its own context so it can tell when it has been abandoned
            const action_promise = Promise.resolve(this.context.run({ generation: gen }, actionFn));
            await new Promise((resolve, reject) => {
                this._abandon = () => {
                    abandoned = true;
                    abandoned_timedout = this.timedout;
                    resolve();
                };
                action_promise.then(resolve, reject);
            });
            clearTimeout(TIMEOUT);

            if (abandoned) {
                // stop() already reset the manager state, and a newer action may be running now
                return { success: false, message: 'Action was abandoned because it would not stop.', interrupted: true, timedout: abandoned_timedout };
            }

            // mark action as finished + cleanup
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            this._abandon = null;

            // get bot activity summary
            let output = this.getBotOutputSummary();
            let interrupted = this.agent.bot.interrupt_code;
            let timedout = this.timedout;
            this.agent.clearBotLogs();

            // if not interrupted and not generating, emit idle event
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            return { success: true, message: output, interrupted, timedout };
        } catch (err) {
            clearTimeout(TIMEOUT);
            if (abandoned || (gen !== null && gen !== this.generation)) {
                console.warn(`Abandoned action "${actionLabel}" threw:`, err);
                return { success: false, message: null, interrupted: true, timedout: false };
            }
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            this._abandon = null;
            // an error from being interrupted (a mode stopping a dig: "Digging aborted") isn't the action failing, so
            // keep its resume: cancelling it here ended a scripted stretch of a speedrun every time a mode cut in
            if (!this.agent.bot.interrupt_code)
                this.cancelResume();
            console.error("Code execution triggered catch:", err);
            // Log the full stack trace
            console.error(err.stack);
            // don't leave the bot walking or digging towards whatever the failed action wanted
            this.agent.stopBotActivity();

            let message = this.getBotOutputSummary() +
                '!!Code threw exception!!\n' +
                'Error: ' + String(err) + '\n' +
                'Stack trace:\n' + err?.stack + '\n';

            let interrupted = this.agent.bot.interrupt_code;
            this.agent.clearBotLogs();
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted, timedout: false };
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    _startTimeout(TIMEOUT_MINS = 10) {
        return setTimeout(async () => {
            console.warn(`Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            this.timedout = true;
            this.agent.history.add('system', `Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            await this.stop(); // last attempt to stop
        }, TIMEOUT_MINS * 60 * 1000);
    }

}
