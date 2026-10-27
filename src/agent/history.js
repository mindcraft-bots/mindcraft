import { writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { NPCData } from './npc/data.js';
import settings from './settings.js';
import { createNativeToolCallTurn, createNativeToolResultTurn, hasNativeToolCalls, isNativeToolResultTurn, normalizeThinkingText } from '../models/native_tools.js';
import { sendTraceEventToServer } from './mindserver_proxy.js';


export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;
        this.chat_history_dir = `./bots/${this.name}/chat-history`;
        this.chat_history_session_fp = undefined;
        this.chat_history_latest_fp = `./bots/${this.name}/chat_history.jsonl`;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });
        mkdirSync(this.chat_history_dir, { recursive: true });

        this.turns = [];

        // Latest compact summary retained for backward-compatible persistence.
        // The active model context stores compact summaries as normal history turns.
        this.memory = '';

        // Message-count context window. Compaction uses the active context after the
        // latest compact boundary and summarizes that whole active context.
        this.max_messages = normalizePositiveNumber(settings.max_messages, Infinity);
        this.compact_message_threshold_percent = normalizePercent(settings.compact_message_threshold_percent, 100);
        this.instruction_contexts_traced = false;

        if (this.fullTraceEnabled()) {
            this._initChatHistoryTrace();
        }
    }

    getHistory() {
        return JSON.parse(JSON.stringify(getModelContextTurns(this.turns)));
    }

    async compactHistoryIfNeeded() {
        if (!this.shouldCompact()) {
            return false;
        }
        await this.compactHistory();
        return true;
    }

    shouldCompact() {
        if (!Number.isFinite(this.max_messages) || this.max_messages <= 0) {
            return false;
        }
        if (this.hasPendingToolCall()) {
            return false;
        }
        const threshold = Math.max(2, Math.ceil(this.max_messages * (this.compact_message_threshold_percent / 100)));
        const activeTurns = getActiveTurnsSinceLastCompact(this.turns);
        if (activeTurns.length < threshold) {
            return false;
        }
        return activeTurns.some(turn => !turn.compact_boundary && !turn.compact_summary);
    }

    hasPendingToolCall() {
        const pending = new Set();
        for (const turn of this.turns) {
            if (hasNativeToolCalls(turn)) {
                for (const call of turn.native_tool_calls) {
                    pending.add(call.id);
                }
                continue;
            }
            if (isNativeToolResultTurn(turn) && turn.tool_call_id) {
                pending.delete(turn.tool_call_id);
            }
        }
        return pending.size > 0;
    }

    async compactHistory() {
        const turnsToCompact = this.getHistory();
        if (turnsToCompact.length === 0) {
            return;
        }

        console.log('Compacting conversation history...');
        this.traceEvent('memory_compression_started', {
            active_turn_count_before_compression: this.turns.length,
            compacted_turns: turnsToCompact,
            previous_memory: this.memory,
            threshold_percent: this.compact_message_threshold_percent,
            max_messages: this.max_messages
        });

        const previousMemory = this.memory;
        const summary = await this.agent.prompter.promptCompactSummary(turnsToCompact);
        this.memory = String(summary || '').trim();

        const historyFile = await this.appendFullHistory(turnsToCompact);
        this.turns = [
            createCompactBoundaryTurn({
                trigger: 'auto',
                summarized_turn_count: turnsToCompact.length,
                archive_file: historyFile
            }),
            createCompactSummaryTurn(this.memory, historyFile)
        ];

        console.log('Conversation compacted to summary:', this.memory);
        this.traceEvent('memory_compression_completed', {
            previous_memory: previousMemory,
            new_memory: this.memory,
            compacted_turns: turnsToCompact,
            full_history_file: historyFile,
            active_turns: this.turns
        });
        this.traceEvent('history_compacted', {
            summary: this.memory,
            full_history_file: historyFile,
            active_turns: this.turns
        });
    }

    async appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.json`;
            writeFileSync(this.full_history_fp, '[]', 'utf8');
        }
        try {
            const data = readFileSync(this.full_history_fp, 'utf8');
            let full_history = JSON.parse(data);
            full_history.push(...to_store);
            writeFileSync(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');
            return this.full_history_fp;
        } catch (err) {
            console.error(`Error reading ${this.name}'s full history file: ${err.message}`);
            return null;
        }
    }

    async add(name, content, metadata = {}) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'user';
            content = `System: ${content}`;
            if (isDuplicateSelfPromptReminder(this.turns, content)) {
                this.traceEvent('history_turn_deduped', {
                    reason: 'duplicate_self_prompt_reminder',
                    turn: { role, content }
                });
                return false;
            }
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        await this._pushTurn(withTurnMetadata({ role, content }, metadata));
    }

    async addUserContext(content) {
        const text = String(content || '').trim();
        if (!text) return false;
        await this._pushTurn({ role: 'user', content: text });
        return true;
    }

    async addNativeToolCall(toolCall, content, metadata = {}) {
        await this._pushTurn(createNativeToolCallTurn(toolCall, content, metadata));
        this.traceEvent('tool_call', {
            tool_call: toolCall,
            content: content || '',
            thinking: normalizeThinkingText(metadata.thinking || metadata.reasoning_content || metadata.reasoning)
        });
    }

    async addNativeToolResult(toolCall, result) {
        await this._pushTurn(createNativeToolResultTurn(toolCall, result));
        this.traceEvent('tool_result', {
            tool_call: toolCall,
            result
        });
    }


    closeStalePendingToolCalls() {
        const { turns, inserted } = synthesizeStalePendingToolResults(this.turns);
        if (inserted.length === 0) return false;
        this.turns = turns;
        this.traceEvent('history_tool_results_synthesized', {
            reason: 'stale_pending_native_tool_calls_before_next_turn',
            inserted_results: inserted,
            active_turn_count: this.turns.length
        });
        return true;
    }

    async _pushTurn(turn) {
        turn = normalizeHistoryTurn(turn);
        this.turns.push(turn);
        this.closeStalePendingToolCalls();
        this.traceEvent('history_turn_added', {
            turn,
            active_turn_count: this.turns.length
        });

        await this.compactHistoryIfNeeded();
    }

    async save() {
        try {
            const data = {
                memory: this.memory,
                turns: this.turns,
                updated_at: new Date().toISOString(),
                chat_history_trace: this.chat_history_session_fp,
                chat_history_latest: this.chat_history_latest_fp,
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender
            };
            writeFileSync(this.memory_fp, JSON.stringify(data, null, 2));
            console.log('Saved memory to:', this.memory_fp);
        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            this.memory = data.memory || '';
            this.turns = Array.isArray(data.turns) ? data.turns.map(normalizeHistoryTurn) : [];
            if (this.memory && !this.turns.some(turn => turn.compact_summary)) {
                this.turns = [
                    createCompactBoundaryTurn({ trigger: 'load', summarized_turn_count: 0 }),
                    createCompactSummaryTurn(this.memory, this.full_history_fp),
                    ...this.turns
                ];
            }
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
        this.traceEvent('history_cleared', {});
    }

    traceInstructionContext(title, content, metadata = {}) {
        const text = String(content || '').trim();
        if (!text) return;
        this.traceEvent('instruction_context', {
            title: String(title || 'Instructions'),
            content: text,
            metadata: makeJsonSafe(metadata || {})
        });
    }

    traceLLMRequest(tag, model, systemPrompt, messages, tools = null, metadata = {}) {
        this.traceEvent('llm_request', {
            tag,
            model: describeModel(model),
            system_prompt: systemPrompt,
            messages,
            tools: Array.isArray(tools) ? tools : null,
            tool_count: Array.isArray(tools) ? tools.length : 0,
            request_fingerprint: buildRequestFingerprint(systemPrompt, messages, tools),
            ...makeJsonSafe(metadata || {})
        });
    }

    traceLLMResponse(tag, model, response, metadata = {}) {
        this.traceEvent('llm_response', {
            tag,
            model: describeModel(model),
            response,
            thinking: extractThinkingForTrace(response, model),
            token_usage: model?.lastTokenUsage || null,
            ...makeJsonSafe(metadata || {})
        });
    }

    traceLLMError(tag, model, error) {
        this.traceEvent('llm_error', {
            tag,
            model: describeModel(model),
            error: {
                name: error?.name,
                message: error?.message || String(error),
                stack: error?.stack
            }
        });
    }

    traceEvent(type, payload = {}) {
        const writeFullTrace = this.fullTraceEnabled();
        const showChatEvent = this.chatDisplayEnabled() && isChatDisplayEvent(type);
        const persistRuntimeEvent = writeFullTrace || showChatEvent;
        if (!persistRuntimeEvent) {
            return;
        }
        if (!this.chat_history_session_fp) {
            this._initChatHistoryTrace();
        }
        const event = {
            timestamp: new Date().toISOString(),
            agent: this.name,
            type,
            ...payload
        };
        const line = safeStringify(event) + '\n';
        try {
            appendFileSync(this.chat_history_session_fp, line, 'utf8');
            appendFileSync(this.chat_history_latest_fp, line, 'utf8');
        } catch (error) {
            console.error(`Failed to write ${this.name}'s chat history trace:`, error);
        }
        if (writeFullTrace || showChatEvent) {
            sendTraceEventToServer(this.name, event);
        }
    }

    _traceInstructionContextsAtSessionStart() {
        if (this.instruction_contexts_traced) return;
        this.instruction_contexts_traced = true;
        for (const context of collectInstructionContexts()) {
            this.traceInstructionContext(context.title, context.content, context.metadata);
        }
    }

    _initChatHistoryTrace() {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.chat_history_session_fp = `${this.chat_history_dir}/${timestamp}.jsonl`;
        writeFileSync(this.chat_history_session_fp, '', 'utf8');
        writeFileSync(this.chat_history_latest_fp, '', 'utf8');
        this.traceEvent('session_started', {
            session_trace: this.chat_history_session_fp,
            latest_trace: this.chat_history_latest_fp,
            max_messages: this.max_messages,
            compact_message_threshold_percent: this.compact_message_threshold_percent
        });
        this._traceInstructionContextsAtSessionStart();
    }

    fullTraceEnabled() {
        return settings.log_chat_trace === true;
    }

    chatDisplayEnabled() {
        return settings.show_chat_history !== false;
    }
}


