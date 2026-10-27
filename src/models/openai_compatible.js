import OpenAIApi from 'openai';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getKey, hasKey } from '../utils/keys.js';
import { createNativeToolResponse, normalizeThinkingText, toOpenAIChatMessages } from './native_tools.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { setLastTokenUsage } from './token_usage.js';

function getProxyAgent() {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (proxyUrl) {
        return new HttpsProxyAgent(proxyUrl);
    }
    return undefined;
}

/**
 * OpenAI Chat Completions protocol implementation.
 *
 * This is the single transport used by OpenAI and OpenAI-compatible hosted
 * providers such as OpenRouter, SiliconFlow, Qwen, DeepSeek, Groq, Mistral,
 * Mercury, Hyperbolic, Novita, HuggingFace router, Ollama /v1, vLLM /v1.
 * Provider identity, baseUrl and keyName live in settings_llm_providers.json; profiles
 * only select provider/model.
 */
export class OpenAICompletions {
    static prefix = 'openai-completions';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};
        this.url = url;
        this.provider = 'openai';
        this.default_model = 'gpt-5.4-mini';
        this.supportsNativeToolCalls = true;
        this.initClient();
    }

    initClient() {
        this.params = this.params || {};
        const hasExplicitApiKeyName = Object.prototype.hasOwnProperty.call(this.params, 'apiKeyName') ||
            Object.prototype.hasOwnProperty.call(this.params, 'api_key_name');
        const apiKeyName = hasExplicitApiKeyName
            ? (this.params.apiKeyName ?? this.params.api_key_name)
            : 'OPENAI_API_KEY';
        this.provider = this.params.provider || this.params.providerName || this.params.provider_name || inferProviderName(this.url) || 'openai';
        this.default_model = this.params.defaultModel || this.params.default_model || this.default_model || this.model_name;

        delete this.params.apiKeyName;
        delete this.params.api_key_name;
        delete this.params.provider;
        delete this.params.providerName;
        delete this.params.provider_name;
        delete this.params.defaultModel;
        delete this.params.default_model;

        this.reasoning_key = this.params.reasoningKey || this.params.reasoning_key || (this.provider === 'kimi' ? 'reasoning_content' : null);
        this.require_reasoning_content = Boolean(this.params.requireReasoningContent ?? this.params.require_reasoning_content ?? (this.provider === 'kimi'));
        delete this.params.reasoningKey;
        delete this.params.reasoning_key;
        delete this.params.requireReasoningContent;
        delete this.params.require_reasoning_content;

        const config = {};
        if (this.url) config.baseURL = this.url;
        if (hasKey('OPENAI_ORG_ID')) config.organization = getKey('OPENAI_ORG_ID');
        config.apiKey = apiKeyName ? getKey(apiKeyName) : 'not-needed';
        const defaultHeaders = this.params.defaultHeaders || this.params.default_headers || this.params.headers;
        if (defaultHeaders && typeof defaultHeaders === 'object') config.defaultHeaders = defaultHeaders;
        const transport = this.params.transport || this.params.httpTransport || this.params.http_transport;
        if (transport === 'curl') config.fetch = curlFetch;
        delete this.params.defaultHeaders;
        delete this.params.default_headers;
        delete this.params.headers;
        delete this.params.transport;
        delete this.params.httpTransport;
        delete this.params.http_transport;
        const agent = getProxyAgent();
        if (agent) config.httpAgent = agent;
        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='***', tools=null) {
        this.lastTokenUsage = null;
        this.lastThinking = '';
        const model = this.model_name || this.default_model;
        const hasTools = Array.isArray(tools) && tools.length > 0;
        let res = null;

        try {
            const messages = toOpenAIChatMessages(turns, systemMessage, {
                reasoningKey: this.reasoning_key,
                requireReasoningContent: this.require_reasoning_content
            });
            const pack = {
                model,
                messages,
                ...toOpenAIChatRequestParams(this.params, this.provider)
            };
            if (hasTools) {
                pack.tools = tools;
            } else if (stop_seq) {
                pack.stop = Array.isArray(stop_seq) ? stop_seq : [stop_seq];
            }
            if (model.includes('o1') || model.includes('o3') || model.includes('5') || this.provider === 'xai') {
                delete pack.stop;
            }
            console.log(hasTools
                ? `Awaiting ${this.provider} response with native tool calling (${tools.length} tools) from model ${model}`
                : `Awaiting ${this.provider} api response from model ${model}`);
            const completion = await this.openai.chat.completions.create(pack);
            const choice = completion?.choices?.[0];
            if (!choice) return 'No response received.';
            if (choice.finish_reason === 'length') throw new Error('Context length exceeded');
            console.log('Received.');
            setLastTokenUsage(this, completion?.usage);
            const message = choice.message;
            this.lastThinking = extractOpenAIThinking(message, this.reasoning_key);
            if (message?.tool_calls?.length) {
                return createNativeToolResponse(message.tool_calls, this.provider, {
                    thinking: this.lastThinking,
                    reasoningKey: this.reasoning_key
                });
            }
            res = message?.content || '';
        } catch (err) {
            if ((err.message === 'Context length exceeded' || err.code === 'context_length_exceeded') && turns.length > 1) {
                console.log('Context length exceeded, trying again with shorter context.');
                return await this.sendRequest(turns.slice(1), systemMessage, stop_seq, tools);
            } else if (err.message?.includes('image_url')) {
                console.log(err);
                res = 'Vision is only supported by certain models.';
            } else {
                console.log(err);
                res = providerFacingError(err, this.provider);
            }
        }
        return res;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: 'user',
            content: [
                { type: 'text', text: systemMessage },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` } }
            ]
        });
        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        if (text.length > 8191) text = text.slice(0, 8191);
        const embedding = await this.openai.embeddings.create({
            model: this.model_name || 'text-embedding-3-small',
            input: text,
            encoding_format: 'float',
            ...toOpenAIChatRequestParams(this.params, this.provider)
        });
        return embedding.data[0].embedding;
    }
}

// Backward-compatible alias for old configs/tests. New configs should use
// the protocol name: openai-completions.
export class OpenAICompatible extends OpenAICompletions {
    static prefix = 'openai-compatible';
}

const sendAudioRequest = async (text, model, voice, url) => {
    const payload = { model, voice, input: text };
    const config = {};
    if (url) config.baseURL = url;
    if (hasKey('OPENAI_ORG_ID')) config.organization = getKey('OPENAI_ORG_ID');
    config.apiKey = getKey('OPENAI_API_KEY');
    const openai = new OpenAIApi(config);
    const mp3 = await openai.audio.speech.create(payload);
    const buffer = Buffer.from(await mp3.arrayBuffer());
    return buffer.toString('base64');
};

export const TTSConfig = {
    sendAudioRequest,
    baseUrl: 'https://api.openai.com/v1',
};


function extractOpenAIThinking(message, reasoningKey) {
    if (!message || typeof message !== 'object') return '';
    return normalizeThinkingText(
        message[reasoningKey] ??
        message.reasoning_content ??
        message.reasoning ??
        message.thinking ??
        message.thought
    );
}

function providerFacingError(err, provider) {
    if (provider === 'azure' && (err?.code === 'DeploymentNotFound' || err?.error?.code === 'DeploymentNotFound')) {
        return 'Azure deployment not found. Check the Azure deployment name configured for this profile.';
    }
    if (provider === 'ollama_cloud' && err?.status === 403) {
        return 'Ollama Cloud rejected the request. Check that OLLAMA_API_KEY has subscription access to the selected cloud model.';
    }
    return 'My brain disconnected, try again.';
}

function toOpenAIChatRequestParams(params, provider) {
    const requestParams = { ...(params || {}) };
    delete requestParams.tool_choice;
    delete requestParams.toolChoice;

    // User-facing config follows OpenAI Responses/Codex shape:
    // { reasoning: { effort: "medium" } }. Chat Completions expects
    // reasoning_effort instead, and rejects the nested reasoning object.
    if (requestParams.reasoning?.effort && provider === 'openai') {
        requestParams.reasoning_effort = requestParams.reasoning.effort;
        delete requestParams.reasoning;
    }
    return requestParams;
}

function inferProviderName(url) {
    if (!url) return null;
    try {
        const host = new URL(url).hostname.replace(/^api\./, '').replace(/^dashscope\./, 'qwen.');
        const first = host.split('.')[0];
        return first || null;
    } catch {
        return null;
    }
}

async function curlFetch(url, init = {}) {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'mindcraft-openai-curl-'));
    const headersPath = path.join(tempDir, 'headers.txt');
    const bodyPath = path.join(tempDir, 'body.bin');
    const requestBodyPath = path.join(tempDir, 'request-body.bin');
    const configPath = path.join(tempDir, 'curl.conf');
    try {
        const method = init.method || (init.body ? 'POST' : 'GET');
        const config = [
            `url = ${curlQuote(String(url))}`,
            `request = ${curlQuote(method)}`,
            `dump-header = ${curlQuote(headersPath)}`,
            `output = ${curlQuote(bodyPath)}`,
            'silent',
            'show-error',
            'location',
            'max-time = 300'
        ];

        for (const [name, value] of headerEntries(init.headers)) {
            config.push(`header = ${curlQuote(`${name}: ${value}`)}`);
        }

        if (init.body !== undefined && init.body !== null) {
            writeFileSync(requestBodyPath, bodyToString(init.body));
            config.push(`data-binary = ${curlQuote(`@${requestBodyPath}`)}`);
        }

        writeFileSync(configPath, `${config.join('\n')}\n`, { mode: 0o600 });
        await runCurl(configPath);
        const headersText = readFileSync(headersPath, 'utf8');
        const body = readFileSync(bodyPath);
        const { status, headers } = parseCurlHeaders(headersText);
        return new Response(body, { status, headers });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}

function runCurl(configPath) {
    return new Promise((resolve, reject) => {
        const child = spawn('curl', ['--config', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`curl exited with code ${code}: ${stderr.trim()}`));
            }
        });
    });
}

function headerEntries(headers = {}) {
    if (headers instanceof Headers) {
        return Array.from(headers.entries());
    }
    if (Array.isArray(headers)) {
        return headers;
    }
    return Object.entries(headers || {});
}

function bodyToString(body) {
    if (body instanceof URLSearchParams) {
        return body.toString();
    }
    if (Buffer.isBuffer(body)) {
        return body;
    }
    return String(body);
}

function curlQuote(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseCurlHeaders(headersText) {
    const blocks = headersText.trim().split(/\r?\n\r?\n/).filter(Boolean);
    const block = blocks[blocks.length - 1] || '';
    const lines = block.split(/\r?\n/);
    const statusMatch = lines.shift()?.match(/^HTTP\/\S+\s+(\d+)/);
    const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 0;
    const headers = new Headers();
    for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx > 0) {
            headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
        }
    }
    return { status, headers };
}
