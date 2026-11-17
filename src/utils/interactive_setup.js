import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { reloadKeys, hasKey } from './keys.js';

export const PROVIDERS = [
    {
        name: 'GroqCloud',
        desc: 'Ultra-fast inference with free tier (Recommended)',
        keyName: 'GROQCLOUD_API_KEY',
        defaultModel: 'groq/llama-3.3-70b-versatile'
    },
    {
        name: 'Cerebras',
        desc: "World's fastest inference (1000+ tokens/sec)",
        keyName: 'CEREBRAS_API_KEY',
        defaultModel: 'cerebras/llama-3.3-70b'
    },
    {
        name: 'SambaNova',
        desc: 'Ultra-fast SN40L hardware inference',
        keyName: 'SAMBANOVA_API_KEY',
        defaultModel: 'sambanova/Meta-Llama-3.3-70B-Instruct'
    },
    {
        name: 'Together AI',
        desc: 'Fast open-source models (Llama-3.3 Turbo)',
        keyName: 'TOGETHER_API_KEY',
        defaultModel: 'together/meta-llama/Llama-3.3-70B-Instruct-Turbo'
    },
    {
        name: 'DeepSeek',
        desc: 'DeepSeek-V3 and DeepSeek-R1',
        keyName: 'DEEPSEEK_API_KEY',
        defaultModel: 'deepseek/deepseek-chat'
    },
    {
        name: 'OpenAI',
        desc: 'GPT-4o, GPT-4o-mini',
        keyName: 'OPENAI_API_KEY',
        defaultModel: 'openai/gpt-4o-mini'
    },
    {
        name: 'Google Gemini',
        desc: 'Gemini 2.0 Flash / Pro',
        keyName: 'GEMINI_API_KEY',
        defaultModel: 'google/gemini-2.0-flash'
    },
    {
        name: 'Anthropic Claude',
        desc: 'Claude 3.5 Sonnet / Haiku',
        keyName: 'ANTHROPIC_API_KEY',
        defaultModel: 'anthropic/claude-3-5-sonnet-latest'
    },
    {
        name: 'Fireworks AI',
        desc: 'Low-latency open models & vision',
        keyName: 'FIREWORKS_API_KEY',
        defaultModel: 'fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct'
    },
    {
        name: 'DeepInfra',
        desc: 'Low-cost fast inference',
        keyName: 'DEEPINFRA_API_KEY',
        defaultModel: 'deepinfra/meta-llama/Llama-3.3-70B-Instruct'
    },
    {
        name: 'Perplexity',
        desc: 'Sonar search-augmented models',
        keyName: 'PERPLEXITY_API_KEY',
        defaultModel: 'perplexity/sonar-pro'
    },
    {
        name: 'Custom Endpoint',
        desc: 'Any OpenAI-compatible server (vLLM, Ollama, LMStudio)',
        keyName: 'CUSTOM_API_KEY',
        defaultModel: 'custom/default'
    }
];

