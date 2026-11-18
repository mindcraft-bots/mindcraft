import OpenAIApi from 'openai';
import { getKey, recordKeyFailure, getKeyCount } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class TogetherAI {
    static prefix = 'together';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};
        this.url = url || 'https://api.together.xyz/v1';
        this._initClient();
    }

    _initClient() {
        this.currentKey = getKey('TOGETHER_API_KEY');
        this.openai = new OpenAIApi({
            baseURL: this.url,
            apiKey: this.currentKey
        });
    }

    async sendRequest(turns, systemMessage, stop_seq = '***') {
        let messages = [{ role: 'system', content: systemMessage }].concat(turns);
        messages = strictFormat(messages);

        const model = this.model_name || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
        const pack = {
            model,
            messages,
            stop: stop_seq,
            stream: false,
            ...(this.params || {})
        };

        const maxRetries = getKeyCount('TOGETHER_API_KEY') > 1 ? 2 : 1;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                console.log(`Awaiting Together AI response (${model})...`);
                const completion = await this.openai.chat.completions.create(pack);
                let res = completion?.choices?.[0]?.message?.content || '';
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                return res;
            } catch (err) {
                const isRateLimit = err?.status === 429 || err?.message?.includes('rate limit') || err?.message?.includes('429');
                if (isRateLimit && attempt < maxRetries - 1) {
                    console.warn(`[Together] Rate limit encountered, rotating key...`);
                    recordKeyFailure('TOGETHER_API_KEY', this.currentKey);
                    this._initClient();
                    continue;
                }
                if (err?.message?.includes('context_length') && turns.length > 1) {
                    console.log('[Together] Context length exceeded, retrying with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
                }
                console.error('[Together] Error:', err?.message || err);
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
            model: 'togethercomputer/m2-bert-80M-8k-retrieval',
            input: text
        });
        return res.data[0].embedding;
    }
}
