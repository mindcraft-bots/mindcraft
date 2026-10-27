(function attachChatTraceProjector(global) {
    'use strict';

    function callHelper(name, ...args) {
        const helper = global[name];
        if (typeof helper !== 'function') {
            throw new Error(`ChatTraceProjector helper ${name} is not available`);
        }
        return helper(...args);
    }

class ChatTraceProjector {
    constructor(events = []) {
        this.events = Array.isArray(events) ? events : [];
        this.thread = { systemPrompt: null, systemEvent: null, tools: null, toolsEvent: null, instructionContexts: [], turns: [] };
        this.current = null;
        this.previousRequestMessages = [];
    }

    build() {
        this.events.forEach(event => this.addEvent(event));
        return this.thread;
    }

    addEvent(event) {
        if (!event || typeof event !== 'object') return;
        if (isBranchDecisionEvent(event)) {
            this.addBranchEvent(event);
            return;
        }
        if (event.ephemeral) return;
        switch (event.type) {
            case 'instruction_context':
                this.addInstructionContext(event);
                break;
            case 'llm_request':
                this.addRequest(event);
                break;
            case 'llm_response':
                this.addResponse(event);
                break;
            case 'history_turn_added':
                this.addHistoryTurn(event);
                break;
            case 'history_compacted':
                this.addCompactEvent(event);
                break;
            case 'tool_call':
                this.addToolCall(event);
                break;
            case 'tool_result':
                this.addToolResult(event);
                break;
            case 'llm_error':
                this.addError(event);
                break;
            default:
                break;
        }
    }

    createTurn(seed = {}) {
        return {
            request: null,
            response: null,
            errors: [],
            historyMessages: [],
            inlineHistoryMessages: [],
            compacted: null,
            toolRuns: [],
            visibleRequestMessages: [],
            requestMessageCount: 0,
            assistantText: '',
            assistantThinking: '',
            assistantToolCalls: [],
            modelLabel: 'model',
            branchDecision: null,
            ...seed
        };
    }

    ensureTurn() {
        if (!this.current) {
            this.current = this.createTurn();
            this.thread.turns.push(this.current);
        }
        return this.current;
    }


    addBranchEvent(event) {
        if (event.type === 'llm_request') {
            this.captureThreadContext(event);
            const turn = this.createTurn({
                branchDecision: {
                    request: event,
                    response: null,
                    errors: []
                },
                modelLabel: getEventModelLabel(event)
            });
            this.thread.turns.push(turn);
            return;
        }

        if (event.type === 'llm_response') {
            const branch = this.findOpenBranchTurn(event);
            if (branch) {
                branch.branchDecision.response = event;
                branch.modelLabel = getEventModelLabel(event, branch.modelLabel);
            } else {
                this.thread.turns.push(this.createTurn({
                    branchDecision: {
                        request: null,
                        response: event,
                        errors: []
                    },
                    modelLabel: getEventModelLabel(event)
                }));
            }
            return;
        }

        if (event.type === 'llm_error') {
            const branch = this.findOpenBranchTurn(event) || this.createTurn({
                branchDecision: {
                    request: null,
                    response: null,
                    errors: []
                },
                modelLabel: getEventModelLabel(event)
            });
            branch.branchDecision.errors.push(event);
            if (!this.thread.turns.includes(branch)) this.thread.turns.push(branch);
        }
    }

    findOpenBranchTurn(event) {
        const scope = event.cache_scope || event.cacheScope || event.tag || '';
        return this.thread.turns.slice().reverse().find(turn => {
            const branch = turn.branchDecision;
            if (!branch || branch.response) return false;
            const request = branch.request;
            if (!request) return true;
            const requestScope = request.cache_scope || request.cacheScope || request.tag || '';
            return scope ? requestScope === scope : request.tag === event.tag;
        });
    }

    addInstructionContext(event) {
        this.thread.instructionContexts.push(event);
    }

    addRequest(event) {
        if (event.tag === 'coding' && this.attachInternalToolEvent(event)) return;
        this.captureThreadContext(event);

        const requestMessages = Array.isArray(event.messages) ? event.messages : [];
        const pendingHistoryMessages = this.takePendingHistoryOnlyTurn();
        this.removeRequestIncludedHistory(this.current, requestMessages);

        this.current = this.createTurn({
            request: event,
            historyMessages: pendingHistoryMessages,
            visibleRequestMessages: callHelper('selectVisibleRequestMessages', requestMessages, this.previousRequestMessages),
            requestMessageCount: requestMessages.length
        });
        this.previousRequestMessages = requestMessages;
        this.updateTurnProjection(this.current);
        this.thread.turns.push(this.current);
    }

    addResponse(event) {
        if (event.tag === 'coding' && this.attachInternalToolEvent(event)) return;
        const turn = this.ensureTurn();
        turn.response = event;
        this.updateTurnProjection(turn);
    }

    addHistoryTurn(event) {
        if (shouldAppendAsPendingHistoryTurn(this.current, event)) {
            const pending = this.ensurePendingHistoryTurn();
            pending.historyMessages.push(event);
            this.updateTurnProjection(pending);
            return;
        }
        const turn = this.ensureTurn();
        turn.historyMessages.push(event);
        this.updateTurnProjection(turn);
    }

    addCompactEvent(event) {
        const turn = this.ensureTurn();
        turn.compacted = event;
        this.updateTurnProjection(turn);
        this.current = null;
    }

    addToolCall(event) {
        const turn = this.ensureTurn();
        turn.toolRuns.push({ event, call: event.tool_call, result: null, internalEvents: [] });
        this.updateTurnProjection(turn);
    }

    addToolResult(event) {
        const turn = this.ensureTurn();
        const match = this.findToolRunForResult(turn, event);
        if (match) {
            match.result = event;
        } else {
            turn.toolRuns.push({ event, call: event.tool_call, result: event, internalEvents: [] });
        }
        this.updateTurnProjection(turn);
    }

    addError(event) {
        if (event.tag === 'coding' && this.attachInternalToolEvent(event)) return;
        const turn = this.ensureTurn();
        turn.errors.push(event);
        this.updateTurnProjection(turn);
    }

    captureThreadContext(event) {
        if (!this.thread.systemPrompt && event.system_prompt) {
            this.thread.systemPrompt = event.system_prompt;
            this.thread.systemEvent = event;
        }
        if (!this.thread.tools && Array.isArray(event.tools)) {
            this.thread.tools = event.tools;
            this.thread.toolsEvent = event;
        }
    }

    ensurePendingHistoryTurn() {
        const last = this.thread.turns[this.thread.turns.length - 1];
        if (isHistoryOnlyProjectionTurn(last)) return last;
        const pending = this.createTurn();
        this.thread.turns.push(pending);
        return pending;
    }

    takePendingHistoryOnlyTurn() {
        const pending = this.thread.turns[this.thread.turns.length - 1];
        if (!isHistoryOnlyProjectionTurn(pending)) return [];
        const pendingHistoryMessages = pending.historyMessages;
        this.thread.turns.pop();
        if (this.current === pending) this.current = null;
        return pendingHistoryMessages;
    }

    removeRequestIncludedHistory(turn, requestMessages) {
        if (!turn?.historyMessages?.length) return;
        turn.historyMessages = turn.historyMessages
            .filter(historyEvent => !callHelper('isHistoryTurnIncludedInRequest', historyEvent.turn, requestMessages));
        this.updateTurnProjection(turn);
    }

    attachInternalToolEvent(event) {
        const item = this.findInternalToolHost(this.current);
        if (!item) return false;
        item.internalEvents = item.internalEvents || [];
        item.internalEvents.push(event);
        this.updateTurnProjection(this.current);
        return true;
    }

    findInternalToolHost(turn) {
        if (!turn?.toolRuns?.length) return null;
        const reversed = turn.toolRuns.slice().reverse();
        return reversed.find(item => callHelper('getToolName', item.call) === 'newAction' && !item.result)
            || reversed.find(item => !item.result)
            || reversed[0];
    }

    findToolRunForResult(turn, event) {
        const resultId = callHelper('getToolCallId', event.tool_call);
        return turn.toolRuns.slice().reverse().find(item => {
            const callId = callHelper('getToolCallId', item.call);
            return callId && resultId ? callId === resultId : callHelper('getToolName', item.call) === callHelper('getToolName', event.tool_call) && !item.result;
        });
    }

    updateTurnProjection(turn) {
        if (!turn) return;
        const requestMessages = Array.isArray(turn.request?.messages) ? turn.request.messages : [];
        const hasToolRuns = turn.toolRuns.length > 0;
        turn.inlineHistoryMessages = turn.historyMessages.filter(event => shouldRenderInlineHistoryEvent(event, requestMessages, hasToolRuns));
        turn.modelLabel = getTurnModelLabel(turn);
        turn.assistantText = callHelper('extractResponseText', turn.response?.response);
        turn.assistantThinking = callHelper('extractResponseThinking', turn.response?.response, turn.response?.thinking);
        const responseCalls = callHelper('extractResponseToolCalls', turn.response?.response);
        turn.assistantToolCalls = hasToolRuns ? [] : responseCalls;
    }
}


function isBranchDecisionEvent(event) {
    return Boolean(event?.branch || event?.tag === 'botResponder');
}

function getEventModelLabel(event, fallback = 'model') {
    return event?.model?.display_label
        || event?.model?.model
        || event?.model?.api
        || fallback
        || 'model';
}

function isHistoryOnlyProjectionTurn(turn) {
    return Boolean(turn)
        && !turn.request
        && !turn.response
        && !turn.compacted
        && (!turn.toolRuns || turn.toolRuns.length === 0)
        && (!turn.errors || turn.errors.length === 0)
        && Array.isArray(turn.historyMessages)
        && turn.historyMessages.length > 0;
}

function shouldAppendAsPendingHistoryTurn(currentTurn, event) {
    const role = event?.turn?.role;
    if (role !== 'user') return false;
    if (!currentTurn || isHistoryOnlyProjectionTurn(currentTurn)) return false;
    return Boolean(currentTurn.response || currentTurn.errors?.length || currentTurn.toolRuns?.length);
}

function shouldRenderInlineHistoryEvent(event, requestMessages, hasToolRuns) {
    const role = event?.turn?.role;
    if (callHelper('isHistoryTurnIncludedInRequest', event?.turn, requestMessages)) return false;
    if (!hasToolRuns) return role === 'user';
    return role === 'user' && !String(event?.turn?.content || '').startsWith('System:');
}

function getTurnModelLabel(turn) {
    const request = turn?.request;
    const response = turn?.response;
    return request?.model?.display_label
        || response?.model?.display_label
        || request?.model?.model
        || request?.model?.api
        || response?.model?.model
        || response?.model?.api
        || 'model';
}


    global.ChatTraceProjector = ChatTraceProjector;
    global.buildChatThread = function buildChatThread(events) {
        return new ChatTraceProjector(events).build();
    };
})(window);
