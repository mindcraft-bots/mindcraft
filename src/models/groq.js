import Groq from 'groq-sdk';
import { getKey, recordKeyFailure, getKeyCount } from '../utils/keys.js';

// THIS API IS NOT TO BE CONFUSED WITH GROK!
// Go to grok.js for that. :)

// Umbrella class for everything under the sun... That GroqCloud provides, that is.
export class GroqCloudAPI {
    static prefix = 'groq';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.url = url;
        this.params = params || {};

        if (this.params.tools)
            delete this.params.tools;

        this._initClient();
    }

    _initClient() {
        this.currentKey = getKey('GROQCLOUD_API_KEY');
        const opts = { apiKey: this.currentKey };
        if (this.url) opts.baseURL = this.url;
        this.groq = new Groq(opts);
    }

    async sendRequest(turns, systemMessage, stop_seq = null) {
        let messages = [{ role: 'system', content: systemMessage }].concat(turns);

        // Handle deprecated max_tokens parameter
        if (this.params.max_tokens) {
            this.params.max_completion_tokens = this.params.max_tokens;
            delete this.params.max_tokens;
        }

        if (!this.params.max_completion_tokens) {
            this.params.max_completion_tokens = 4000;
        }

        const model = this.model_name || 'llama-3.3-70b-versatile';
        const pack = {
            messages,
            model,
            stream: false,
            stop: stop_seq,
            ...(this.params || {})
        };

        const maxRetries = getKeyCount('GROQCLOUD_API_KEY') > 1 ? 2 : 1;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                console.log(`Awaiting Groq response (${model})...`);
                let completion = await this.groq.chat.completions.create(pack);
                let res = completion.choices[0]?.message?.content || '';
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                return res;
            } catch (err) {
                const isRateLimit = err?.status === 429 || err?.message?.includes('rate limit') || err?.message?.includes('429');
                if (isRateLimit && attempt < maxRetries - 1) {
                    console.warn('[Groq] Rate limit encountered, rotating key...');
                    recordKeyFailure('GROQCLOUD_API_KEY', this.currentKey);
                    this._initClient();
                    continue;
                }
                const isNotFound = err?.status === 404 || err?.message?.includes('model_not_found') || err?.message?.includes('does not exist') || err?.message?.includes('decommissioned');
                if (isNotFound && pack.model !== 'llama-3.1-8b-instant') {
                    console.warn(`[Groq] Model ${pack.model} not available, falling back to llama-3.1-8b-instant...`);
                    pack.model = 'llama-3.1-8b-instant';
                    attempt--;
                    continue;
                }
                    continue;
                }
                if (err.message && err.message.includes('content must be a string')) {
                    return 'Vision is only supported by certain models.';
                }
                console.error('[Groq] Error:', err?.message || err);
                return 'My brain disconnected, try again.';
            }
        }
        return 'My brain disconnected, try again.';
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = messages.filter(message => message.role !== 'system');
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
        
        return this.sendRequest(imageMessages);
    }

    async embed(_) {
        throw new Error('Embeddings are not supported by Groq.');
    }
}
