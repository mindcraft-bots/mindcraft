import Replicate from 'replicate';
import { strictTextFormat, toSinglePrompt } from '../utils/text.js';
import { getKey } from '../utils/keys.js';
import { createNativeToolResponse, normalizeThinkingText } from './native_tools.js';

// Replicate Predictions API. This is not OpenAI-compatible: individual
// Replicate models define their own input/output schemas.
export class ReplicateAPI {
    static prefix = 'replicate';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.url = url;
        this.params = params || {};
        this.provider = this.params.provider || 'replicate';
        this.supportsNativeToolCalls = true;

        if (this.url) {
            console.warn('Replicate API does not support custom URLs. Ignoring provided URL.');
        }

        const apiKeyName = this.params.apiKeyName || this.params.api_key_name || 'REPLICATE_API_KEY';
        delete this.params.apiKeyName;
        delete this.params.api_key_name;
        delete this.params.provider;

        this.replicate = new Replicate({
            auth: getKey(apiKeyName),
        });
    }

    async sendRequest(turns, systemMessage, stop_seq = '<|EOT|>', tools = null) {
        this.lastThinking = '';
        const modelName = this.model_name || 'google/gemini-2.5-flash';
        if (Array.isArray(tools) && tools.length > 0) {
            return this.sendToolRequest(modelName, turns, systemMessage, tools);
        }
        return this.sendTextRequest(modelName, turns, systemMessage, stop_seq);
    }

    async sendTextRequest(modelName, turns, systemMessage, stopSeq) {
        try {
            console.log(`Awaiting Replicate API response from ${modelName}...`);
            const prompt = toSinglePrompt(turns, null, stopSeq);
            const isGemini = isGeminiReplicateModel(modelName);
            const input = buildReplicateTextInput(modelName, prompt, systemMessage, this.params);
            let result = '';
            if (isGemini) {
                // PR #680 verified Gemini models return empty streams on Replicate.
                // The official Gemini schema is prompt-based, so use run().
                const output = await this.replicate.run(modelName, { input });
                this.lastThinking = extractReplicateThinking(output);
                result = stringifyReplicateOutput(output);
                if (result.includes(stopSeq)) {
                    result = result.slice(0, result.indexOf(stopSeq));
                }
                console.log('Received.');
                return result;
            }

            for await (const event of this.replicate.stream(modelName, { input })) {
                this.lastThinking = normalizeThinkingText([this.lastThinking, extractReplicateThinking(event)]);
                result += stringifyReplicateEvent(event);
                if (result === '') break;
                if (result.includes(stopSeq)) {
                    result = result.slice(0, result.indexOf(stopSeq));
                    break;
                }
            }
            console.log('Received.');
            return result;
        } catch (err) {
            console.log(err);
            return 'My brain disconnected, try again.';
        }
    }

    async sendToolRequest(modelName, turns, systemMessage, tools) {
        const messages = [
            { role: 'system', content: systemMessage },
            ...strictTextFormat(turns)
        ];
        const prompt = toSinglePrompt(turns, systemMessage, '<|EOT|>');
        const input = {
            prompt,
            system_instruction: systemMessage,
            messages,
            tools,
            ...(this.params || {})
        };

        try {
            console.log(`Awaiting Replicate API response with native tool calling (${tools.length} tools) from ${modelName}...`);
            const output = await this.replicate.run(modelName, { input });
            this.lastThinking = extractReplicateThinking(output);
            const toolCalls = extractReplicateToolCalls(output);
            if (toolCalls.length > 0) {
                console.log(`Received ${toolCalls.length} Replicate tool call(s).`);
                return createNativeToolResponse(toolCalls, this.provider, { thinking: this.lastThinking });
            }
            console.log('Received.');
            return stringifyReplicateOutput(output);
        } catch (err) {
            console.log(err);
            return 'My brain disconnected, try again.';
        }
    }

    async embed(text) {
        if (!text || typeof text !== 'string') {
            throw new Error('Text is required for Replicate embeddings.');
        }
        const embeddingModel = isEmbeddingReplicateModel(this.model_name)
            ? this.model_name
            : 'mark3labs/embeddings-gte-base';
        const output = await this.replicate.run(
            embeddingModel,
            { input: { text, ...(this.params || {}) } }
        );
        const embedding = extractReplicateEmbedding(output);
        if (!embedding) {
            throw new Error('Unknown Replicate embedding output format.');
        }
        return embedding;
    }
}

function buildReplicateTextInput(modelName, prompt, systemMessage, params = {}) {
    if (isGeminiReplicateModel(modelName)) {
        // Replicate's Gemini model schema documents `prompt` and
        // `system_instruction`; PR #680 additionally found that including the
        // system message in the prompt is the reliable path across versions.
        return {
            prompt: systemMessage ? `${systemMessage}\n\n${prompt}` : prompt,
            system_instruction: systemMessage,
            ...(params || {})
        };
    }
    return {
        prompt,
        system_prompt: systemMessage,
        ...(params || {})
    };
}

function isGeminiReplicateModel(modelName = '') {
    return String(modelName).toLowerCase().includes('gemini');
}

function isEmbeddingReplicateModel(modelName = '') {
    const normalized = String(modelName || '').toLowerCase();
    return normalized.includes('embed') || normalized.includes('gte') || normalized.includes('e5-');
}

function extractReplicateEmbedding(output) {
    if (!output) return null;
    if (output.vectors) return output.vectors;
    if (output.embedding) return output.embedding;
    if (output.embeddings) {
        return Array.isArray(output.embeddings?.[0]) ? output.embeddings[0] : output.embeddings;
    }
    if (Array.isArray(output)) return output;
    return null;
}

function extractReplicateToolCalls(output) {
    if (!output) return [];
    if (Array.isArray(output?.tool_calls)) return output.tool_calls;
    if (Array.isArray(output?.toolCalls)) return output.toolCalls;
    if (output?.function_call) return [{ type: 'function', function: output.function_call }];
    if (Array.isArray(output)) {
        return output.flatMap(item => extractReplicateToolCalls(item));
    }
    return [];
}

function extractReplicateThinking(output) {
    if (!output) return '';
    if (typeof output === 'string') return '';
    if (Array.isArray(output)) return normalizeThinkingText(output.map(extractReplicateThinking));
    if (typeof output !== 'object') return '';
    const direct = normalizeThinkingText(
        output.thinking ??
        output.reasoning_content ??
        output.reasoning ??
        output.thought ??
        ''
    );
    if (direct) return direct;
    return normalizeThinkingText([
        extractReplicateThinking(output.content),
        extractReplicateThinking(output.output),
        extractReplicateThinking(output.message)
    ]);
}

function stringifyReplicateOutput(output) {
    if (typeof output === 'string') return output;
    if (Array.isArray(output)) return output.map(stringifyReplicateOutput).join('');
    if (output?.content) return stringifyReplicateOutput(output.content);
    if (output?.text) return stringifyReplicateOutput(output.text);
    return output == null ? '' : JSON.stringify(output);
}

function stringifyReplicateEvent(event) {
    if (typeof event === 'string') return event;
    if (event == null) return '';
    if (typeof event === 'object' && 'data' in event) return stringifyReplicateOutput(event.data);
    return stringifyReplicateOutput(event);
}