export async function runInteractiveSetup(force = false) {
    if (!force && !process.stdin.isTTY) {
        console.log('[Setup] Non-interactive environment detected, skipping terminal setup.');
        return false;
    }

    const rl = readline.createInterface({ input, output });

    console.log('\n===================================================================');
    console.log('            🤖 Doombots Terminal Setup & Configuration 🤖          ');
    console.log('===================================================================');
    console.log('Please answer the questions below to set up your bot.');
    console.log('Press Enter to accept the [default value] shown in brackets.\n');

    try {
        // 1. Choose Provider
        console.log('Select your AI model provider:');
        PROVIDERS.forEach((p, idx) => {
            console.log(`  [${idx + 1}] ${p.name.padEnd(18)} - ${p.desc}`);
        });

        let providerIdx = -1;
        while (providerIdx < 0 || providerIdx >= PROVIDERS.length) {
            const answer = await rl.question(`\nSelect provider [1-${PROVIDERS.length}] [1]: `);
            const trimmed = answer.trim();
            if (!trimmed) {
                providerIdx = 0;
            } else {
                const parsed = parseInt(trimmed, 10);
                if (!isNaN(parsed) && parsed >= 1 && parsed <= PROVIDERS.length) {
                    providerIdx = parsed - 1;
                } else {
                    console.log(`Please enter a number between 1 and ${PROVIDERS.length}.`);
                }
            }
        }

        const selectedProvider = PROVIDERS[providerIdx];
        console.log(`-> Selected: ${selectedProvider.name} (${selectedProvider.keyName})`);

        // If custom endpoint, ask for URL
        let customUrl = '';
        if (selectedProvider.keyName === 'CUSTOM_API_KEY') {
            const urlAns = await rl.question('Enter custom API Base URL [http://localhost:8000/v1]: ');
            customUrl = urlAns.trim() || 'http://localhost:8000/v1';
        }

        // 2. Ask for API Key(s)
        let apiKey = '';
        const existingKey = (hasKey(selectedProvider.keyName) ? getKey(selectedProvider.keyName) : null) 
            || (hasKey(selectedProvider.name) ? getKey(selectedProvider.name) : null);
        while (!apiKey) {
            const prompt = existingKey
                ? `Enter your ${selectedProvider.name} API Key [press Enter to keep existing key]: `
                : `Enter your ${selectedProvider.name} API Key (or comma-separated keys): `;
            const keyAns = await rl.question(prompt);
            apiKey = keyAns.trim();
            if (!apiKey && existingKey) {
                apiKey = existingKey;
                console.log(`-> Keeping existing key for ${selectedProvider.keyName}.`);
                break;
            }
            if (!apiKey) {
                console.log('API key cannot be empty. Please enter a valid API key.');
            }
        }

        // 3. Ask for Bot Name
        const botNameAns = await rl.question('Enter Bot Name in Minecraft [andy]: ');
        const botName = botNameAns.trim() || 'andy';

        // 4. Server Host
        const hostAns = await rl.question('Minecraft Server Host [127.0.0.1]: ');
        let rawHost = hostAns.trim() || '127.0.0.1';
        let host = rawHost;
        let detectedPort = null;
        if (rawHost.includes(':') && !rawHost.startsWith('http')) {
            const parts = rawHost.split(':');
            host = parts[0];
            const parsed = parseInt(parts[1], 10);
            if (!isNaN(parsed)) detectedPort = parsed;
        }

        // 5. Server Port
        const isLan = host === '127.0.0.1' || host === 'localhost';
        const defaultPort = detectedPort || (isLan ? 55916 : 25565);
        const portAns = await rl.question(`Minecraft Server Port (or -1 for auto-scan) [${defaultPort}]: `);
        const portParsed = parseInt(portAns.trim() || String(defaultPort), 10);
        const port = isNaN(portParsed) ? defaultPort : portParsed;

        // 6. Minecraft Version
        const versionAns = await rl.question('Minecraft Version [auto]: ');
        let mcVersion = versionAns.trim() || 'auto';
        if (mcVersion === '1.21.11' || mcVersion === '1.21.10') {
            console.log(`  -> Note: ${mcVersion} is a Bedrock/Geyser version.`);
            console.log(`  -> Connecting with Java 1.21.4 (compatible with ViaVersion / ViaBackwards / Geyser).`);
            mcVersion = '1.21.4';
        }

        // 7. Auth Mode
        const authAns = await rl.question('Account Auth Mode [1: offline/cracked, 2: microsoft] [1]: ');
        const auth = authAns.trim() === '2' || authAns.trim().toLowerCase() === 'microsoft' ? 'microsoft' : 'offline';

        // 8. Fast & Low Memory Mode
        const fastLowAns = await rl.question('Enable Fast & Low-Memory Mode (Linux 4GB / Termux optimized)? [Y/n] [Y]: ');
        const isFastLow = fastLowAns.trim().toLowerCase() !== 'n';

        console.log('\nSaving configuration...');

        // Save to keys.json
        let keysData = {};
        if (existsSync('./keys.json')) {
            try {
                keysData = JSON.parse(readFileSync('./keys.json', 'utf8'));
            } catch {}
        } else if (existsSync('./keys.example.json')) {
            try {
                keysData = JSON.parse(readFileSync('./keys.example.json', 'utf8'));
            } catch {}
        }

        if (apiKey) {
            if (apiKey.includes(',')) {
                keysData[selectedProvider.keyName] = apiKey.split(',').map(k => k.trim()).filter(Boolean);
            } else {
                keysData[selectedProvider.keyName] = apiKey;
            }
        }
        if (customUrl) {
            keysData['CUSTOM_API_URL'] = customUrl;
        }

        writeFileSync('./keys.json', JSON.stringify(keysData, null, 4), 'utf8');

        // Save to config.json
        let existingConfig = {};
        if (existsSync('./config.json')) {
            try {
                existingConfig = JSON.parse(readFileSync('./config.json', 'utf8'));
            } catch {}
        }

        const configData = {
            ...existingConfig,
            host,
            port,
            minecraft_version: mcVersion,
            auth,
            provider: selectedProvider.name,
            model: selectedProvider.defaultModel,
            api_key: apiKey,
            api_key_name: selectedProvider.keyName,
            [selectedProvider.keyName]: apiKey,
            fast_mode: isFastLow,
            low_memory_mode: isFastLow,
            max_messages: isFastLow ? 10 : 15
        };
        if (customUrl) {
            configData.custom_api_url = customUrl;
            configData.CUSTOM_API_URL = customUrl;
        }
        writeFileSync('./config.json', JSON.stringify(configData, null, 4), 'utf8');

        // Reload keys from both files
        reloadKeys();

        // Save to andy.json (or bot profile)
        const profileData = {
            name: botName,
            model: selectedProvider.defaultModel,
            cooldown: isFastLow ? 0 : 3000,
            fast_mode: isFastLow,
            low_memory_mode: isFastLow,
            max_messages: isFastLow ? 10 : 15,
            max_tokens: isFastLow ? 1024 : 2048,
            params: {
                temperature: 0.2,
                max_completion_tokens: isFastLow ? 1024 : 2048
            }
        };
        writeFileSync('./andy.json', JSON.stringify(profileData, null, 4), 'utf8');

        console.log('\n===================================================================');
        console.log('✅ Configuration saved successfully!');
        console.log('   - API Keys saved to:       ./keys.json');
        console.log('   - Server config saved to: ./config.json');
        console.log('   - Agent profile saved to: ./andy.json');
        console.log('===================================================================\n');

        return true;
    } finally {
        rl.close();
    }
}
