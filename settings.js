import os from 'os';
import fs from 'fs';

// Automatic environment detection for Termux, low RAM (<=4GB), and headless Linux
export const isTermux = Boolean(
    process.env.TERMUX_VERSION || 
    (process.env.PREFIX && process.env.PREFIX.includes('com.termux'))
);

const totalMemBytes = (typeof os.totalmem === 'function') ? os.totalmem() : 4 * 1024 * 1024 * 1024;
export const isLowMemorySystem = totalMemBytes <= 4.5 * 1024 * 1024 * 1024; // 4GB or less
const autoLowMem = process.env.LOW_MEMORY_MODE !== undefined 
    ? process.env.LOW_MEMORY_MODE === 'true' 
    : (isTermux || isLowMemorySystem);

const autoFastMode = process.env.FAST_MODE !== undefined
    ? process.env.FAST_MODE !== 'false'
    : true; // Default to fast mode for fastest response times

const settings = {
    "minecraft_version": "auto", // or specific version like "1.21.6"
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    "port": 55916, // set to -1 to automatically scan for open ports
    "auth": "offline", // or "microsoft"

    // Performance & Memory optimization for Linux 4GB RAM & Termux
    "fast_mode": autoFastMode, // eliminates artificial latency, enables async memory saves
    "low_memory_mode": autoLowMem, // memory caps, periodic chunk pruning, aggressive GC
    "max_agent_memory_mb": isTermux ? 768 : (isLowMemorySystem ? 1024 : 1536), // Node V8 heap ceiling per agent

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": !isTermux && !process.env.HEADLESS, // disable auto browser launch on Termux/headless Linux
    
    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    "profiles": [
        "./andy.json",
        // "./profiles/fast.json",       // Ultra-fast and accurate (Groq / Cerebras)
        // "./profiles/cerebras.json",   // World-record inference speed (Cerebras)
        // "./profiles/sambanova.json",  // Ultra-fast SN40L inference (SambaNova)
        // "./profiles/together.json",   // Blazing fast Llama-3.3-Turbo (Together AI)
        // "./profiles/fireworks.json",  // Fast & accurate low-latency (Fireworks AI)
        // "./profiles/deepseek.json",   // DeepSeek V3/R1
        // "./profiles/gpt.json",        // OpenAI GPT
        // "./profiles/claude.json",     // Anthropic Claude
        // "./profiles/gemini.json",     // Google Gemini Flash
        // "./profiles/llama.json",      // Llama 3.3
        // "./profiles/qwen.json",       // Qwen 2.5
    ],

    "load_memory": false, // load memory from previous session
    "init_message": "Respond with hello world and your name", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": false, // Keep false on Termux & 4GB Linux to save RAM (show bot's view in browser at localhost:3000, 3001...)

    "allow_insecure_coding": false, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": false, // allows vision model to interpret screenshots as inputs (keep false on Termux)
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": -1, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": autoLowMem ? 12 : 15, // max number of messages to keep in context (tuned for low memory)
    "num_examples": 2, // number of examples to give to the model
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "full", // "full", "shortened", or "none"
    "narrate_behavior": true, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 90, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.
  
    "log_all_prompts": false, // log ALL prompts to file
};

// Automatically load saved terminal configuration if config.json exists
try {
    if (fs.existsSync('./config.json')) {
        const savedConfig = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
        Object.assign(settings, savedConfig);
    }
} catch {
    // ignore
}

export default settings;
