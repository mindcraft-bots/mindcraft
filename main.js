// Clear terminal immediately when software is run
try {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H\x1bc');
} catch {
    console.clear();
}

import './src/utils/version_patch.js';
import * as Mindcraft from './src/mindcraft/mindcraft.js';
import settings from './settings.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFileSync, existsSync } from 'fs';
import { selectAPI } from './src/models/_model_map.js';
import { hasKey, reloadKeys, getAvailableProviders } from './src/utils/keys.js';
import { runInteractiveSetup, promptStartupChoice } from './src/utils/interactive_setup.js';
import { printDashboard } from './src/utils/dashboard.js';

function parseArguments() {
    return yargs(hideBin(process.argv))
        .option('profiles', {
            type: 'array',
            describe: 'List of agent profile paths',
        })
        .option('task_path', {
            type: 'string',
            describe: 'Path to task file to execute'
        })
        .option('task_id', {
            type: 'string',
            describe: 'Task ID to execute'
        })
        .option('low-memory', {
            type: 'boolean',
            describe: 'Enable memory optimizations for Linux 4GB RAM & Termux'
        })
        .option('fast', {
            type: 'boolean',
            describe: 'Enable fast response mode (minimizes cooldown & latency)'
        })
        .option('configure', {
            type: 'boolean',
            describe: 'Run interactive terminal setup to configure API keys and settings'
        })
        .option('setup', {
            type: 'boolean',
            describe: 'Alias for --configure'
        })
        .option('now', {
            type: 'boolean',
            alias: ['y', 'yes'],
            describe: 'Skip startup prompt and run immediately'
        })
        .help()
        .alias('help', 'h')
        .parse();
}
const args = parseArguments();
if (args.profiles) {
    settings.profiles = args.profiles;
}
if (args['low-memory'] !== undefined) {
    settings.low_memory_mode = args['low-memory'];
}
if (args.fast !== undefined) {
    settings.fast_mode = args.fast;
}
if (args.task_path) {
    let tasks = JSON.parse(readFileSync(args.task_path, 'utf8'));
    if (args.task_id) {
        settings.task = tasks[args.task_id];
        settings.task.task_id = args.task_id;
    }
    else {
        throw new Error('task_id is required when task_path is provided');
    }
}

// these environment variables override certain settings
if (process.env.MINECRAFT_PORT) {
    settings.port = parseInt(process.env.MINECRAFT_PORT, 10);
}
if (process.env.MINDSERVER_PORT) {
    settings.mindserver_port = parseInt(process.env.MINDSERVER_PORT, 10);
}
if (process.env.PROFILES && JSON.parse(process.env.PROFILES).length > 0) {
    settings.profiles = JSON.parse(process.env.PROFILES);
}
if (process.env.INSECURE_CODING) {
    settings.allow_insecure_coding = true;
}
if (process.env.BLOCKED_ACTIONS) {
    settings.blocked_actions = JSON.parse(process.env.BLOCKED_ACTIONS);
}
if (process.env.MAX_MESSAGES) {
    settings.max_messages = process.env.MAX_MESSAGES;
}
if (process.env.LOW_MEMORY_MODE !== undefined) {
    settings.low_memory_mode = process.env.LOW_MEMORY_MODE === 'true';
}
if (process.env.FAST_MODE !== undefined) {
    settings.fast_mode = process.env.FAST_MODE !== 'false';
}
if (process.env.AGENT_MAX_MEMORY) {
    settings.max_agent_memory_mb = parseInt(process.env.AGENT_MAX_MEMORY);
}
if (process.env.NUM_EXAMPLES) {
    settings.num_examples = process.env.NUM_EXAMPLES;
}
if (process.env.LOG_ALL) {
    settings.log_all_prompts = process.env.LOG_ALL;
}
if (process.env.SETTINGS_JSON) {
    try {
        Object.assign(settings, JSON.parse(process.env.SETTINGS_JSON));
    } catch (err) {
        console.error("Failed to parse environment variable for SETTINGS_JSON:", err);
    }
}

// Interactive terminal setup wizard
const wantsConfigure = args.configure || args.setup || process.env.CONFIGURE === 'true';

let firstProfileData = {};
try {
    if (settings.profiles && settings.profiles[0] && existsSync(settings.profiles[0])) {
        firstProfileData = JSON.parse(readFileSync(settings.profiles[0], 'utf8'));
    }
} catch {}

let needsKey = false;
reloadKeys();
try {
    if (firstProfileData.model) {
        const modelProfile = selectAPI(firstProfileData.model);
        const localApis = ['ollama', 'vllm', 'lmstudio'];
        if (!localApis.includes(modelProfile.api)) {
            if (!hasKey(modelProfile.api)) {
                needsKey = true;
            }
        }
    } else {
        const providers = getAvailableProviders();
        if (providers.length === 0) needsKey = true;
    }
} catch (e) {
    const providers = getAvailableProviders();
    if (providers.length === 0) needsKey = true;
}

// Print dashboard banner and status immediately so the user sees the Doombots interface
printDashboard(settings, firstProfileData);

let shouldRunSetup = wantsConfigure;

if (needsKey && process.stdin.isTTY) {
    console.log('\n\x1b[33m[Doombots]\x1b[0m No API key detected for the selected model.');
    shouldRunSetup = true;
} else if (!wantsConfigure && !args.now && process.stdin.isTTY) {
    const choice = await promptStartupChoice(5);
    if (choice === 'setup') {
        shouldRunSetup = true;
    }
}

if (shouldRunSetup) {
    await runInteractiveSetup(true);
    reloadKeys();
    try {
        if (existsSync('./config.json')) {
            const savedConfig = JSON.parse(readFileSync('./config.json', 'utf8'));
            Object.assign(settings, savedConfig);
        }
    } catch {}
    try {
        if (settings.profiles && settings.profiles[0] && existsSync(settings.profiles[0])) {
            firstProfileData = JSON.parse(readFileSync(settings.profiles[0], 'utf8'));
        }
    } catch {}
    printDashboard(settings, firstProfileData);
}

Mindcraft.init(false, settings.mindserver_port, settings.auto_open_ui);

for (let profile of settings.profiles) {
    const profile_json = JSON.parse(readFileSync(profile, 'utf8'));
    settings.profile = profile_json;
    Mindcraft.createAgent(settings);
}