function collectInstructionContexts() {
    const contexts = [];
    for (const item of normalizeConfiguredInstructionContexts(settings.trace_instruction_contexts || settings.trace_instructions)) {
        contexts.push(item);
    }
    for (const filePath of collectInstructionFiles()) {
        const content = readInstructionFile(filePath);
        if (!content) continue;
        contexts.push({
            title: `AGENTS.md · ${path.relative(process.cwd(), filePath) || path.basename(filePath)}`,
            content,
            metadata: { source: filePath }
        });
    }
    return contexts;
}

function normalizeConfiguredInstructionContexts(value) {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return list.map((item, index) => {
        if (typeof item === 'string') {
            return {
                title: index === 0 ? 'Runtime instructions' : `Runtime instructions ${index + 1}`,
                content: item,
                metadata: { source: 'settings.trace_instruction_contexts' }
            };
        }
        if (!item || typeof item !== 'object') return null;
        return {
            title: item.title || item.name || 'Runtime instructions',
            content: item.content || item.text || '',
            metadata: item.metadata || { source: 'settings.trace_instruction_contexts' }
        };
    }).filter(item => String(item?.content || '').trim());
}

function collectInstructionFiles() {
    const explicit = Array.isArray(settings.trace_instruction_files)
        ? settings.trace_instruction_files.map(file => path.resolve(process.cwd(), file))
        : [];
    return uniquePaths([...findScopedAgentInstructionFiles(process.cwd()), ...explicit]);
}

