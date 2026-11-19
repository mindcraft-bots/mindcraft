import { strictFormat } from '../utils/text.js';

export class Ollama {
    static prefix = 'ollama';
    constructor(model_name, url, params) {
        this.model_name = model_name || 'qwen2.5:0.5b';
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
            num_predict: 64,
            temperature: 0.1,
            top_p: 0.9,
            num_ctx: 4096,
            num_thread: 2,
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
                    if (attempt < maxAttempts) {
                        console.warn(`[Ollama] Attempt ${attempt} failed to reach server, retrying in 2s...`);
                        await new Promise(r => setTimeout(r, 2000));
                        continue;
                    }
                    res = 'I could not connect to my brain. Make sure Ollama is running in the background with ollama serve.';
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
        // Chat models like qwen2.5:0.5b should not be forced into slow embedding generation on CPU
        if (!this.model_name || this.model_name.includes('qwen') || this.model_name.includes('llama') || this.model_name.includes('mistral')) {
            return null;
        }
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
        let candidateUrls = [this.url];
        if (this.url.includes('127.0.0.1')) {
            candidateUrls.push(this.url.replace('127.0.0.1', 'localhost'));
        } else if (this.url.includes('localhost')) {
            candidateUrls.push(this.url.replace('localhost', '127.0.0.1'));
        }

        let data = null;
        let lastError = null;

        for (const baseUrl of candidateUrls) {
            try {
                const url = new URL(endpoint, baseUrl);
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (res.ok) {
                    data = await res.json();
                    this.url = baseUrl;
                    return data;
                } else {
                    throw new Error(`Ollama HTTP ${res.status}: ${res.statusText}`);
                }
            } catch (err) {
                lastError = err;
            }
        }

        if (!endpoint.includes('embed')) {
            const cause = lastError?.cause?.code || lastError?.cause?.message || '';
            const msg = lastError?.message || String(lastError);
            console.error(`[Ollama] Connection error on ${endpoint}: ${msg} ${cause ? `(${cause})` : ''}`);
            if (cause === 'ECONNREFUSED' || msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
                console.error(`[Ollama] 💡 Ensure Ollama is running in the background: type 'ollama serve' in your terminal.`);
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
