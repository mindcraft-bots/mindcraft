const settings = {
    "minecraft_version": "auto", // or specific version like "1.21.6"
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    "port": 55916, // set to -1 to automatically scan for open ports
    "auth": "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": true, // opens UI in browser on startup

    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    "load_memory": true, // load memory from previous session

    "init_message": "Respond with hello world and your name", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,
    // allows all bots to speak through text-to-speech.
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech.
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": false, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": true, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": -1, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 120, // message-count context window; compact considers messages after the latest compact boundary
    "compact_message_threshold_percent": 80, // compact the whole active context when it reaches this percent of max_messages
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "full", // "full", "shortened", or "none"
    "narrate_behavior": true, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.


    "log_all_prompts": false, // log ALL prompts to file
    "show_chat_history": true, // stream and persist Runtime chat/tool events for the web UI
    "log_chat_trace": false, // write trace JSONL even when Runtime UI history is disabled

    "llm_providers": "settings_llm_providers.json", // project-level LLM keys/model/embedding registry
    "profiles": [
        // Default enabled agent. Using more than one profile requires you to /msg each bot individually.
        "andy.json",                  // Default Andy profile at the project root

        // Mainstream preset profiles. Uncomment one or more to launch them.
        // Protocol representative native-tool smoke profiles
        // "profiles/gpt.json",       // OpenAI Responses: openai:gpt-5.5
        // "profiles/codex.json",     // Codex ChatGPT login: codex:gpt-5.5
        // "profiles/openrouter.json",// OpenRouter / OpenAI Chat Completions: moonshotai/kimi-k2.6
        // "profiles/kimi.json",      // Kimi Anthropic-compatible: kimi-k2.6
        // "profiles/gemini.json",    // Gemini / google-generative-ai: gemini-2.5-flash

        // OpenAI / ChatGPT
        // "profiles/gpt.json",
        // "profiles/codex.json",         // Use a ChatGPT account login; Plus/Pro has higher limits, free accounts may have limited quota.
        // "profiles/azure.json",

        // Anthropic / Claude-compatible
        // "profiles/claude.json",
        // "profiles/claude_thinker.json",
        // "profiles/kimi.json",
        // "profiles/minimax-cn.json",
        // "profiles/minimax-intl.json",

        // Google / Gemini
        // "profiles/gemini.json",

        // OpenAI-compatible providers and model routers
        // "profiles/openrouter.json",
        // "profiles/deepseek.json",
        // "profiles/qwen-cn.json",
        // "profiles/siliconflow.json",
        // "profiles/mistral.json",
        // "profiles/grok.json",
        // "profiles/groq.json",
        // "profiles/cerebras.json",
        // "profiles/mercury.json",
        // "profiles/novita.json",
        // "profiles/ollama.json",

        // Replicate and local/custom runtimes
        // "profiles/replicate.json",
        // "profiles/llama.json",
        // "profiles/vllm.json",
        // "profiles/andy-4.2.json",      // Andy 4.2 via local LM Studio OpenAI-compatible server
        // "profiles/freeguy.json",
    ],
};

export default settings;
