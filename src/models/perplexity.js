import OpenAIApi from 'openai';
import { getKey, recordKeyFailure, getKeyCount } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class Perplexity {
    static prefix = 'perplexity';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};
        this.url = url || 'https://api.perplexity.ai';
        this._initClient();
    }

    _initClient() {
        this.currentKey = getKey('PERPLEXITY_API_KEY');
        this.openai = new OpenAIApi({
            baseURL: this.url,
            apiKey: this.currentKey
        });
    }

    async sendRequest(turns, systemMessage, stop_seq = '***') {
        let messages = [{ role: 'system', content: systemMessage }].concat(turns);
        messages = strictFormat(messages);

        const model = this.model_name || 'sonar-pro';
        const pack = {
            model,
            messages,
            stream: false,
            ...(this.params || {})
        };

        const maxRetries = getKeyCount('PERPLEXITY_API_KEY') > 1 ? 2 : 1;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                console.log(`Awaiting Perplexity response (${model})...`);
                const completion = await this.openai.chat.completions.create(pack);
                let res = completion?.choices?.[0]?.message?.content || '';
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                return res;
            } catch (err) {
                const isRateLimit = err?.status === 429 || err?.message?.includes('rate limit') || err?.message?.includes('429');
                if (isRateLimit && attempt < maxRetries - 1) {
                    console.warn(`[Perplexity] Rate limit encountered, rotating key...`);
                    recordKeyFailure('PERPLEXITY_API_KEY', this.currentKey);
                    this._initClient();
                    continue;
                }
                if (err?.message?.includes('context_length') && turns.length > 1) {
                    console.log('[Perplexity] Context length exceeded, retrying with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
                }
                console.error('[Perplexity] Error:', err?.message || err);
                return 'My brain disconnected, try again.';
            }
        }
        return 'My brain disconnected, try again.';
    }

    async embed(_) {
        throw new Error('Embeddings are not supported by Perplexity.');
    }
}
