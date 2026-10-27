import { normalizeThinkingText } from '../native_tools.js';
import { CONTINUITY_BASELINE_INPUT } from './constants.js';
import { stableJson, structuredCloneSafe } from './utils.js';

export function toCodexResponsesTools(tools = []) {
    return tools.map(tool => {
        const fn = tool.function || tool;
        return {
            type: 'function',
            name: fn.name,
            description: fn.description || '',
            strict: Boolean(fn.strict),
            parameters: fn.parameters || { type: 'object', properties: {} }
        };
    }).filter(tool => tool.name);
}

export function buildScopedPromptCacheKey(baseKey, cacheScope) {
    const base = String(baseKey || '').trim();
    const scope = String(cacheScope || '').trim();
    if (!scope) return base;
    return `${base}:${scope}`;
}

export function toResponseCreateWebSocketRequest(body = {}) {
    return {
        type: 'response.create',
        ...body,
        tool_choice: body.tool_choice || 'auto'
    };
}

export function expandContinuityRequestBody(body = {}) {
    if (!body?.previous_response_id) return body;
    const expanded = {
        ...body,
        input: [
            ...(body[CONTINUITY_BASELINE_INPUT] || []),
            ...(body.input || [])
        ]
    };
    delete expanded.previous_response_id;
    return expanded;
}

export function isChatGptCodexUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.hostname === 'chatgpt.com' && parsed.pathname.includes('/backend-api/codex');
    } catch {
        return false;
    }
}

export function codexRequestSignature(body = {}) {
    const copy = { ...(body || {}) };
    delete copy.input;
    delete copy.previous_response_id;
    return stableJson(copy);
}

export function getIncrementalResponsesInput(input = [], previousBaseline = []) {
    const normalizedInput = normalizeResponsesItemsForContinuity(input);
    const normalizedBaseline = normalizeResponsesItemsForContinuity(previousBaseline);
    if (normalizedBaseline.length > normalizedInput.length) return null;
    for (let i = 0; i < normalizedBaseline.length; i++) {
        if (stableJson(normalizedInput[i]) !== stableJson(normalizedBaseline[i])) {
            return null;
        }
    }
    return input.slice(normalizedBaseline.length);
}

export function normalizeResponsesItemsForContinuity(items = []) {
    return (items || []).map(normalizeResponsesItemForContinuity);
}

function normalizeResponsesItemForContinuity(item) {
    if (!item || typeof item !== 'object') return item;
    const clone = structuredCloneSafe(item);
    stripVolatileResponsesFields(clone);
    return clone;
}

function stripVolatileResponsesFields(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (const item of value) stripVolatileResponsesFields(item);
        return;
    }
    delete value.id;
    delete value.status;
    delete value.object;
    for (const item of Object.values(value)) {
        stripVolatileResponsesFields(item);
    }
}

export function synthesizeCodexOutputItems(parsed = {}) {
    if (parsed.toolCalls?.length) {
        return parsed.toolCalls.map(call => ({
            type: 'function_call',
            call_id: call.id,
            name: call.function?.name || call.name,
            arguments: call.function?.arguments || call.arguments || '{}'
        })).filter(item => item.call_id && item.name);
    }
    if (parsed.text) {
        return [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: parsed.text }]
        }];
    }
    return [];
}

export function toCodexResponseItem(message) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    return {
        type: 'message',
        role,
        content: [{
            type: role === 'assistant' ? 'output_text' : 'input_text',
            text: stringifyContent(message.content)
        }]
    };
}

export async function parseCodexResponsesSse(sseText) {
    const toolCalls = [];
    const textDeltas = [];
    const messageTexts = [];
    const thinkingDeltas = [];
    const reasoningItems = [];
    const outputItems = [];
    let responseId = null;
    let usage = null;
    const events = sseText.split(/\n\n+/);
    for (const eventBlock of events) {
        const dataLines = eventBlock
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        const data = dataLines.join('\n');
        if (data === '[DONE]') continue;
        let event;
        try {
            event = JSON.parse(data);
        } catch {
            continue;
        }
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            textDeltas.push(event.delta);
        }
        if (typeof event.type === 'string' && event.type.includes('reasoning') && typeof event.delta === 'string') {
            thinkingDeltas.push(event.delta);
        }
        const item = event.item;
        if (event.type === 'response.output_item.done' && item) {
            outputItems.push(item);
        }
        if (event.type === 'response.output_item.done' && item?.type === 'function_call') {
            toolCalls.push({
                id: item.call_id,
                type: 'function',
                function: {
                    name: item.name,
                    arguments: item.arguments || '{}'
                }
            });
        }
        if (event.type === 'response.output_item.done' && item?.type === 'message') {
            messageTexts.push(extractMessageText(item));
        }
        if (event.type === 'response.output_item.done' && item?.type === 'reasoning') {
            reasoningItems.push(extractReasoningText(item));
        }
        if (event.response?.usage) {
            usage = event.response.usage;
        } else if (event.usage) {
            usage = event.usage;
        }
        if (event.response?.id) {
            responseId = event.response.id;
        }
        if (event.response_id) {
            responseId = event.response_id;
        }
        if (event.type === 'response.failed') {
            const message = event.response?.error?.message || 'Codex Responses stream failed';
            throw new Error(message);
        }
    }
    const text = textDeltas.length > 0 ? textDeltas.join('') : messageTexts.join('');
    const thinking = thinkingDeltas.length > 0
        ? normalizeThinkingText(thinkingDeltas.join(''))
        : normalizeThinkingText(reasoningItems);
    return { text, toolCalls, usage, thinking, responseId, outputItems };
}

function extractMessageText(item) {
    return (item.content || [])
        .filter(content => content?.type === 'output_text' || content?.type === 'text')
        .map(content => content.text || '')
        .join('');
}

function extractReasoningText(item) {
    const chunks = [];
    chunks.push(item?.text, item?.reasoning, item?.reasoning_content, item?.thinking);
    if (Array.isArray(item?.summary)) {
        chunks.push(...item.summary.map(part => part?.text || part?.summary_text || part?.content || ''));
    }
    if (Array.isArray(item?.content)) {
        chunks.push(...item.content.map(part => part?.text || part?.content || part?.reasoning || part?.thinking || ''));
    }
    return normalizeThinkingText(chunks);
}

function stringifyContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => part?.text || part?.content || JSON.stringify(part)).join('\n');
    }
    return String(content ?? '');
}

export function buildCodexReasoning(reasoning) {
    if (reasoning === false || reasoning === null) return null;
    if (typeof reasoning === 'string') {
        return { effort: reasoning, summary: 'auto' };
    }
    if (!reasoning || typeof reasoning !== 'object') return null;
    const result = { ...reasoning };
    if (result.effort && result.summary === undefined) {
        result.summary = 'auto';
    }
    return Object.keys(result).length > 0 ? result : null;
}

export function buildCodexInclude(include, reasoning) {
    const values = Array.isArray(include) ? [...include] : [];
    if (reasoning && !values.includes('reasoning.encrypted_content')) {
        values.push('reasoning.encrypted_content');
    }
    return values;
}
