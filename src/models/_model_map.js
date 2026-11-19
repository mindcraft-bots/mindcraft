import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { hasKey } from '../utils/keys.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamically discover model classes in this directory.
// Each model class must export a static `prefix` string.
const apiMap = await (async () => {
    const map = {};
    const files = (await fs.readdir(__dirname))
        .filter(f => f.endsWith('.js') && f !== '_model_map.js' && f !== 'prompter.js');
    for (const file of files) {
        try {
            const moduleUrl = pathToFileURL(path.join(__dirname, file)).href;
            const mod = await import(moduleUrl);
            for (const exported of Object.values(mod)) {
                if (typeof exported === 'function' && Object.prototype.hasOwnProperty.call(exported, 'prefix')) {
                    const prefix = exported.prefix;
                    if (typeof prefix === 'string' && prefix.length > 0) {
                        map[prefix] = exported;
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to load model module:', file, e?.message || e);
        }
    }
    return map;
})();

export function selectAPI(profile) {
    if (!profile) {
        profile = {model: 'ollama/qwen2.5:0.5b'};
    }
    if (typeof profile === 'string' || profile instanceof String) {
        profile = {model: profile};
    }
    if (!profile.model) {
        profile.model = 'ollama/qwen2.5:0.5b';
    }
    // backwards compatibility with legacy local->ollama
    if (profile.api === 'local' || profile.model === 'local' || profile.model?.startsWith('local/')) {
        profile.api = 'ollama';
        if (profile.model) {
            profile.model = profile.model.replace(/^local\/?/, 'ollama/');
        }
    }
    // Tagged local models like qwen2.5:0.5b, llama3.2:1b default to Ollama
    if (!profile.api && profile.model?.includes(':') && !profile.model?.startsWith('http') && !profile.model?.includes('/')) {
        profile.api = 'ollama';
    }
    if (!profile.api) {
        // First check if model starts with any known prefix in apiMap
        const api = Object.keys(apiMap).find(key => profile.model?.startsWith(key + '/') || profile.model === key);
        if (api) {
            profile.api = api;
        }
        else {
            // check for some common models that do not require prefixes
            const m = (profile.model || '').toLowerCase();
            if (m.includes('gpt') || m.includes('o1') || m.includes('o3'))
                profile.api = 'openai';
            else if (m.includes('claude'))
                profile.api = 'anthropic';
            else if (m.includes('gemini'))
                profile.api = "google";
            else if (m.includes('grok'))
                profile.api = 'xai';
            else if (m.includes('mistral') || m.includes('codestral'))
                profile.api = 'mistral';
            else if (m.includes('deepseek'))
                profile.api = 'deepseek';
            else if (m.includes('qwen'))
                profile.api = 'qwen';
            else if (m.includes('cerebras'))
                profile.api = 'cerebras';
            else if (m.includes('groq'))
                profile.api = 'groq';
            else if (m.includes('sambanova'))
                profile.api = 'sambanova';
            else if (m.includes('together'))
                profile.api = 'together';
            else if (m.includes('fireworks'))
                profile.api = 'fireworks';
            else if (m.includes('deepinfra'))
                profile.api = 'deepinfra';
            else if (m.includes('perplexity') || m.includes('sonar'))
                profile.api = 'perplexity';
            else if (m.includes('cohere') || m.includes('command-r'))
                profile.api = 'cohere';
            else if (m.includes('siliconflow'))
                profile.api = 'siliconflow';
            else if (m.includes('minimax') || m.includes('hailuo'))
                profile.api = 'minimax';
            else if (m.includes('moonshot') || m.includes('kimi'))
                profile.api = 'moonshot';
            else if (m.includes('zhipu') || m.includes('glm'))
                profile.api = 'zhipu';
            else if (m.includes('baichuan'))
                profile.api = 'baichuan';
            else if (m.includes('yi-') || m.includes('01.ai'))
                profile.api = 'yi';
            else if (m.includes('stepfun') || m.includes('step-'))
                profile.api = 'stepfun';
            else if (m.includes('internlm'))
                profile.api = 'internlm';
            else if (m.includes('jamba') || m.includes('ai21'))
                profile.api = 'ai21';
            else if (m.includes('solar') || m.includes('upstage'))
                profile.api = 'upstage';
            else if (m.includes('palmyra') || m.includes('writer'))
                profile.api = 'writer';
            else if (m.includes('custom'))
                profile.api = 'custom';
            else if (m.includes('llama')) {
                if (hasKey('CEREBRAS_API_KEY')) profile.api = 'cerebras';
                else if (hasKey('TOGETHER_API_KEY')) profile.api = 'together';
                else if (hasKey('SAMBANOVA_API_KEY')) profile.api = 'sambanova';
                else profile.api = 'groq';
            } else if (profile.model?.includes('/')) {
                // If model has unknown prefix like "myprovider/model", check if prefix is in apiMap or fallback to custom
                const prefix = profile.model.split('/')[0];
                if (apiMap[prefix]) {
                    profile.api = prefix;
                } else {
                    profile.api = 'custom';
                }
            } else {
                profile.api = 'custom';
            }
        }
        if (!profile.api) {
            profile.api = 'custom';
        }
    }
    if (!apiMap[profile.api]) {
        profile.api = 'custom';
    }
    let model_name = profile.model.replace(profile.api + '/', ''); // remove prefix
    profile.model = model_name === "" ? null : model_name; // if model is empty, set to null
    return profile;
}

export function createModel(profile) {
    if (apiMap[profile.model]) {
        // if the model value is an api (instead of a specific model name)
        // then set model to null so it uses the default model for that api
        profile.model = null;
    }
    if (!apiMap[profile.api]) {
        throw new Error('Unknown api:', profile.api);
    }
    const model = new apiMap[profile.api](profile.model, profile.url, profile.params);
    return model;
}