function findScopedAgentInstructionFiles(startDir) {
    const files = [];
    let dir = path.resolve(startDir || process.cwd());
    while (true) {
        const candidate = path.join(dir, 'AGENTS.md');
        if (existsSync(candidate)) files.push(candidate);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return files.reverse();
}

function uniquePaths(paths) {
    const seen = new Set();
    const out = [];
    for (const item of paths) {
        const resolved = path.resolve(item);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        out.push(resolved);
    }
    return out;
}

function readInstructionFile(filePath) {
    try {
        if (!existsSync(filePath)) return '';
        return readFileSync(filePath, 'utf8').trim();
    } catch (error) {
        console.warn(`Failed to read instruction context ${filePath}:`, error?.message || error);
        return '';
    }
}

function isChatDisplayEvent(type) {
    return [
        'llm_request',
        'llm_response',
        'llm_error',
        'history_turn_added',
        'tool_call',
        'tool_result',
        'history_cleared',
        'history_compacted',
        'instruction_context'
    ].includes(type);
}

function describeModel(model) {
    if (!model || typeof model !== 'object') {
        return null;
    }
    const modelName = model.model_name || model.default_model || null;
    const reasoning = model.params?.reasoning && typeof model.params.reasoning === 'object'
        ? model.params.reasoning
        : null;
    const reasoningEffort = reasoning?.effort || null;
    const reasoningSummary = reasoning?.summary || null;
    return {
        api: model.constructor?.prefix || model.api || null,
        provider: model.provider || model.params?.provider || null,
        model: modelName,
        reasoning_effort: reasoningEffort,
        reasoning_summary: reasoningSummary,
        display_label: [modelName, reasoningEffort].filter(Boolean).join(' ') || null,
        supports_native_tool_calls: Boolean(model.supportsNativeToolCalls)
    };
}

function extractThinkingForTrace(response, model) {
    return normalizeThinkingText(
        response?.thinking ??
        response?.reasoning_content ??
        response?.reasoning ??
        response?.thought ??
        model?.lastThinking ??
        ''
    );
}

function buildRequestFingerprint(systemPrompt, messages, tools) {
    const list = Array.isArray(messages) ? messages : [];
    return {
        system_prompt_hash: hashTraceValue(systemPrompt || ''),
        messages_hash: hashTraceValue(list),
        tools_hash: hashTraceValue(Array.isArray(tools) ? tools : []),
        first_message_hash: list.length > 0 ? hashTraceValue(list[0]) : null,
        last_message_hash: list.length > 0 ? hashTraceValue(list[list.length - 1]) : null,
        message_count: list.length,
        tool_count: Array.isArray(tools) ? tools.length : 0
    };
}

function hashTraceValue(value) {
    return createHash('sha256').update(safeStringify(value)).digest('hex').slice(0, 16);
}

function safeStringify(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return JSON.stringify(makeJsonSafe(value));
    }
}

