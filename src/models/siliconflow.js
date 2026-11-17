import OpenAIApi from 'openai';
import { getKey, recordKeyFailure, getKeyCount } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class SiliconFlow {
    static prefix = 'siliconflow';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};
        this.url = url || 'https://api.siliconflow.cn/v1';
        this._initClient();
    }

    _initClient() {
        this.currentKey = getKey('SILICONFLOW_API_KEY');
        this.openai = new OpenAIApi({
            baseURL: this.url,
            apiKey: this.currentKey
        });
    }

    async sendRequest(turns, systemMessage, stop_seq = '***') {
        let messages = [{ role: 'system', content: systemMessage }].concat(turns);
        messages = strictFormat(messages);

        const model = this.model_name || 'deepseek-ai/DeepSeek-V3';
        const pack = {
            model,
            messages,
            stop: stop_seq,
            stream: false,
            ...(this.params || {})
        };

        const maxRetries = getKeyCount('SILICONFLOW_API_KEY') > 1 ? 2 : 1;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                console.log(`Awaiting SiliconFlow response (${model})...`);
                const completion = await this.openai.chat.completions.create(pack);
                let res = completion.choices[0]?.message?.content || '';
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                return res;
            } catch (err) {
                const isRateLimit = err?.status === 429 || err?.message?.includes('rate limit') || err?.message?.includes('429');
                if (isRateLimit && attempt < maxRetries - 1) {
                    console.warn(`[SiliconFlow] Rate limit encountered, rotating key...`);
                    recordKeyFailure('SILICONFLOW_API_KEY', this.currentKey);
                    this._initClient();
                    continue;
                }
                if (err?.message?.includes('context_length') && turns.length > 1) {
                    console.log('[SiliconFlow] Context length exceeded, retrying with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
                }
                console.error('[SiliconFlow] Error:', err?.message || err);
                return 'My brain disconnected, try again.';
            }
        }
        return 'My brain disconnected, try again.';
    }

    async embed(text) {
        if (text.length > 4000) text = text.slice(0, 4000);
        const res = await this.openai.embeddings.create({
            model: 'BAAI/bge-m3',
            input: text
        });
        return res.data[0].embedding;
    }
}
