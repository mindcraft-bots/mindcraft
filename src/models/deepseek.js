import OpenAIApi from 'openai';
import { getKey, recordKeyFailure, getKeyCount } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class DeepSeek {
    static prefix = 'deepseek';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};
        this.url = url || 'https://api.deepseek.com';
        this._initClient();
    }

    _initClient() {
        this.currentKey = getKey('DEEPSEEK_API_KEY');
        this.openai = new OpenAIApi({
            baseURL: this.url,
            apiKey: this.currentKey
        });
    }

    async sendRequest(turns, systemMessage, stop_seq='***') {
        let messages = [{'role': 'system', 'content': systemMessage}].concat(turns);
        messages = strictFormat(messages);

        const model = this.model_name || "deepseek-chat";
        const pack = {
            model,
            messages,
            stop: stop_seq,
            stream: false,
            ...(this.params || {})
        };

        const maxRetries = getKeyCount('DEEPSEEK_API_KEY') > 1 ? 2 : 1;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                console.log(`Awaiting DeepSeek response (${model})...`);
                let completion = await this.openai.chat.completions.create(pack);
                if (completion?.choices?.[0]?.finish_reason === 'length')
                    throw new Error('Context length exceeded'); 
                let res = completion?.choices?.[0]?.message?.content || '';
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                return res;
            } catch (err) {
                const isRateLimit = err?.status === 429 || err?.message?.includes('rate limit') || err?.message?.includes('429');
                if (isRateLimit && attempt < maxRetries - 1) {
                    console.warn('[DeepSeek] Rate limit encountered, rotating key...');
                    recordKeyFailure('DEEPSEEK_API_KEY', this.currentKey);
                    this._initClient();
                    continue;
                }
                if ((err.message == 'Context length exceeded' || err.code == 'context_length_exceeded') && turns.length > 1) {
                    console.log('Context length exceeded, trying again with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
                } else {
                    console.error('DeepSeek error:', err?.message || err);
                    return 'My brain disconnected, try again.';
                }
            }
        }
        return 'My brain disconnected, try again.';
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Deepseek.');
    }
}