function makeJsonSafe(value, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'bigint') return value.toString();
        return value;
    }
    if (seen.has(value)) {
        return '[Circular]';
    }
    seen.add(value);
    if (Array.isArray(value)) {
        return value.map(item => makeJsonSafe(item, seen));
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'function') continue;
        out[key] = makeJsonSafe(item, seen);
    }
    return out;
}


function normalizePositiveNumber(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return fallback;
    return num;
}

function normalizePercent(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return fallback;
    return Math.min(100, num);
}

function isDuplicateSelfPromptReminder(turns, content) {
    if (typeof content !== 'string' || !content.startsWith('System: Continue working on your current goal:')) {
        return false;
    }
    return getModelContextTurns(turns).some(turn => turn?.role === 'user' && turn?.content === content);
}

function createCompactBoundaryTurn(metadata = {}) {
    return normalizeHistoryTurn({
        role: 'system',
        content: 'Conversation compacted.',
        compact_boundary: true,
        subtype: 'compact_boundary',
        compact_metadata: metadata
    });
}

function createCompactSummaryTurn(summary, archiveFile) {
    const archiveNote = archiveFile ? `\n\nFull archived history before this compact is stored at: ${archiveFile}` : '';
    return {
        role: 'user',
        content: `System: This session is being continued from an earlier conversation that was compacted. The summary below replaces the earlier messages. Recent messages after this summary are preserved verbatim.\n\nSummary:\n${String(summary || '').trim()}${archiveNote}`,
        compact_summary: true,
        is_compact_summary: true,
        archive_file: archiveFile || null
    };
}


function synthesizeStalePendingToolResults(turns = []) {
    const repaired = [];
    const pending = new Map();
    const inserted = [];

    const flushPending = () => {
        if (pending.size === 0) return;
        for (const call of pending.values()) {
            const resultTurn = createNativeToolResultTurn(call, 'Tool result was not recorded before the next conversation turn. Treat the tool call as interrupted and continue from the latest state.');
            resultTurn.synthetic_tool_result = true;
            resultTurn.synthetic_reason = 'stale_pending_native_tool_call';
            repaired.push(resultTurn);
            inserted.push(resultTurn);
        }
        pending.clear();
    };

    for (const turn of turns || []) {
        if (hasNativeToolCalls(turn)) {
            flushPending();
            repaired.push(turn);
            for (const call of turn.native_tool_calls) {
                pending.set(call.id, call);
            }
            continue;
        }

        if (isNativeToolResultTurn(turn)) {
            if (turn.tool_call_id && pending.has(turn.tool_call_id)) {
                pending.delete(turn.tool_call_id);
            }
            repaired.push(turn);
            continue;
        }

        flushPending();
        repaired.push(turn);
    }

    // Leave trailing pending calls untouched. They may still be executing, and
    // action interruption code is responsible for closing them before the next
    // conversational turn is appended.
    return { turns: repaired, inserted };
}

function getModelContextTurns(turns = []) {
    const index = turns.findLastIndex(turn => turn?.compact_boundary || turn?.subtype === 'compact_boundary');
    return index === -1 ? turns : turns.slice(index + 1);
}

function getActiveTurnsSinceLastCompact(turns = []) {
    const index = turns.findLastIndex(turn =>
        turn?.compact_boundary ||
        turn?.subtype === 'compact_boundary' ||
        turn?.compact_summary ||
        turn?.is_compact_summary
    );
    return index === -1 ? turns : turns.slice(index + 1);
}

export function normalizeHistoryTurn(turn) {
    if (!turn || typeof turn !== 'object') {
        return turn;
    }
    if (turn.role !== 'system') {
        return turn;
    }
    return {
        ...turn,
        role: 'user',
        content: `System: ${turn.content || ''}`
    };
}

function withTurnMetadata(turn, metadata = {}) {
    const thinking = normalizeThinkingText(metadata.thinking ?? metadata.reasoning_content ?? metadata.reasoning);
    if (thinking) turn.thinking = thinking;
    if (Array.isArray(metadata.thinking_blocks) && metadata.thinking_blocks.length > 0) {
        turn.thinking_blocks = metadata.thinking_blocks;
    }
    if (metadata.thinking_key || metadata.reasoning_key) {
        turn.thinking_key = metadata.thinking_key || metadata.reasoning_key;
    }
    return turn;
}
