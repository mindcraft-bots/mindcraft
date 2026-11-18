import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { reloadKeys, hasKey, getKey } from './keys.js';

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
        name: 'xAI Grok',
        desc: 'Grok-2, Grok-beta',
        keyName: 'XAI_API_KEY',
        defaultModel: 'xai/grok-2-latest'
    },
    {
        name: 'Mistral AI',
        desc: 'Mistral Large, Codestral, Pixtral',
        keyName: 'MISTRAL_API_KEY',
        defaultModel: 'mistral/mistral-large-latest'
    },
    {
        name: 'Fireworks AI',
        desc: 'Low-latency open models & vision',
        keyName: 'FIREWORKS_API_KEY',
        defaultModel: 'fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct'
    },
    {
        name: 'DeepInfra',
        desc: 'Low-cost fast open models',
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
        name: 'Cohere',
        desc: 'Command R+, Command R',
        keyName: 'COHERE_API_KEY',
        defaultModel: 'cohere/command-r-plus'
    },
    {
        name: 'Alibaba Qwen',
        desc: 'Qwen 2.5 72B, Qwen Max',
        keyName: 'QWEN_API_KEY',
        defaultModel: 'qwen/qwen-turbo'
    },
    {
        name: 'SiliconFlow',
        desc: 'Fast SiliconCloud DeepSeek & Qwen',
        keyName: 'SILICONFLOW_API_KEY',
        defaultModel: 'siliconflow/deepseek-ai/DeepSeek-V3'
    },
    {
        name: 'OpenRouter',
        desc: 'Aggregated 200+ multi-provider models',
        keyName: 'OPENROUTER_API_KEY',
        defaultModel: 'openrouter/meta-llama/llama-3.3-70b-instruct'
    },
    {
        name: 'Hyperbolic',
        desc: 'Decentralized fast GPU inference',
        keyName: 'HYPERBOLIC_API_KEY',
        defaultModel: 'hyperbolic/meta-llama/Llama-3.3-70B-Instruct'
    },
    {
        name: 'Novita AI',
        desc: 'High-speed cloud LLMs and vision',
        keyName: 'NOVITA_API_KEY',
        defaultModel: 'novita/meta-llama/llama-3.3-70b-instruct'
    },
    {
        name: 'Hugging Face',
        desc: 'Hugging Face Inference Endpoints',
        keyName: 'HUGGINGFACE_API_KEY',
        defaultModel: 'huggingface/meta-llama/Llama-3.2-3B-Instruct'
    },
    {
        name: 'Replicate',
        desc: 'Cloud model deployments & fine-tunes',
        keyName: 'REPLICATE_API_KEY',
        defaultModel: 'replicate/meta/meta-llama-3-70b-instruct'
    },
    {
        name: 'Inception Mercury',
        desc: 'Diffusion-based LLM generation',
        keyName: 'MERCURY_API_KEY',
        defaultModel: 'mercury/mercury'
    },
    {
        name: 'Azure OpenAI',
        desc: 'Enterprise Azure OpenAI deployments',
        keyName: 'AZURE_OPENAI_API_KEY',
        defaultModel: 'azure/gpt-4o'
    },
    {
        name: 'MiniMax',
        desc: 'MiniMax-Text-01 and abab6.5s',
        keyName: 'MINIMAX_API_KEY',
        defaultModel: 'minimax/MiniMax-Text-01'
    },
    {
        name: 'Moonshot / Kimi',
        desc: 'Moonshot v1 long-context models',
        keyName: 'MOONSHOT_API_KEY',
        defaultModel: 'moonshot/moonshot-v1-8k'
    },
    {
        name: 'Zhipu AI / GLM',
        desc: 'GLM-4-Plus and GLM-4-Flash',
        keyName: 'ZHIPU_API_KEY',
        defaultModel: 'zhipu/glm-4-flash'
    },
    {
        name: 'Baichuan AI',
        desc: 'Baichuan 4 high performance model',
        keyName: 'BAICHUAN_API_KEY',
        defaultModel: 'baichuan/Baichuan4'
    },
    {
        name: '01.AI / Yi',
        desc: 'Yi-Lightning and Yi-Large',
        keyName: 'YI_API_KEY',
        defaultModel: 'yi/yi-lightning'
    },
    {
        name: 'StepFun',
        desc: 'Step-1 and Step-2 series',
        keyName: 'STEPFUN_API_KEY',
        defaultModel: 'stepfun/step-1-8k'
    },
    {
        name: 'InternLM',
        desc: 'SenseTime InternLM 2.5',
        keyName: 'INTERNLM_API_KEY',
        defaultModel: 'internlm/internlm2.5-latest'
    },
    {
        name: 'AI21 Labs',
        desc: 'Jamba 1.5 Large & Mini (Mamba-Transformer)',
        keyName: 'AI21_API_KEY',
        defaultModel: 'ai21/jamba-1.5-mini'
    },
    {
        name: 'Cloudflare Workers AI',
        desc: 'Global edge inference network',
        keyName: 'CLOUDFLARE_API_KEY',
        defaultModel: 'cloudflare/@cf/meta/llama-3.3-70b-instruct'
    },
    {
        name: 'Anyscale Endpoints',
        desc: 'Production Ray-served LLM endpoints',
        keyName: 'ANYSCALE_API_KEY',
        defaultModel: 'anyscale/meta-llama/Llama-3-70b-chat-hf'
    },
    {
        name: 'OctoAI',
        desc: 'Fast open-source compute platform',
        keyName: 'OCTOAI_API_KEY',
        defaultModel: 'octoai/meta-llama-3-70b-instruct'
    },
    {
        name: 'Lepton AI',
        desc: 'Efficient enterprise AI cloud',
        keyName: 'LEPTON_API_KEY',
        defaultModel: 'lepton/llama3-3-70b'
    },
    {
        name: 'Scaleway',
        desc: 'European sovereign cloud AI APIs',
        keyName: 'SCALEWAY_API_KEY',
        defaultModel: 'scaleway/llama-3.3-70b-instruct'
    },
    {
        name: 'MonsterAPI',
        desc: 'One-click scalable LLM APIs',
        keyName: 'MONSTERAPI_API_KEY',
        defaultModel: 'monsterapi/meta-llama/Meta-Llama-3.1-70B-Instruct'
    },
    {
        name: 'Nebius AI Studio',
        desc: 'High-throughput European GPU cloud',
        keyName: 'NEBIUS_API_KEY',
        defaultModel: 'nebius/meta-llama/Meta-Llama-3.1-70B-Instruct'
    },
    {
        name: 'OVHcloud AI',
        desc: 'GDPR-compliant hosted open models',
        keyName: 'OVH_API_KEY',
        defaultModel: 'ovh/Meta-Llama-3-70B-Instruct'
    },
    {
        name: 'Upstage Solar',
        desc: 'Solar Pro and Solar Mini',
        keyName: 'UPSTAGE_API_KEY',
        defaultModel: 'upstage/solar-pro'
    },
    {
        name: 'FriendliAI',
        desc: 'Ultra-low latency Friendli engine',
        keyName: 'FRIENDLI_API_KEY',
        defaultModel: 'friendli/meta-llama-3.3-70b-instruct'
    },
    {
        name: 'Lambda Labs',
        desc: 'Lambda cloud LLM completions',
        keyName: 'LAMBDA_API_KEY',
        defaultModel: 'lambda/hermes-3-llama-3.1-405b'
    },
    {
        name: 'Voyage AI',
        desc: 'High-precision retrieval & context models',
        keyName: 'VOYAGE_API_KEY',
        defaultModel: 'voyage/voyage-3'
    },
    {
        name: 'Writer Palmyra',
        desc: 'Palmyra X 004 enterprise LLM',
        keyName: 'WRITER_API_KEY',
        defaultModel: 'writer/palmyra-x-004'
    },
    {
        name: 'ShuttleAI',
        desc: 'Multi-model aggregated AI platform',
        keyName: 'SHUTTLE_API_KEY',
        defaultModel: 'shuttle/shuttle-3'
    },
    {
        name: 'AI/ML API',
        desc: 'Universal AI router with 100+ models',
        keyName: 'AIMLAPI_API_KEY',
        defaultModel: 'aimlapi/meta-llama/Llama-3.3-70B-Instruct-Turbo'
    },
    {
        name: 'Infinence',
        desc: 'High-speed specialized LLM endpoints',
        keyName: 'INFINENCE_API_KEY',
        defaultModel: 'infinence/llama-3.3-70b'
    },
    {
        name: 'Chutes AI',
        desc: 'Decentralized serverless inference',
        keyName: 'CHUTES_API_KEY',
        defaultModel: 'chutes/deepseek-ai/DeepSeek-V3'
    },
    {
        name: 'Kluster AI',
        desc: 'Fast distributed AI cluster',
        keyName: 'KLUSTER_API_KEY',
        defaultModel: 'kluster/klusterai/Meta-Llama-3.1-70B-Instruct-Turbo'
    },
    {
        name: 'GLHF',
        desc: 'Affordable open-source model inference',
        keyName: 'GLHF_API_KEY',
        defaultModel: 'glhf/hf:meta-llama/Llama-3.3-70B-Instruct'
    },
    {
        name: 'Ollama (Local / Offline)',
        desc: 'Local offline model on 127.0.0.1:11434 (No key needed)',
        keyName: 'OLLAMA_API_KEY',
        defaultModel: 'ollama/qwen2.5:0.5b',
        isLocal: true
    },
    {
        name: 'LM Studio (Local)',
        desc: 'Local model server on 127.0.0.1:1234 (No key needed)',
        keyName: 'LMSTUDIO_API_KEY',
        defaultModel: 'lmstudio/default',
        isLocal: true
    },
    {
        name: 'vLLM (Local / Self-hosted)',
        desc: 'High-throughput engine on 127.0.0.1:8000',
        keyName: 'VLLM_API_KEY',
        defaultModel: 'vllm/default',
        isLocal: true
    },
    {
        name: 'LocalAI (Self-hosted)',
        desc: 'LocalAI drop-in OpenAI replacement',
        keyName: 'LOCALAI_API_KEY',
        defaultModel: 'localai/default',
        isLocal: true
    },
    {
        name: 'Jan AI (Local)',
        desc: 'Jan local assistant server on 127.0.0.1:1337',
        keyName: 'JAN_API_KEY',
        defaultModel: 'jan/default',
        isLocal: true
    },
    {
        name: 'TextGen WebUI (Local)',
        desc: 'Oobabooga OpenAI-compatible extension',
        keyName: 'TEXTGEN_API_KEY',
        defaultModel: 'textgen/default',
        isLocal: true
    },
    {
        name: 'KoboldCPP (Local)',
        desc: 'KoboldCPP local server on 127.0.0.1:5001',
        keyName: 'KOBOLD_API_KEY',
        defaultModel: 'kobold/default',
        isLocal: true
    },
    {
        name: 'Custom Endpoint',
        desc: 'Any OpenAI-compatible server (specify URL & key)',
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
            const num = String(idx + 1).padStart(2, ' ');
            console.log(`  [${num}] ${p.name.padEnd(26)} - ${p.desc}`);
        });

        let providerIdx = -1;
        while (providerIdx < 0 || providerIdx >= PROVIDERS.length) {
            const answer = await rl.question(`\nSelect provider [1-${PROVIDERS.length}] or type name [1]: `);
            const trimmed = answer.trim();
            if (!trimmed) {
                providerIdx = 0;
            } else {
                const parsed = parseInt(trimmed, 10);
                if (!isNaN(parsed) && parsed >= 1 && parsed <= PROVIDERS.length) {
                    providerIdx = parsed - 1;
                } else {
                    const lower = trimmed.toLowerCase();
                    const found = PROVIDERS.findIndex(p => 
                        p.name.toLowerCase().includes(lower) || 
                        p.keyName.toLowerCase().includes(lower) ||
                        p.defaultModel.toLowerCase().includes(lower)
                    );
                    if (found !== -1) {
                        providerIdx = found;
                    } else {
                        console.log(`Please enter a number between 1 and ${PROVIDERS.length} or a provider name.`);
                    }
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
        if (selectedProvider.isLocal) {
            console.log(`\n  -> ${selectedProvider.name} is a local offline model.`);
            console.log(`  -> No API key required! Mindcraft will connect to Ollama at http://127.0.0.1:11434.\n`);
            apiKey = 'local';
        } else {
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
        const isAternos = host.toLowerCase().includes('aternos.me') || host.toLowerCase().includes('aternos.host');
        if (isAternos && !detectedPort) {
            console.log('\n  ⚠️  Aternos Notice: Aternos servers use a unique 5-digit port (not 25565)!');
            console.log('  👉 Check your Aternos dashboard: click "Connect" to view your Port (e.g. 12345 or 38291).\n');
        }

        const isLan = host === '127.0.0.1' || host === 'localhost';
        const defaultPort = detectedPort || (isLan ? 55916 : (isAternos ? '' : 25565));
        const portPrompt = defaultPort 
            ? `Minecraft Server Port (or -1 for auto-scan) [${defaultPort}]: `
            : `Minecraft Server Port (enter your Aternos 5-digit port): `;
        const portAns = await rl.question(portPrompt);
        const portParsed = parseInt(portAns.trim() || String(defaultPort || 25565), 10);
        const port = isNaN(portParsed) ? (defaultPort || 25565) : portParsed;

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
