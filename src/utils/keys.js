import { readFileSync, existsSync } from 'fs';

// Aliases mapping canonical name <-> alternative names
const KEY_ALIASES = {
    'OPENAI_API_KEY': ['OPENAI_KEY', 'OPENAI_TOKEN', 'openai', 'gpt'],
    'GEMINI_API_KEY': ['GOOGLE_API_KEY', 'GEMINI_KEY', 'GOOGLE_KEY', 'google', 'gemini'],
    'ANTHROPIC_API_KEY': ['CLAUDE_API_KEY', 'ANTHROPIC_KEY', 'CLAUDE_KEY', 'anthropic', 'claude'],
    'GROQCLOUD_API_KEY': ['GROQ_API_KEY', 'GROQ_KEY', 'GROQCLOUD_KEY', 'groq', 'groqcloud'],
    'CEREBRAS_API_KEY': ['CEREBRAS_KEY', 'cerebras'],
    'SAMBANOVA_API_KEY': ['SAMBANOVA_KEY', 'SAMBA_API_KEY', 'SAMBA_KEY', 'sambanova', 'samba'],
    'TOGETHER_API_KEY': ['TOGETHERAI_API_KEY', 'TOGETHER_KEY', 'together', 'togetherai'],
    'FIREWORKS_API_KEY': ['FIREWORKS_KEY', 'FIREWORKS_AI_API_KEY', 'fireworks'],
    'DEEPSEEK_API_KEY': ['DEEPSEEK_KEY', 'deepseek'],
    'DEEPINFRA_API_KEY': ['DEEPINFRA_KEY', 'DEEP_INFRA_API_KEY', 'deepinfra'],
    'PERPLEXITY_API_KEY': ['PERPLEXITY_KEY', 'PPLX_API_KEY', 'perplexity', 'pplx'],
    'COHERE_API_KEY': ['COHERE_KEY', 'cohere'],
    'SILICONFLOW_API_KEY': ['SILICONFLOW_KEY', 'SILICON_FLOW_KEY', 'siliconflow'],
    'XAI_API_KEY': ['GROK_API_KEY', 'XAI_KEY', 'GROK_KEY', 'xai', 'grok'],
    'QWEN_API_KEY': ['DASHSCOPE_API_KEY', 'QWEN_KEY', 'ALIYUN_API_KEY', 'qwen'],
    'MISTRAL_API_KEY': ['MISTRAL_KEY', 'CODESTRAL_API_KEY', 'CODESTRAL_KEY', 'mistral'],
    'OPENROUTER_API_KEY': ['OPENROUTER_KEY', 'openrouter'],
    'HYPERBOLIC_API_KEY': ['HYPERBOLIC_KEY', 'hyperbolic'],
    'NOVITA_API_KEY': ['NOVITA_KEY', 'novita'],
    'HUGGINGFACE_API_KEY': ['HUGGINGFACE_KEY', 'HF_API_KEY', 'HF_TOKEN', 'huggingface'],
    'REPLICATE_API_KEY': ['REPLICATE_KEY', 'REPLICATE_API_TOKEN', 'replicate'],
    'MERCURY_API_KEY': ['MERCURY_KEY', 'mercury'],
    'AZURE_OPENAI_API_KEY': ['AZURE_API_KEY', 'azure'],
    'CUSTOM_API_KEY': ['CUSTOM_KEY', 'custom'],
};

// Map alternative names back to canonical names
const ALIAS_LOOKUP = {};
for (const [canonical, aliases] of Object.entries(KEY_ALIASES)) {
    ALIAS_LOOKUP[canonical] = canonical;
    ALIAS_LOOKUP[canonical.toLowerCase()] = canonical;
    ALIAS_LOOKUP[canonical.toUpperCase()] = canonical;
    for (const alias of aliases) {
        ALIAS_LOOKUP[alias] = canonical;
        ALIAS_LOOKUP[alias.toLowerCase()] = canonical;
        ALIAS_LOOKUP[alias.toUpperCase()] = canonical;
    }
}

