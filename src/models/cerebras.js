import CerebrasSDK from '@cerebras/cerebras_cloud_sdk';
import { strictFormat } from '../utils/text.js';
import { getKey, recordKeyFailure, getKeyCount } from '../utils/keys.js';

export class Cerebras {
    static prefix = 'cerebras';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.url = url;
        this.params = params || {};
        this._initClient();
    }

    _initClient() {
        this.currentKey = getKey('CEREBRAS_API_KEY');
        const opts = { apiKey: this.currentKey };
        if (this.url) opts.baseURL = this.url;
        this.client = new CerebrasSDK(opts);
    }

    async sendRequest(turns, systemMessage, stop_seq = '***') {
        const messages = strictFormat(turns);
        messages.unshift({ role: 'system', content: systemMessage });

        const model = this.model_name || 'llama-3.3-70b';
        const pack = {
            model,
            messages,
            stream: false,
            ...(this.params || {}),
        };

        const maxRetries = getKeyCount('CEREBRAS_API_KEY') > 1 ? 2 : 1;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const completion = await this.client.chat.completions.create(pack);
                let res = completion.choices?.[0]?.message?.content || '';
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                return res;
            } catch (err) {
                const isRateLimit = err?.status === 429 || err?.message?.includes('rate limit') || err?.message?.includes('429');
                if (isRateLimit && attempt < maxRetries - 1) {
                    console.warn('[Cerebras] Rate limit encountered, rotating key...');
                    recordKeyFailure('CEREBRAS_API_KEY', this.currentKey);
                    this._initClient();
                    continue;
                }
                const isNotFound = err?.status === 404 || err?.message?.includes('model_not_found') || err?.message?.includes('does not exist');
                if (isNotFound && pack.model !== 'llama3.1-8b') {
                    console.warn(`[Cerebras] Model ${pack.model} not available, falling back to llama3.1-8b...`);
                    pack.model = 'llama3.1-8b';
                    attempt--;
                    continue;
                }
                console.error('Cerebras API error:', err?.message || err);
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
        throw new Error('Embeddings are not supported by Cerebras.');
    }
}
