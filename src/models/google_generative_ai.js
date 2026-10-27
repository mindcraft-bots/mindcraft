import { GoogleGenAI } from '@google/genai';
import { getKey } from '../utils/keys.js';
import { createNativeToolResponse, normalizeGeminiFunctionCalls, normalizeThinkingText, toGeminiContents, toGeminiFunctionDeclarations } from './native_tools.js';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { setLastTokenUsage } from './token_usage.js';

function setupGeminiProxy() {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (proxyUrl) {
        setGlobalDispatcher(new ProxyAgent(proxyUrl));
    }
}
setupGeminiProxy();

const GEMINI_API_VERSION_PATTERN = /^v\d+(?:alpha|beta)?$/i;

function splitGeminiBaseUrl(rawUrl) {
    if (!rawUrl) {
        return {};
    }
    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const versionIndex = segments.findIndex(segment => GEMINI_API_VERSION_PATTERN.test(segment));
    if (versionIndex === -1) {
        parsed.pathname = parsed.pathname.replace(/\/$/, '') || '/';
        parsed.search = '';
        parsed.hash = '';
        return { baseUrl: parsed.toString().replace(/\/$/, '') };
    }

    const baseSegments = segments.slice(0, versionIndex);
    parsed.pathname = baseSegments.length > 0 ? `/${baseSegments.join('/')}` : '/';
    parsed.search = '';
    parsed.hash = '';
    return {
        baseUrl: parsed.toString().replace(/\/$/, ''),
        apiVersion: segments[versionIndex]
    };
}

export function normalizeGeminiHttpOptions(url, params = {}) {
    const nextParams = { ...(params || {}) };
    const httpOptions = { ...(nextParams.httpOptions || nextParams.http_options || {}) };
    const configuredUrl = url || httpOptions.baseUrl;
    if (configuredUrl) {
        const normalized = splitGeminiBaseUrl(configuredUrl);
        httpOptions.baseUrl = normalized.baseUrl;
        if (normalized.apiVersion && !httpOptions.apiVersion) {
            httpOptions.apiVersion = normalized.apiVersion;
        }
    }
    if (nextParams.apiVersion || nextParams.api_version) {
        httpOptions.apiVersion = nextParams.apiVersion || nextParams.api_version;
    }

    delete nextParams.httpOptions;
    delete nextParams.http_options;
    delete nextParams.apiVersion;
    delete nextParams.api_version;

    return {
        params: nextParams,
        httpOptions: Object.fromEntries(Object.entries(httpOptions).filter(([, value]) => value !== undefined && value !== null))
    };
}

// Google Generative AI protocol implementation.
export class GoogleGenerativeAI {
    static prefix = 'google-generative-ai';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        const { params: generationParams, httpOptions } = normalizeGeminiHttpOptions(url, params || {});
        this.params = generationParams;
        const apiKeyName = this.params.apiKeyName || this.params.api_key_name || 'GEMINI_API_KEY';
        delete this.params.apiKeyName;
        delete this.params.api_key_name;
        this.safetySettings = [
            { category: 'HARM_CATEGORY_DANGEROUS', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ];

        const clientConfig = { apiKey: getKey(apiKeyName) };
        if (Object.keys(httpOptions).length > 0) {
            clientConfig.httpOptions = httpOptions;
        }
        this.genAI = new GoogleGenAI(clientConfig);
        this.provider = 'google';
        this.supportsNativeToolCalls = true;
    }

