export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.resume_guard = null;
        this.resume_options = null;
        this.lastInterruption = null;
        this.managedResumeSessions = new Set();
        this.transitionReservations = 0;
        this.last_action_time = 0;
        this.recent_action_counter = 0;
    }

    async resumeAction(actionFn, timeout) {
        return this._executeResume(actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false, managedSession = null } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            // A queued/active managed resume belongs to the interrupted action.
            // Do not let a replacement action invalidate the session it just started.
            if (!String(actionLabel).startsWith('mode:')) this.cancelManagedResumeForReplacement(managedSession);
            return this._executeAction(actionLabel, actionFn, timeout);
        }
    }

    beginManagedResume(onCancel, actionLabel = null) {
        const session = { cancelled: false, onCancel, actionLabel, cancelCalled: false };
        this.managedResumeSessions.add(session);
        return session;
    }

    finishManagedResume(session) {
        if (session) this.managedResumeSessions.delete(session);
    }

    hasPendingManagedResumeFor(actionLabel) {
        return this.resume_name === actionLabel
            || [...this.managedResumeSessions].some((session) => session.actionLabel === actionLabel);
    }

    cancelManagedSession(session) {
        if (!session || session.cancelCalled) return;
        session.cancelled = true;
        session.cancelCalled = true;
        this.managedResumeSessions.delete(session);
        try { session.onCancel?.(); } catch (error) { console.error('Managed resume cancellation callback failed:', error); }
    }

    cancelManagedResumeForReplacement(except = null) {
        if (this.resume_options?.cancelOnReplacement) this.cancelResume();
        for (const session of [...this.managedResumeSessions]) {
            if (session !== except) this.cancelManagedSession(session);
        }
    }

    reserveTransition() {
        this.transitionReservations++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.transitionReservations = Math.max(0, this.transitionReservations - 1);
        };
    }

    registerResume(actionLabel, actionFn, {
        guard = null,
        onCancel = null,
        cancelOnSuccess = false,
        cancelOnReplacement = false,
        managedSession = null,
    } = {}) {
        if (managedSession?.cancelled) return false;
        this.resume_name = actionLabel;
        this.resume_func = actionFn;
        this.resume_guard = guard;
        this.resume_options = { onCancel, cancelOnSuccess, cancelOnReplacement, managedSession };
        return true;
    }

    async stop() {
        if (!this.executing) return;
        const timeout = setTimeout(() => {
            this.agent.cleanKill('Code execution refused stop after 10 seconds. Killing process.');
        }, 10000);
        while (this.executing) {
            this.agent.requestInterrupt();
            console.log('waiting for code to finish executing...');
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        clearTimeout(timeout);
    } 

    cancelResume() {
        const managedSession = this.resume_options?.managedSession;
        const onCancel = this.resume_options?.onCancel;
        this.resume_func = null;
        this.resume_name = null;
        this.resume_guard = null;
        this.resume_options = null;
        this.lastInterruption = null;
        if (managedSession) this.cancelManagedSession(managedSession);
        try { onCancel?.(); } catch (error) { console.error('Resume cancellation callback failed:', error); }
    }

    cancelManagedResumeForUserCommand() {
        this.cancelManagedResumeForReplacement();
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && this.transitionReservations === 0
            && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            if (!new_resume && this.resume_guard && !this.resume_guard()) {
                this.cancelResume();
                return { success: false, message: null, interrupted: false, timedout: false };
            }
            if (!new_resume) this.lastInterruption = null;
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout);
            this.currentActionLabel = '';
            if (this.resume_options) {
                if ((res.interrupted && this.resume_guard && !this.resume_guard())
                    || (!res.interrupted && this.resume_options.cancelOnSuccess)) {
                    this.cancelResume();
                }
            }
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10) {
        let TIMEOUT;
        let releaseTransition = null;
        try {
            let interruption = null;
            if (String(actionLabel).startsWith('mode:')) releaseTransition = this.reserveTransition();
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
                    releaseTransition?.();
                    return { success: false, message: 'Infinite action loop detected, shutting down.', interrupted: false, timedout: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');

            // await current action to finish (executing=false), with 10 seconds timeout
            // also tell agent.bot to stop various actions
            if (this.executing) {
                console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}"`);
                interruption = {
                    interruptedLabel: this.currentActionLabel,
                    byActionLabel: actionLabel,
                    at: Date.now(),
                };
            }
            this.lastInterruption = interruption;
            await this.stop();

            // clear bot logs and reset interrupt code
            this.agent.clearBotLogs();

            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;

            // timeout in minutes
            if (timeout > 0) {
                TIMEOUT = this._startTimeout(timeout);
            }

            // start the action
            await actionFn();

            // mark action as finished + cleanup
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);
            releaseTransition?.();
            releaseTransition = null;

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
            releaseTransition?.();
            releaseTransition = null;
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);
            this.cancelResume();
            console.error("Code execution triggered catch:", err);
            // Log the full stack trace
            console.error(err.stack);
            await this.stop();
            err = err.toString();

            let message = this.getBotOutputSummary() +
                '!!Code threw exception!!\n' +
                'Error: ' + err + '\n' +
                'Stack trace:\n' + err.stack+'\n';

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
