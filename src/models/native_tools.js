export function isNativeToolResponse(value) {
    return Boolean(value && typeof value === 'object' && value.type === 'tool_calls' && Array.isArray(value.tool_calls));
}

export function createNativeToolResponse(toolCalls, provider = 'unknown', metadata = {}) {
    return withThinkingMetadata({
        type: 'tool_calls',
        provider,
        tool_calls: normalizeOpenAIToolCalls(toolCalls)
    }, metadata);
}

export function createNativeToolCallTurn(toolCall, content = '', metadata = {}) {
    const [normalized] = normalizeOpenAIToolCalls([toolCall]);
    return withThinkingMetadata({
        role: 'assistant',
        content,
        native_tool_calls: normalized ? [normalized] : []
    }, metadata);
}

export function createNativeToolResultTurn(toolCall, result) {
    const [normalized] = normalizeOpenAIToolCalls([toolCall]);
    return {
        role: 'tool',
        content: stringifyToolResult(result),
        tool_call_id: normalized?.id || toolCall?.id,
        name: normalized?.name || toolCall?.name || toolCall?.function?.name
    };
}


export function withThinkingMetadata(target, metadata = {}) {
    if (!target || typeof target !== 'object') return target;
    const thinking = normalizeThinkingText(metadata.thinking ?? metadata.reasoning_content ?? metadata.reasoning);
    if (thinking) target.thinking = thinking;
    const thinkingBlocks = normalizeThinkingBlocks(metadata.thinking_blocks || metadata.thinkingBlocks);
    if (thinkingBlocks.length > 0) target.thinking_blocks = thinkingBlocks;
    const thinkingKey = metadata.thinking_key || metadata.thinkingKey || metadata.reasoning_key || metadata.reasoningKey;
    if (thinkingKey) target.thinking_key = thinkingKey;
    return target;
}

export function normalizeThinkingText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(normalizeThinkingText).filter(Boolean).join('\n');
    if (typeof value === 'object') {
        return normalizeThinkingText(value.thinking ?? value.reasoning_content ?? value.reasoning ?? value.text ?? value.content ?? '');
    }
    return String(value);
}

export function normalizeThinkingBlocks(blocks = []) {
    if (!Array.isArray(blocks)) return [];
    return blocks.map(block => {
        if (!block || typeof block !== 'object') return null;
        if (block.type === 'thinking' || block.type === 'redacted_thinking') return { ...block };
        const thinking = normalizeThinkingText(block.thinking ?? block.text ?? block.content);
        if (!thinking) return null;
        return { type: 'thinking', thinking, ...(block.signature ? { signature: block.signature } : {}) };
    }).filter(Boolean);
}

export function hasNativeToolCalls(turn) {
    return Array.isArray(turn?.native_tool_calls) && turn.native_tool_calls.length > 0;
}

export function isNativeToolResultTurn(turn) {
    return turn?.role === 'tool';
}

export function normalizeOpenAIToolCalls(toolCalls = []) {
    return toolCalls.map((call, index) => {
        const fn = call.function || {};
        return {
            id: call.id || `call_${Date.now()}_${index}`,
            type: 'function',
            name: fn.name || call.name,
            arguments: normalizeArguments(fn.arguments ?? call.arguments ?? {})
        };
    }).filter(call => call.name);
}

export function normalizeAnthropicToolUse(content = []) {
    return content
        .filter(item => item?.type === 'tool_use')
        .map((item, index) => ({
            id: item.id || `call_${Date.now()}_${index}`,
            type: 'function',
            name: item.name,
            arguments: normalizeArguments(item.input || {})
        }));
}

export function normalizeGeminiFunctionCalls(parts = []) {
    return parts
        .filter(part => part?.functionCall)
        .map((part, index) => ({
            id: `call_${Date.now()}_${index}`,
            type: 'function',
            name: part.functionCall.name,
            arguments: normalizeArguments(part.functionCall.args || {})
        }));
}

export function normalizeMistralToolCalls(toolCalls = []) {
    return toolCalls.map((call, index) => {
        const fn = call.function || {};
        return {
            id: call.id || `call_${Date.now()}_${index}`,
            type: 'function',
            name: fn.name || call.name,
            arguments: normalizeArguments(fn.arguments ?? call.arguments ?? {})
        };
    }).filter(call => call.name);
}

