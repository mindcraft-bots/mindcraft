import { existsSync, readFileSync, promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamically discover model classes in this directory.
// Each model class must export a static `prefix` string.
const providerRegistry = loadRegistry(
    process.env.MINDCRAFT_LLM_PROVIDERS_PATH,
    process.env.MINDCRAFT_MODEL_PROVIDERS_PATH,
    'model_providers.json',
    'model provider',
    'models'
);
const embeddingProviderRegistry = loadRegistry(
    process.env.MINDCRAFT_LLM_PROVIDERS_PATH,
    process.env.MINDCRAFT_EMBEDDING_PROVIDERS_PATH,
    'embedding_providers.json',
    'embedding provider',
    'embeddings'
);

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


function loadRegistry(unifiedPathOverride, registryPathOverride, filename, label, section) {
    const unifiedPath = unifiedPathOverride || path.join(process.cwd(), 'settings_llm_providers.json');
    if (existsSync(unifiedPath)) {
        try {
            const unified = JSON.parse(readFileSync(unifiedPath, 'utf8'));
            if (unified?.[section] && typeof unified[section] === 'object') {
                return unified[section];
            }
            throw new Error(`missing "${section}" section`);
        } catch (error) {
            throw new Error(`Failed to read unified LLM provider registry ${unifiedPath}: ${error.message}`);
        }
    }

    const registryPath = registryPathOverride || path.join(process.cwd(), filename);
    if (!existsSync(registryPath)) {
        return {};
    }
    try {
        return JSON.parse(readFileSync(registryPath, 'utf8'));
    } catch (error) {
        throw new Error(`Failed to read ${label} registry ${registryPath}: ${error.message}`);
    }
}

function applyProviderRegistry(profile, registry, label) {
    const providerName = profile.provider;
    if (!providerName) {
        return profile;
    }
    const providerConfig = registry[providerName];
    if (!providerConfig) {
        throw new Error(`Unknown ${label}: ${providerName}`);
    }
    const provider = normalizeProviderConfig(providerName, providerConfig);
    const mergedParams = {
        ...(provider.params || {}),
        ...(profile.params || {})
    };
    for (const [key, value] of Object.entries(mergedParams)) {
        if ((value === null || value === undefined) && key !== 'apiKeyName' && key !== 'api_key_name') {
            delete mergedParams[key];
        }
    }
    return {
        ...provider,
        ...profile,
        api: profile.api || provider.api,
        model: profile.model || provider.model,
        url: profile.url || profile.baseUrl || profile.base_url || provider.url,
        params: mergedParams
    };
}

function normalizeProviderConfig(providerName, provider) {
    const keyName = firstDefined(provider.keyName, provider.key_name, provider.apiKeyName, provider.api_key_name);
    const baseUrl = provider.baseUrl || provider.base_url || provider.baseURL || provider.url;
    const format = provider.format || provider.apiFormat || provider.api_format || provider.protocol || provider.api;
    const api = provider.adapter || provider.api || apiFromFormat(format);
    return {
        ...provider,
        api,
        model: provider.model || provider.defaultModel || provider.default_model,
        url: baseUrl,
        params: {
            ...(keyName !== undefined ? { apiKeyName: keyName } : {}),
            ...(api === 'openai-completions' || api === 'openai-compatible' ? { provider: providerName } : {}),
            ...(api === 'anthropic-messages' ? { provider: providerName } : {}),
            ...(api === 'replicate' ? { provider: providerName } : {}),
            ...(provider.params || {}),
            ...(provider.providerName ? { provider: provider.providerName } : {}),
            ...(provider.provider_name ? { provider: provider.provider_name } : {})
        }
    };
}

function firstDefined(...values) {
    return values.find(value => value !== undefined);
}

function apiFromFormat(format) {
    const normalized = String(format || '').toLowerCase();
    const aliases = {
        // Canonical protocol names used by settings_llm_providers.json.
        'openai-completions': 'openai-completions',
        'openai-responses': 'openai-responses',
        'anthropic-messages': 'anthropic-messages',
        'google-generative-ai': 'google-generative-ai',
        'azure-openai-responses': 'azure-openai-responses',
        'openai-codex-responses': 'codex',
        'openai-embeddings': 'openai-completions',
        replicate: 'replicate',
        // Minimal backward-compatible names still covered by tests or old profiles.
        'openai-compatible': 'openai-compatible',
        'openai-chat-completions': 'openai-completions',
        openai: 'openai-completions',
        anthropic: 'anthropic-messages',
        claude: 'anthropic-messages',
        google: 'google-generative-ai',
        gemini: 'google-generative-ai',
        azure: 'azure-openai-responses',
        codex: 'codex'
    };
    return aliases[normalized] || format;
}

export function selectAPI(profile) {
    if (typeof profile === 'string' || profile instanceof String) {
        profile = {model: profile};
    }
    profile = applyProviderRegistry(profile, providerRegistry, 'model provider');
    return resolveAPI(profile);
}

export function selectEmbeddingAPI(profile) {
    if (typeof profile === 'string' || profile instanceof String) {
        profile = embeddingProviderRegistry[profile] ? {provider: profile} : {model: profile};
    }
    profile = applyProviderRegistry(profile, embeddingProviderRegistry, 'embedding provider');
    return resolveAPI(profile);
}

function resolveAPI(profile) {
    if (profile.api) {
        profile.api = apiFromFormat(profile.api);
    }
    if (!profile.api) {
        const api = Object.keys(apiMap).find(key => profile.model?.startsWith(`${key}/`) || profile.model === key);
        if (api) {
            profile.api = api;
        } else {
            throw new Error(`Unknown model provider or api for model: ${profile.model}`);
        }
    }
    if (!apiMap[profile.api]) {
        throw new Error('Unknown api:', profile.api);
    }
    const model_name = profile.model?.replace(`${profile.api}/`, ''); // remove explicit api prefix
    profile.model = model_name === '' ? null : model_name; // if model is empty, set to null
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