    async sendRequest(turns, systemMessage, stop_seq='***', tools=null) {
        this.lastTokenUsage = null;
        this.lastThinking = '';
        this.lastThinkingBlocks = [];
        console.log(tools?.length ? `Awaiting Google API response with native tool calling (${tools.length} tools)...` : 'Awaiting Google API response...');

        const contents = toGeminiContents(turns);

        const requestConfig = {
            model: this.model_name || 'gemini-2.5-flash',
            contents,
            safetySettings: this.safetySettings,
            config: {
                systemInstruction: systemMessage,
                ...(this.params || {})
            }
        };
        if (Array.isArray(tools) && tools.length > 0) {
            requestConfig.config.tools = [{ functionDeclarations: toGeminiFunctionDeclarations(tools) }];
        }
        const result = await this.genAI.models.generateContent(requestConfig);
        setLastTokenUsage(this, result?.usageMetadata);
        const parts = result.candidates?.[0]?.content?.parts || [];
        const thinking = extractGeminiThinking(parts);
        this.lastThinking = thinking.text;
        this.lastThinkingBlocks = thinking.blocks;
        const toolCalls = normalizeGeminiFunctionCalls(parts);
        if (toolCalls.length > 0) {
            return createNativeToolResponse(toolCalls, this.provider, {
                thinking: this.lastThinking,
                thinking_blocks: this.lastThinkingBlocks
            });
        }
        const response = await result.text;
        if (!response && result.candidates?.[0]?.finishReason) {
            console.log('Received.');
            return `No response from Google Gemini. finishReason=${result.candidates[0].finishReason}`;
        }

        console.log('Received.');
        return response;
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        this.lastTokenUsage = null;
        this.lastThinking = '';
        this.lastThinkingBlocks = [];
        const imagePart = {
            inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType: 'image/jpeg'
            }
        };

        const contents = toGeminiContents(turns);
        contents.push({
            role: 'user',
            parts: [{ text: 'SYSTEM: Vision response' }, imagePart]
        });

        let res = null;
        try {
            console.log('Awaiting Google API vision response...');
            const result = await this.genAI.models.generateContent({
                model: this.model_name,
                contents,
                safetySettings: this.safetySettings,
                generationConfig: {
                    ...(this.params || {})
                },
                systemInstruction: systemMessage
            });
            setLastTokenUsage(this, result?.usageMetadata);
            const parts = result.candidates?.[0]?.content?.parts || [];
            const thinking = extractGeminiThinking(parts);
            this.lastThinking = thinking.text;
            this.lastThinkingBlocks = thinking.blocks;
            res = await result.text;
            console.log('Received.');
        } catch (err) {
            console.log(err);
            if (err.message.includes('Image input modality is not enabled for models/')) {
                res = 'Vision is only supported by certain models.';
            } else {
                res = 'An unexpected error occurred, please try again.';
            }
        }
        return res;
    }

    async embed(text) {
        const result = await this.genAI.models.embedContent({
            model: this.model_name || 'gemini-embedding-001',
            contents: text,
        });
        return result.embeddings;
    }
}

const sendAudioRequest = async (text, model, voice) => {
    const ai = new GoogleGenAI({ apiKey: getKey('GEMINI_API_KEY') });

    const response = await ai.models.generateContent({
        model,
        contents: [{ parts: [{ text }] }],
        config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voice },
                },
            },
        },
    });

    const pcmBase64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!pcmBase64) {
        console.warn('Gemini TTS: no audio data returned');
        return null;
    }

    const pcmBuffer = Buffer.from(pcmBase64, 'base64');
    const wavHeader = createWavHeader(pcmBuffer.length, 24000, 1, 16);
    return Buffer.concat([wavHeader, pcmBuffer]).toString('base64');
};

function createWavHeader(dataLength, sampleRate, channels, bitsPerSample) {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * channels * bitsPerSample / 8;
    const blockAlign = channels * bitsPerSample / 8;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);
    return header;
}

export const TTSConfig = {
    sendAudioRequest,
    baseUrl: undefined,
};


function extractGeminiThinking(parts = []) {
    const blocks = [];
    for (const part of parts || []) {
        if (part?.thought || part?.thoughtSignature || part?.thinking) {
            const thinking = normalizeThinkingText(part.thinking ?? part.text ?? part.thought);
            if (thinking || part.thoughtSignature) {
                blocks.push({
                    type: 'thinking',
                    thinking,
                    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
                });
            }
        }
    }
    return {
        text: blocks.map(block => block.thinking).filter(Boolean).join('\n'),
        blocks
    };
}