// Key pool storage: canonicalName -> { keys: string[], index: number, cooldowns: Map<string, number> }
const keyPools = new Map();
let rawKeys = {};

// Helper to parse .env file if present
function parseEnvFile() {
    const envVars = {};
    if (existsSync('./.env')) {
        try {
            const lines = readFileSync('./.env', 'utf8').split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx !== -1) {
                    const key = trimmed.slice(0, eqIdx).trim();
                    let val = trimmed.slice(eqIdx + 1).trim();
                    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                        val = val.slice(1, -1);
                    }
                    envVars[key] = val;
                }
            }
        } catch {
            // ignore
        }
    }
    return envVars;
}

export function reloadKeys() {
    rawKeys = {};
    try {
        if (existsSync('./keys.json')) {
            const data = readFileSync('./keys.json', 'utf8');
            rawKeys = JSON.parse(data);
        }
    } catch (err) {
        console.warn('keys.json could not be loaded, defaulting to environment variables:', err.message);
    }

    // Also load from config.json if keys or api_key are present
    try {
        if (existsSync('./config.json')) {
            const configJson = JSON.parse(readFileSync('./config.json', 'utf8'));
            for (const [k, v] of Object.entries(configJson)) {
                if (!v) continue;
                if (k === 'api_key' || k === 'apiKey') {
                    const keyName = configJson.api_key_name || (configJson.provider ? getCanonicalName(configJson.provider) : null);
                    if (keyName) {
                        const canonical = getCanonicalName(keyName);
                        rawKeys[canonical] = v;
                    }
                } else if (k === 'custom_api_url' || k === 'CUSTOM_API_URL') {
                    rawKeys['CUSTOM_API_URL'] = v;
                } else if (k.endsWith('_KEY') || k.endsWith('_TOKEN') || k.endsWith('_URL') || ALIAS_LOOKUP[k]) {
                    const canonical = getCanonicalName(k);
                    rawKeys[canonical] = v;
                }
            }
        }
    } catch {
        // ignore
    }

    const envFileVars = parseEnvFile();
    const allEnv = { ...envFileVars, ...process.env };

    // Reset key pools
    keyPools.clear();

    // Helper to add keys to a pool
    function addKeysToPool(canonicalName, value) {
        if (!value) return;
        if (!keyPools.has(canonicalName)) {
            keyPools.set(canonicalName, { keys: [], index: 0, cooldowns: new Map() });
        }
        const pool = keyPools.get(canonicalName);

        if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === 'string' && item.trim().length > 0 && !pool.keys.includes(item.trim())) {
                    pool.keys.push(item.trim());
                }
            }
        } else if (typeof value === 'string') {
            const split = value.split(',').map(s => s.trim()).filter(s => s.length > 0);
            for (const k of split) {
                if (!pool.keys.includes(k)) {
                    pool.keys.push(k);
                }
            }
        }
    }

    // Load from rawKeys (keys.json & config.json)
    for (const [k, v] of Object.entries(rawKeys)) {
        const canonical = getCanonicalName(k);
        addKeysToPool(canonical, v);
    }

    // Load from env variables (including numbered ones like GROQ_API_KEY_1, GROQ_API_KEY_2)
    for (const [k, v] of Object.entries(allEnv)) {
        if (!v || typeof v !== 'string') continue;
        const baseKey = k.replace(/_\d+$/, '');
        const canonical = ALIAS_LOOKUP[baseKey] || ALIAS_LOOKUP[k] || (KEY_ALIASES[k] ? k : null);
        if (canonical) {
            addKeysToPool(canonical, v);
        } else if (k.endsWith('_KEY') || k.endsWith('_TOKEN') || k.endsWith('_ID') || k.endsWith('_URL')) {
            addKeysToPool(k, v);
        }
    }
}

// Initial load
reloadKeys();

