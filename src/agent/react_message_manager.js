import { buildStateSnapshotDiff } from './state_snapshot.js';

const MAX_BEHAVIOR_LOG_CHARS = 500;

/**
 * Factory for ReAct message sessions.
 *
 * History remains the append-only persistence layer, but each ReAct turn gets a
 * dedicated session object that owns request-context assembly. Keeping per-turn
 * state off the Agent prevents concurrent message handlers from overwriting one
 * another while still centralizing the message lifecycle in one place.
 */
export class ReactMessageManager {
    constructor(agent) {
        this.agent = agent;
        this.nextTurnId = 0;
    }

    startTurn({ source, message, options = {}, behaviorLog = '' }) {
        this.nextTurnId += 1;
        return new ReactMessageTurn(this.agent, { source, message, options, behaviorLog, turnId: `react-${this.nextTurnId}` });
    }
}

class ReactMessageTurn {
    constructor(agent, { source, message, options = {}, behaviorLog = '', turnId }) {
        this.agent = agent;
        this.options = options || {};
        this.turnStateKey = turnId;
        this.pendingPersistedParts = [];
        this.transientParts = [];
        this.includeTransientParts = false;
        this.initialize({ source, message, behaviorLog });
    }

    initialize({ source, message, behaviorLog = '' }) {
        const runtimeParts = [];
        const formattedBehaviorLog = formatBehaviorLog(behaviorLog);
        if (formattedBehaviorLog) {
            runtimeParts.push(formatSystemUserContent(formattedBehaviorLog));
        }

        if (this.options.transient) {
            this.transientParts.push(formatSystemUserContent(message));
            this.transientParts.push(...runtimeParts);
            this.includeTransientParts = this.transientParts.length > 0;
            return;
        }

        this.pendingPersistedParts.push(formatHistoryUserContent(source, message, this.agent.name));
        this.pendingPersistedParts.push(...runtimeParts);
    }

    async buildRequestMessages() {
        const requestTransientParts = [];
        const stateDiff = buildStateSnapshotDiff(this.agent);
        if (stateDiff) {
            if (this.pendingPersistedParts.length > 0) {
                this.pendingPersistedParts.push(stateDiff);
            }
            else if (!this.options.transient) {
                await this.persistUserContext(stateDiff);
            }
            else {
                requestTransientParts.push(stateDiff);
            }
        }

        if (this.pendingPersistedParts.length > 0) {
            await this.persistUserContext(this.pendingPersistedParts.join('\n\n'));
            this.pendingPersistedParts = [];
        }

        if (this.includeTransientParts) {
            requestTransientParts.push(...this.transientParts);
            this.includeTransientParts = false;
        }

        const messages = this.agent.history.getHistory();
        const transientRequest = createTransientRequestMessage(requestTransientParts);
        if (transientRequest) {
            messages.push(transientRequest);
        }
        return messages;
    }

    async persistUserContext(content) {
        await this.agent.history.addUserContext(content);
        this.agent.history.save();
    }
}

export function formatHistoryUserContent(source, message, agentName) {
    if (source === 'system') return `System: ${message}`;
    if (source !== agentName) return `${source}: ${message}`;
    return String(message ?? '');
}

export function formatSystemUserContent(message) {
    return `System: ${message}`;
}

export function createTransientRequestMessage(parts) {
    const content = parts
        .map(part => String(part || '').trim())
        .filter(Boolean)
        .join('\n\n');
    return content ? { role: 'user', content } : null;
}

export function formatBehaviorLog(behaviorLog) {
    let text = String(behaviorLog || '').trim();
    if (!text) return '';
    if (text.length > MAX_BEHAVIOR_LOG_CHARS) {
        text = '...' + text.substring(text.length - MAX_BEHAVIOR_LOG_CHARS);
    }
    return 'Recent behaviors log: \n' + text;
}