export function normalizeArguments(args) {
    if (typeof args === 'string') {
        return args;
    }
    return JSON.stringify(args || {});
}

export function parseNormalizedArguments(args) {
    try {
        return parseToolArguments(args);
    } catch {
        return {};
    }
}

export function parseToolArguments(args) {
    if (args == null || args === '') {
        return {};
    }
    if (typeof args === 'object') {
        return args;
    }
    try {
        return JSON.parse(args);
    } catch (error) {
        const jsonObject = extractFirstJsonObject(args);
        if (jsonObject) {
            try {
                return JSON.parse(jsonObject);
            } catch {
                // Preserve the original parse error below; the extracted object
                // was only a best-effort recovery for providers that append
                // proprietary tool-call markers after valid JSON arguments.
            }
        }
        throw new Error(`Tool arguments must be valid JSON: ${error.message}`);
    }
}

function extractFirstJsonObject(value) {
    if (typeof value !== 'string') return null;
    const start = value.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < value.length; i++) {
        const char = value[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (char === '{') depth++;
        if (char === '}') {
            depth--;
            if (depth === 0) {
                return value.slice(start, i + 1);
            }
        }
    }
    return null;
}

export function toAnthropicTools(tools = []) {
    return tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters
    }));
}

export function toGeminiFunctionDeclarations(tools = []) {
    return tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: cleanGeminiSchema(tool.function.parameters)
    }));
}

export function stringifyToolResult(result) {
    if (result == null) return '';
    if (typeof result === 'string') return result;
    try {
        return JSON.stringify(result);
    } catch {
        return String(result);
    }
}

export function repairNativeToolTurns(turns = [], { synthesizeMissingResults = false } = {}) {
    const repaired = [];
    const pending = new Map();

    for (const turn of turns || []) {
        if (hasNativeToolCalls(turn)) {
            if (synthesizeMissingResults && pending.size > 0) {
                for (const call of pending.values()) {
                    repaired.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        name: call.name,
                        content: 'Tool result was not recorded.'
                    });
                }
            }
            pending.clear();
            repaired.push(turn);
            for (const call of turn.native_tool_calls) {
                pending.set(call.id, call);
            }
            continue;
        }

        if (isNativeToolResultTurn(turn)) {
            if (!turn.tool_call_id || !pending.has(turn.tool_call_id)) {
                continue;
            }
            const call = pending.get(turn.tool_call_id);
            repaired.push({
                ...turn,
                name: turn.name || call.name
            });
            pending.delete(turn.tool_call_id);
            continue;
        }

        if (synthesizeMissingResults && pending.size > 0) {
            for (const call of pending.values()) {
                repaired.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    name: call.name,
                    content: 'Tool result was not recorded.'
                });
            }
        }
        pending.clear();
        repaired.push(turn);
    }

    if (synthesizeMissingResults && pending.size > 0) {
        for (const call of pending.values()) {
            repaired.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                content: 'Tool result was not recorded.'
            });
        }
    }

    return repaired;
}

export function toOpenAIChatMessages(turns = [], systemMessage = '', options = {}) {
    const messages = [];
    if (systemMessage) {
        messages.push({ role: 'system', content: systemMessage });
    }
    for (const turn of repairNativeToolTurns(turns, { synthesizeMissingResults: true })) {
        if (hasNativeToolCalls(turn)) {
            messages.push(withOpenAIThinking({
                role: 'assistant',
                content: turn.content || null,
                tool_calls: turn.native_tool_calls.map(toOpenAIChatToolCall)
            }, turn, options));
        } else if (isNativeToolResultTurn(turn)) {
            messages.push({
                role: 'tool',
                tool_call_id: turn.tool_call_id,
                content: stringifyToolResult(turn.content)
            });
        } else if (turn?.role === 'system') {
            messages.push({ role: 'user', content: `SYSTEM: ${stringifyToolResult(turn.content)}` });
        } else if (turn?.role === 'assistant') {
            messages.push(withOpenAIThinking({ role: 'assistant', content: toOpenAIChatContent(turn.content) }, turn, options));
        } else if (turn?.role === 'user') {
            messages.push({ role: turn.role, content: toOpenAIChatContent(turn.content) });
        }
    }
    if (messages.length === 0) {
        messages.push({ role: 'user', content: '_' });
    }
    return messages;
}

