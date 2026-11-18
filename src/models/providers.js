import OpenAIApi from 'openai';
import { getKey, hasKey, recordKeyFailure, getKeyCount } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

/**
 * Factory for OpenAI-compatible LLM providers.
 */
function createOpenAICompatibleClass(prefix, keyName, defaultUrl, defaultModel, displayName) {
    return class {
        static prefix = prefix;
        constructor(model_name, url, params) {
            this.model_name = model_name || defaultModel;
            this.params = params || {};
            this.url = url || defaultUrl;
            this.keyName = keyName;
            this.displayName = displayName || prefix;
            this._initClient();
        }

        _initClient() {
            let key = 'none';
            if (hasKey(this.keyName)) {
                key = getKey(this.keyName);
            } else if (hasKey(prefix)) {
                key = getKey(prefix);
            } else if (hasKey('CUSTOM_API_KEY')) {
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

            const maxRetries = getKeyCount(this.keyName) > 1 ? 2 : 1;
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    console.log(`Awaiting ${this.displayName} response (${this.model_name})...`);
                    const completion = await this.openai.chat.completions.create(pack);
                    let res = completion?.choices?.[0]?.message?.content || '';
                    res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                    return res;
                } catch (err) {
                    const isRateLimit = err?.status === 429 || err?.message?.includes('rate limit') || err?.message?.includes('429');
                    if (isRateLimit && attempt < maxRetries - 1) {
                        console.warn(`[${this.displayName}] Rate limit encountered, rotating key...`);
                        recordKeyFailure(this.keyName, this.currentKey);
                        this._initClient();
                        continue;
                    }
                    if (err?.message?.includes('context_length') && turns.length > 1) {
                        console.log(`[${this.displayName}] Context length exceeded, retrying with shorter context.`);
                        return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
                    }
                    console.error(`[${this.displayName}] Error:`, err?.message || err);
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
            try {
                const res = await this.openai.embeddings.create({
                    model: this.params?.embedding_model || 'text-embedding-3-small',
                    input: text
                });
                return res?.data?.[0]?.embedding || [];
            } catch {
                return [];
            }
        }
    };
}

export const MiniMax = createOpenAICompatibleClass('minimax', 'MINIMAX_API_KEY', 'https://api.minimaxi.chat/v1', 'MiniMax-Text-01', 'MiniMax');
export const Moonshot = createOpenAICompatibleClass('moonshot', 'MOONSHOT_API_KEY', 'https://api.moonshot.cn/v1', 'moonshot-v1-8k', 'Moonshot / Kimi');
export const Zhipu = createOpenAICompatibleClass('zhipu', 'ZHIPU_API_KEY', 'https://open.bigmodel.cn/api/paas/v4', 'glm-4-flash', 'Zhipu AI / GLM');
export const Baichuan = createOpenAICompatibleClass('baichuan', 'BAICHUAN_API_KEY', 'https://api.baichuan-ai.com/v1', 'Baichuan4', 'Baichuan');
export const Yi = createOpenAICompatibleClass('yi', 'YI_API_KEY', 'https://api.lingyiwanwu.com/v1', 'yi-lightning', '01.AI / Yi');
export const StepFun = createOpenAICompatibleClass('stepfun', 'STEPFUN_API_KEY', 'https://api.stepfun.com/v1', 'step-1-8k', 'StepFun');
export const InternLM = createOpenAICompatibleClass('internlm', 'INTERNLM_API_KEY', 'https://internlm-chat.intern-ai.org.cn/puyu/api/v1', 'internlm2.5-latest', 'InternLM');
export const AI21 = createOpenAICompatibleClass('ai21', 'AI21_API_KEY', 'https://api.ai21.com/studio/v1', 'jamba-1.5-mini', 'AI21 Labs');
export const Cloudflare = createOpenAICompatibleClass('cloudflare', 'CLOUDFLARE_API_KEY', 'https://api.cloudflare.com/client/v4/accounts/ai/v1', '@cf/meta/llama-3.3-70b-instruct', 'Cloudflare AI');
export const Anyscale = createOpenAICompatibleClass('anyscale', 'ANYSCALE_API_KEY', 'https://api.endpoints.anyscale.com/v1', 'meta-llama/Llama-3-70b-chat-hf', 'Anyscale');
export const OctoAI = createOpenAICompatibleClass('octoai', 'OCTOAI_API_KEY', 'https://text.octoai.run/v1', 'meta-llama-3-70b-instruct', 'OctoAI');
export const Lepton = createOpenAICompatibleClass('lepton', 'LEPTON_API_KEY', 'https://api.lepton.ai/v1', 'llama3-3-70b', 'Lepton AI');
export const Scaleway = createOpenAICompatibleClass('scaleway', 'SCALEWAY_API_KEY', 'https://api.scaleway.ai/v1', 'llama-3.3-70b-instruct', 'Scaleway');
export const MonsterAPI = createOpenAICompatibleClass('monsterapi', 'MONSTERAPI_API_KEY', 'https://api.monsterapi.ai/v1', 'meta-llama/Meta-Llama-3.1-70B-Instruct', 'MonsterAPI');
export const Nebius = createOpenAICompatibleClass('nebius', 'NEBIUS_API_KEY', 'https://api.studio.nebius.ai/v1', 'meta-llama/Meta-Llama-3.1-70B-Instruct', 'Nebius AI');
export const OVH = createOpenAICompatibleClass('ovh', 'OVH_API_KEY', 'https://endpoints.ai.cloud.ovh.net/v1', 'Meta-Llama-3-70B-Instruct', 'OVHcloud');
export const Upstage = createOpenAICompatibleClass('upstage', 'UPSTAGE_API_KEY', 'https://api.upstage.ai/v1/solar', 'solar-pro', 'Upstage Solar');
export const Friendli = createOpenAICompatibleClass('friendli', 'FRIENDLI_API_KEY', 'https://api.friendli.ai/serverless/v1', 'meta-llama-3.3-70b-instruct', 'FriendliAI');
export const Lambda = createOpenAICompatibleClass('lambda', 'LAMBDA_API_KEY', 'https://api.lambdalabs.com/v1', 'hermes-3-llama-3.1-405b', 'Lambda Labs');
export const Voyage = createOpenAICompatibleClass('voyage', 'VOYAGE_API_KEY', 'https://api.voyageai.com/v1', 'voyage-3', 'Voyage AI');
export const Writer = createOpenAICompatibleClass('writer', 'WRITER_API_KEY', 'https://api.writer.com/v1', 'palmyra-x-004', 'Writer');
export const Shuttle = createOpenAICompatibleClass('shuttle', 'SHUTTLE_API_KEY', 'https://api.shuttleai.com/v1', 'shuttle-3', 'ShuttleAI');
export const AIMLAPI = createOpenAICompatibleClass('aimlapi', 'AIMLAPI_API_KEY', 'https://api.aimlapi.com/v1', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'AI/ML API');
export const Infinence = createOpenAICompatibleClass('infinence', 'INFINENCE_API_KEY', 'https://api.infinence.ai/v1', 'llama-3.3-70b', 'Infinence');
export const Chutes = createOpenAICompatibleClass('chutes', 'CHUTES_API_KEY', 'https://chutes.ai/v1', 'deepseek-ai/DeepSeek-V3', 'Chutes AI');
export const Kluster = createOpenAICompatibleClass('kluster', 'KLUSTER_API_KEY', 'https://api.kluster.ai/v1', 'klusterai/Meta-Llama-3.1-70B-Instruct-Turbo', 'Kluster AI');
export const GLHF = createOpenAICompatibleClass('glhf', 'GLHF_API_KEY', 'https://glhf.chat/api/openai/v1', 'hf:meta-llama/Llama-3.3-70B-Instruct', 'GLHF');
export const LocalAI = createOpenAICompatibleClass('localai', 'LOCALAI_API_KEY', 'http://localhost:8080/v1', 'localai/default', 'LocalAI');
export const Jan = createOpenAICompatibleClass('jan', 'JAN_API_KEY', 'http://localhost:1337/v1', 'jan/default', 'Jan AI');
export const TextGen = createOpenAICompatibleClass('textgen', 'TEXTGEN_API_KEY', 'http://localhost:5000/v1', 'textgen/default', 'TextGen WebUI');
export const Kobold = createOpenAICompatibleClass('kobold', 'KOBOLD_API_KEY', 'http://localhost:5001/v1', 'kobold/default', 'KoboldCPP');