export function getCanonicalName(name) {
    if (!name || typeof name !== 'string') return name;
    return ALIAS_LOOKUP[name] || ALIAS_LOOKUP[name.toLowerCase()] || ALIAS_LOOKUP[name.toUpperCase()] || name;
}

export function getAliases(name) {
    const canonical = getCanonicalName(name);
    const aliases = KEY_ALIASES[canonical] || [];
    return [canonical, ...aliases];
}

export function hasKey(name) {
    const canonical = getCanonicalName(name);
    const pool = keyPools.get(canonical);
    if (pool && pool.keys.length > 0) return true;
    for (const alias of getAliases(name)) {
        if (rawKeys[alias] || process.env[alias]) return true;
    }
    return false;
}

export function getKey(name) {
    const canonical = getCanonicalName(name);
    let pool = keyPools.get(canonical);

    // If pool is empty or doesn't have keys, check if newly defined in process.env or rawKeys
    if (!pool || pool.keys.length === 0) {
        for (const alias of getAliases(name)) {
            const val = process.env[alias] || rawKeys[alias];
            if (val) {
                if (!pool) {
                    keyPools.set(canonical, { keys: [], index: 0, cooldowns: new Map() });
                    pool = keyPools.get(canonical);
                }
                if (Array.isArray(val)) {
                    for (const item of val) {
                        if (typeof item === 'string' && item.trim()) pool.keys.push(item.trim());
                    }
                } else if (typeof val === 'string') {
                    for (const item of val.split(',').map(s => s.trim()).filter(Boolean)) {
                        if (!pool.keys.includes(item)) pool.keys.push(item);
                    }
                }
                break;
            }
        }
    }

    if (pool && pool.keys.length > 0) {
        const now = Date.now();
        // Find first non-cooldown key or pick least recently cooled down
        for (let i = 0; i < pool.keys.length; i++) {
            const idx = (pool.index + i) % pool.keys.length;
            const candidate = pool.keys[idx];
            const cooldownUntil = pool.cooldowns.get(candidate) || 0;
            if (now >= cooldownUntil) {
                pool.index = idx;
                return candidate;
            }
        }
        // If all are on cooldown, return current key anyway
        return pool.keys[pool.index % pool.keys.length];
    }

    // Direct fallback check
    for (const alias of getAliases(name)) {
        let direct = rawKeys[alias] || process.env[alias];
        if (direct && typeof direct === 'string') {
            const first = direct.split(',')[0].trim();
            if (first) return first;
        }
    }

    throw new Error(`API key "${name}" not found in keys.json, .env, or environment variables!`);
}

export function rotateKey(name) {
    const canonical = getCanonicalName(name);
    const pool = keyPools.get(canonical);
    if (!pool || pool.keys.length <= 1) {
        return getKey(name);
    }
    pool.index = (pool.index + 1) % pool.keys.length;
    console.log(`[KeyManager] Rotated ${canonical} to key #${pool.index + 1} of ${pool.keys.length}`);
    return pool.keys[pool.index];
}

export function recordKeyFailure(name, failedKey, cooldownMs = 60000) {
    const canonical = getCanonicalName(name);
    const pool = keyPools.get(canonical);
    if (!pool) return;
    if (failedKey) {
        pool.cooldowns.set(failedKey, Date.now() + cooldownMs);
    }
    if (pool.keys.length > 1) {
        rotateKey(canonical);
    }
}

export function getAllKeys(name) {
    const canonical = getCanonicalName(name);
    const pool = keyPools.get(canonical);
    return pool ? [...pool.keys] : [];
}

export function getKeyCount(name) {
    const canonical = getCanonicalName(name);
    const pool = keyPools.get(canonical);
    return pool ? pool.keys.length : 0;
}

export function getAvailableProviders() {
    const available = [];
    for (const [canonical, pool] of keyPools.entries()) {
        if (pool.keys.length > 0) {
            available.push({
                provider: canonical,
                keyCount: pool.keys.length
            });
        }
    }
    return available;
}

