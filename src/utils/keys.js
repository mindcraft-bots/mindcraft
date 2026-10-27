import { readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

let keys = {};
try {
    keys = readKeysConfig();
} catch (err) {
    console.warn('settings_llm_providers.json keys not found. Defaulting to environment variables.'); // still works with local models
}

export function getKey(name) {
    let key = keys[name];
    if (!key) {
        key = process.env[name];
    }
    if (!key && name === 'OPENAI_API_KEY') {
        key = getCodexGeneratedOpenAIKey();
    }
    if (!key) {
        throw new Error(`API key "${name}" not found in settings_llm_providers.json keys or environment variables!`);
    }
    return key;
}

export function hasKey(name) {
    return keys[name] || process.env[name] || (name === 'OPENAI_API_KEY' ? getCodexGeneratedOpenAIKey() : undefined);
}

function readKeysConfig() {
    const unifiedPath = process.env.MINDCRAFT_LLM_PROVIDERS_PATH || './settings_llm_providers.json';
    try {
        const unified = JSON.parse(readFileSync(unifiedPath, 'utf8'));
        if (unified?.keys && typeof unified.keys === 'object') {
            return unified.keys;
        }
    } catch {
        // Fall back to the legacy file below for older checkouts/tests.
    }
    const legacy = JSON.parse(readFileSync('./keys.json', 'utf8'));
    return legacy?.keys && typeof legacy.keys === 'object' ? legacy.keys : legacy;
}

function getCodexGeneratedOpenAIKey() {
    try {
        const authPath = path.join(homedir(), '.codex', 'auth.json');
        const auth = JSON.parse(readFileSync(authPath, 'utf8'));
        return typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0
            ? auth.OPENAI_API_KEY
            : undefined;
    } catch {
        return undefined;
    }
}