export function toResponsesInputItems(turns = []) {
    const items = [];
    for (const turn of repairNativeToolTurns(turns, { synthesizeMissingResults: true })) {
        if (hasNativeToolCalls(turn)) {
            for (const call of turn.native_tool_calls) {
                items.push({
                    type: 'function_call',
                    call_id: call.id,
                    name: call.name,
                    arguments: normalizeArguments(call.arguments)
                });
            }
        } else if (isNativeToolResultTurn(turn)) {
            items.push({
                type: 'function_call_output',
                call_id: turn.tool_call_id,
                output: stringifyToolResult(turn.content)
            });
        } else if (turn?.role === 'assistant' || turn?.role === 'user') {
            items.push({
                type: 'message',
                role: turn.role,
                content: toResponsesMessageContent(turn.content, turn.role)
            });
        } else if (turn?.role === 'system') {
            items.push({
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: `SYSTEM: ${stringifyToolResult(turn.content)}` }]
            });
        }
    }
    if (items.length === 0) {
        items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '_' }] });
    }
    return items;
}

export function toAnthropicMessages(turns = []) {
    const messages = [];
    for (const turn of repairNativeToolTurns(turns, { synthesizeMissingResults: true })) {
        if (hasNativeToolCalls(turn)) {
            const content = [];
            content.push(...toAnthropicThinkingBlocks(turn));
            if (turn.content) {
                content.push({ type: 'text', text: turn.content });
            }
            for (const call of turn.native_tool_calls) {
                content.push({
                    type: 'tool_use',
                    id: call.id,
                    name: call.name,
                    input: parseNormalizedArguments(call.arguments)
                });
            }
            messages.push({ role: 'assistant', content });
        } else if (isNativeToolResultTurn(turn)) {
            messages.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: turn.tool_call_id,
                    content: stringifyToolResult(turn.content)
                }]
            });
        } else if (turn?.role === 'assistant') {
            messages.push({ role: 'assistant', content: [...toAnthropicThinkingBlocks(turn), ...toAnthropicMessageContent(turn.content)] });
        } else if (turn?.role === 'user') {
            messages.push({ role: 'user', content: toAnthropicMessageContent(turn.content) });
        } else if (turn?.role === 'system') {
            messages.push({ role: 'user', content: `SYSTEM: ${stringifyToolResult(turn.content)}` });
        }
    }
    return normalizeAlternatingMessages(messages);
}

export function toGeminiContents(turns = []) {
    const contents = [];
    for (const turn of repairNativeToolTurns(turns, { synthesizeMissingResults: true })) {
        if (hasNativeToolCalls(turn)) {
            const parts = [];
            parts.push(...toGeminiThinkingParts(turn));
            if (turn.content) {
                parts.push({ text: turn.content });
            }
            for (const call of turn.native_tool_calls) {
                parts.push({
                    functionCall: {
                        name: call.name,
                        args: parseNormalizedArguments(call.arguments)
                    }
                });
            }
            contents.push({ role: 'model', parts });
        } else if (isNativeToolResultTurn(turn)) {
            contents.push({
                role: 'user',
                parts: [{
                    functionResponse: {
                        name: turn.name,
                        response: { result: stringifyToolResult(turn.content) }
                    }
                }]
            });
        } else if (turn?.role === 'assistant') {
            contents.push({ role: 'model', parts: [...toGeminiThinkingParts(turn), { text: stringifyToolResult(turn.content) }] });
        } else if (turn?.role === 'user') {
            contents.push({ role: 'user', parts: [{ text: stringifyToolResult(turn.content) }] });
        } else if (turn?.role === 'system') {
            contents.push({ role: 'user', parts: [{ text: `SYSTEM: ${stringifyToolResult(turn.content)}` }] });
        }
    }
    if (contents.length === 0) {
        contents.push({ role: 'user', parts: [{ text: '_' }] });
    }
    return normalizeGeminiContents(contents);
}


function withOpenAIThinking(message, turn, options = {}) {
    const key = options.reasoningKey || options.reasoning_key || turn?.thinking_key;
    if (!key) return message;
    const thinking = normalizeThinkingText(turn?.thinking);
    if (thinking || options.requireReasoningContent || options.require_reasoning_content) {
        message[key] = thinking;
    }
    return message;
}

