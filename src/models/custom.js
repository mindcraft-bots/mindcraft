import OpenAIApi from 'openai';
import { getKey, hasKey, recordKeyFailure, getKeyCount } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class CustomOpenAI {
    static prefix = 'custom';
    constructor(model_name, url, params) {
        this.model_name = model_name || 'default';
        this.params = params || {};
        this.url = url || (hasKey('CUSTOM_API_URL') ? getKey('CUSTOM_API_URL') : 'http://localhost:8000/v1');
        this._initClient();
    }

    _initClient() {
        let key = 'none';
        if (hasKey('CUSTOM_API_KEY')) {
            key = getKey('CUSTOM_API_KEY');
        } else if (hasKey('OPENAI_API_KEY')) {
            key = getKey('OPENAI_API_KEY');
        }
        this.currentKey = key;
        this.openai = new OpenAIApi({
            baseURL: this.url,
            apiKey: this.currentKey
        });
    }

    async sendRequest(turns, systemMessage, stop_seq = '***') {
        let messages = [{ role: 'system', content: systemMessage }].concat(turns);
        messages = strictFormat(messages);

        const pack = {
            model: this.model_name,
            messages,
            stop: stop_seq,
            stream: false,
            ...(this.params || {})
        };

        const maxRetries = getKeyCount('CUSTOM_API_KEY') > 1 ? 2 : 1;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                console.log(`Awaiting custom API response (${this.model_name}) from ${this.url}...`);
                const completion = await this.openai.chat.completions.create(pack);
                let res = completion.choices[0]?.message?.content || '';
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                return res;
            } catch (err) {
                const isRateLimit = err?.status === 429 || err?.message?.includes('rate limit') || err?.message?.includes('429');
                if (isRateLimit && attempt < maxRetries - 1) {
                    console.warn(`[CustomAPI] Rate limit encountered, rotating key...`);
                    recordKeyFailure('CUSTOM_API_KEY', this.currentKey);
                    this._initClient();
                    continue;
                }
                if (err?.message?.includes('context_length') && turns.length > 1) {
                    console.log('[CustomAPI] Context length exceeded, retrying with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
                }
                console.error('[CustomAPI] Error:', err?.message || err);
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
        if (text.length > 4000) text = text.slice(0, 4000);
        const res = await this.openai.embeddings.create({
            model: this.params?.embedding_model || 'text-embedding-3-small',
            input: text
        });
        return res.data[0].embedding;
    }
}
