import { strictFormat } from '../utils/text.js';

export class Ollama {
    static prefix = 'ollama';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = (url || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
        this.chat_endpoint = '/api/chat';
        this.embedding_endpoint = '/api/embeddings';
    }

    async sendRequest(turns, systemMessage) {
        let model = this.model_name || 'qwen2.5:0.5b';
        let messages = strictFormat(turns);
        messages.unshift({ role: 'system', content: systemMessage });
        const maxAttempts = 3;
        let attempt = 0;
        let finalRes = null;

        // Tune generation parameters for low-latency on CPU/Termux
        const options = {
            num_predict: 256,
            temperature: 0.2,
            top_p: 0.9,
            num_ctx: 2048,
            ...(this.params?.options || {})
        };

        while (attempt < maxAttempts) {
            attempt++;
            console.log(`[Ollama] Awaiting local response (${model}, attempt: ${attempt})...`);
            let res = null;
            try {
                let apiResponse = await this.send(this.chat_endpoint, {
                    model: model,
                    messages: messages,
                    stream: false,
                    options: options,
                    ...(this.params || {})
                });
                if (apiResponse && apiResponse.message) {
                    res = apiResponse.message.content;
                } else {
                    res = 'No response data.';
                }
            } catch (err) {
                if (err?.message && err.message.toLowerCase().includes('context length') && turns.length > 1) {
                    console.log('[Ollama] Context length exceeded, retrying with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage);
                } else {
                    console.error('[Ollama] Request error:', err?.message || err);
                    res = 'My brain disconnected, try again.';
                }
            }

            if (typeof res !== 'string') {
                res = String(res || '');
            }

            const hasOpenTag = res.includes("<think>");
            const hasCloseTag = res.includes("</think>");

            if ((hasOpenTag && !hasCloseTag)) {
                console.warn("[Ollama] Partial <think> block detected. Re-generating...");
                if (attempt < maxAttempts) continue;
            }
            if (hasCloseTag && !hasOpenTag) {
                res = '<think>' + res;
            }
            if (hasOpenTag && hasCloseTag) {
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }
            finalRes = res;
            break;
        }

        if (finalRes == null) {
            console.warn("Could not get a valid response after max attempts.");
            finalRes = 'I thought too hard, sorry, try again.';
        }
        return finalRes;
    }

    async embed(text) {
        let model = this.model_name || 'embeddinggemma';
        let body = { model: model, input: text };
        try {
            let res = await this.send(this.embedding_endpoint, body);
            if (res && res['embedding']) return res['embedding'];
            let res2 = await this.send('/api/embed', body);
            if (res2 && res2['embeddings'] && res2['embeddings'][0]) return res2['embeddings'][0];
        } catch {
            // fallback handled by skill library
        }
        return null;
    }

    async send(endpoint, body) {
        const url = new URL(endpoint, this.url);
        let method = 'POST';
        let headers = new Headers();
        const request = new Request(url, { method, headers, body: JSON.stringify(body) });
        let data = null;
        try {
            const res = await fetch(request);
            if (res.ok) {
                data = await res.json();
            } else {
                throw new Error(`Ollama Status: ${res.status}`);
            }
        } catch (err) {
            if (!endpoint.includes('embed')) {
                console.error(`Failed to send Ollama request (${endpoint}):`, err.message || err);
            }
        }
        return data;
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
}