function toAnthropicThinkingBlocks(turn) {
    const blocks = normalizeThinkingBlocks(turn?.thinking_blocks || turn?.thinkingBlocks);
    if (blocks.length > 0) return blocks;
    const thinking = normalizeThinkingText(turn?.thinking);
    // Anthropic replay requires signed thinking blocks. Do not synthesize unsigned
    // provider-only thinking blocks; keep the text in trace/history instead.
    return thinking && turn?.thinking_signature
        ? [{ type: 'thinking', thinking, signature: turn.thinking_signature }]
        : [];
}

function toGeminiThinkingParts(turn) {
    const blocks = normalizeThinkingBlocks(turn?.thinking_blocks || turn?.thinkingBlocks);
    if (blocks.length > 0) {
        return blocks.map(block => ({
            text: normalizeThinkingText(block.thinking || block.text || block.content),
            thought: true,
            ...(block.thoughtSignature || block.thought_signature ? { thoughtSignature: block.thoughtSignature || block.thought_signature } : {})
        })).filter(part => part.text);
    }
    const thinking = normalizeThinkingText(turn?.thinking);
    return thinking ? [{ text: thinking, thought: true }] : [];
}

function toOpenAIChatToolCall(call) {
    return {
        id: call.id,
        type: 'function',
        function: {
            name: call.name,
            arguments: normalizeArguments(call.arguments)
        }
    };
}

function toOpenAIChatContent(content) {
    if (!Array.isArray(content)) {
        return stringifyToolResult(content);
    }
    return content.map(part => {
        if (part?.type === 'input_text') {
            return { type: 'text', text: stringifyToolResult(part.text) };
        }
        if (part?.type === 'input_image') {
            return { type: 'image_url', image_url: { url: part.image_url || part.imageUrl || part.url } };
        }
        if (part?.type === 'image_url' && typeof part.image_url === 'string') {
            return { ...part, image_url: { url: part.image_url } };
        }
        return part;
    });
}

function toResponsesMessageContent(content, role) {
    if (!Array.isArray(content)) {
        return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: stringifyToolResult(content) }];
    }
    return content.map(part => {
        if (part?.type === 'text') {
            return { type: role === 'assistant' ? 'output_text' : 'input_text', text: stringifyToolResult(part.text) };
        }
        if (part?.type === 'image_url') {
            const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            return { type: 'input_image', image_url: imageUrl };
        }
        return part;
    });
}

function toAnthropicMessageContent(content) {
    if (!Array.isArray(content)) {
        return stringifyToolResult(content);
    }
    return content;
}

function normalizeAlternatingMessages(messages) {
    const normalized = [];
    for (const message of messages) {
        const previous = normalized[normalized.length - 1];
        if (previous && previous.role === message.role && canMergeAnthropicContent(previous.content, message.content)) {
            previous.content = mergeAnthropicContent(previous.content, message.content);
        } else {
            normalized.push(message);
        }
    }
    if (normalized.length === 0 || normalized[0].role !== 'user') {
        normalized.unshift({ role: 'user', content: '_' });
    }
    return normalized;
}

function canMergeAnthropicContent(left, right) {
    return (typeof left === 'string' || Array.isArray(left)) && (typeof right === 'string' || Array.isArray(right));
}

function mergeAnthropicContent(left, right) {
    if (typeof left === 'string' && typeof right === 'string') {
        return `${left}\n${right}`;
    }
    return [
        ...toAnthropicContentBlocks(left),
        ...toAnthropicContentBlocks(right)
    ];
}

function toAnthropicContentBlocks(content) {
    if (Array.isArray(content)) return content;
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    return [{ type: 'text', text: stringifyToolResult(content) }];
}

function normalizeGeminiContents(contents) {
    const normalized = [];
    for (const content of contents) {
        const previous = normalized[normalized.length - 1];
        if (previous && previous.role === content.role) {
            previous.parts.push(...(content.parts || []));
        } else {
            normalized.push(content);
        }
    }
    return normalized;
}

function cleanGeminiSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }
    if (Array.isArray(schema)) {
        return schema.map(cleanGeminiSchema);
    }
    const out = {};
    for (const [key, value] of Object.entries(schema)) {
        if (['additionalProperties', '$schema'].includes(key)) {
            continue;
        }
        out[key] = cleanGeminiSchema(value);
    }
    return out;
}
