import OpenAIApi from 'openai';
import { getKey, recordKeyFailure, getKeyCount } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class OpenRouter {
    static prefix = 'openrouter';
    constructor(model_name, url, params) {
        this.model_name = model_name || 'meta-llama/llama-3.3-70b-instruct';
        this.url = url || 'https://openrouter.ai/api/v1';
        this.params = params || {};
        this._initClient();
    }

    _initClient() {
        this.currentKey = getKey('OPENROUTER_API_KEY');
        this.openai = new OpenAIApi({
            baseURL: this.url,
            apiKey: this.currentKey
        });
    }

    async sendRequest(turns, systemMessage, stop_seq='*') {
        let messages = [{ role: 'system', content: systemMessage }, ...turns];
        messages = strictFormat(messages);

        const pack = {
            model: this.model_name,
            messages,
            stop: stop_seq,
            stream: false,
            ...(this.params || {})
        };

        const maxRetries = getKeyCount('OPENROUTER_API_KEY') > 1 ? 2 : 1;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                console.log(`Awaiting OpenRouter response (${this.model_name})...`);
                let completion = await this.openai.chat.completions.create(pack);
                if (!completion?.choices?.[0]) {
                    console.error('No completion or choices returned:', completion);
                    return 'No response received.';
                }
                if (completion.choices[0].finish_reason === 'length') {
                    throw new Error('Context length exceeded');
                }
                let res = completion.choices[0].message.content || '';
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                return res;
            } catch (err) {
                const isRateLimit = err?.status === 429 || err?.message?.includes('rate limit') || err?.message?.includes('429');
                if (isRateLimit && attempt < maxRetries - 1) {
                    console.warn('[OpenRouter] Rate limit encountered, rotating key...');
                    recordKeyFailure('OPENROUTER_API_KEY', this.currentKey);
                    this._initClient();
                    continue;
                }
                console.error('OpenRouter error:', err?.message || err);
                return 'My brain disconnected, try again.';
            }
        }
        return 'My brain disconnected, try again.';
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });
        
        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Openrouter.');
    }
}