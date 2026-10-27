import { OpenAICompletions } from './openai_compatible.js';
import { createNativeToolResponse, normalizeThinkingText, toResponsesInputItems } from './native_tools.js';
import { setLastTokenUsage } from './token_usage.js';

// OpenAI Responses protocol. For native tool calls this class
// uses Responses API function-call items directly instead of the legacy GPT file.
export class OpenAIResponses extends OpenAICompletions {
    static prefix = 'openai-responses';

    async sendRequest(turns, systemMessage, stop_seq='***', tools=null) {
        this.lastTokenUsage = null;
        this.lastThinking = '';
        const model = this.model_name || this.default_model;
        const hasTools = Array.isArray(tools) && tools.length > 0;
        const input = toResponsesInputItems(turns);
        if (stop_seq && !hasTools) {
            appendStopSequence(input, stop_seq);
        }
        const request = {
            model,
            instructions: systemMessage,
            input,
            ...stripToolChoiceParams(this.params)
        };
        if (hasTools) {
            request.tools = toResponsesTools(tools);
        }

        try {
            console.log(hasTools
                ? `Awaiting ${this.provider} Responses API with native tool calling (${tools.length} tools) from model ${model}`
                : `Awaiting ${this.provider} Responses API from model ${model}`);
            const response = await this.openai.responses.create(request);
            console.log('Received.');
            setLastTokenUsage(this, response?.usage);
            this.lastThinking = extractResponsesThinking(response);
            const toolCalls = normalizeResponsesToolCalls(response);
            if (toolCalls.length > 0) {
                return createNativeToolResponse(toolCalls, this.provider, { thinking: this.lastThinking });
            }
            let res = response.output_text || '';
            const stopSeqIndex = stop_seq ? res.indexOf(stop_seq) : -1;
            return stopSeqIndex !== -1 ? res.slice(0, stopSeqIndex) : res;
        } catch (err) {
            if ((err.message === 'Context length exceeded' || err.code === 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq, tools);
            }
            console.log(err);
            return 'My brain disconnected, try again.';
        }
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: 'user',
            content: [
                { type: 'input_text', text: systemMessage },
                { type: 'input_image', image_url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` }
            ]
        });
        return this.sendRequest(imageMessages, systemMessage);
    }
}

function appendStopSequence(input, stopSeq) {
    const last = input[input.length - 1];
    const content = last?.content;
    if (Array.isArray(content)) {
        const textPart = [...content].reverse().find(part => typeof part?.text === 'string');
        if (textPart) textPart.text += stopSeq;
    }
}

function toResponsesTools(tools = []) {
    return tools.map(tool => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters
    }));
}

function normalizeResponsesToolCalls(response) {
    const output = response?.output || [];
    return output
        .filter(item => item?.type === 'function_call')
        .map((item, index) => ({
            id: item.call_id || item.id || `call_${Date.now()}_${index}`,
            type: 'function',
            name: item.name,
            arguments: item.arguments || '{}'
        }))
        .filter(call => call.name);
}

function stripToolChoiceParams(params) {
    const requestParams = { ...(params || {}) };
    delete requestParams.tool_choice;
    delete requestParams.toolChoice;
    return requestParams;
}


function extractResponsesThinking(response) {
    const output = response?.output || [];
    const chunks = [];
    for (const item of output) {
        if (item?.type !== 'reasoning') continue;
        chunks.push(normalizeThinkingText(item.summary || item.content || item.text));
        if (Array.isArray(item.summary)) {
            chunks.push(...item.summary.map(part => normalizeThinkingText(part.text || part.content || part.summary_text)));
        }
    }
    return chunks.filter(Boolean).join('\n');
}
