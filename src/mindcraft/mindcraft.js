import { createMindServer, registerAgent, numStateListeners } from './mindserver.js';
import { AgentProcess } from '../process/agent_process.js';
import { getServer } from './mcserver.js';
import { resolveJavaVersion } from '../utils/version_patch.js';
import open from 'open';

let mindserver;
let connected = false;
let agent_processes = {};
let agent_count = 0;
let mindserver_port = 8080;

export async function init(host_public=false, port=8080, auto_open_ui=true) {
    if (connected) {
        console.error('Already initiliazed!');
        return;
    }
    mindserver = createMindServer(host_public, port);
    mindserver_port = port;
    connected = true;

    const isTermux = Boolean(process.env.TERMUX_VERSION || (process.env.PREFIX && process.env.PREFIX.includes('com.termux')));
    const isHeadless = isTermux || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && process.platform !== 'win32' && process.platform !== 'darwin');

    if (auto_open_ui && !isHeadless) {
        setTimeout(async () => {
            // check if browser listener is already open
            if (numStateListeners() === 0) {
                try {
                    await open('http://localhost:'+port);
                } catch {
                    // Silently ignore if browser cannot open
                }
            }
        }, 3000);
    }
}

export async function createAgent(settings) {
    if (!settings.profile.name) {
        settings.profile.name = 'Doombot';
    }
    settings = JSON.parse(JSON.stringify(settings));
    let agent_name = settings.profile.name;
    const agentIndex = agent_count++;
    const viewer_port = 3000 + agentIndex;
    let load_memory = settings.load_memory || false;
    let init_message = settings.init_message || null;

    try {
        try {
            const server = await getServer(settings.host, settings.port, settings.minecraft_version);
            settings.host = server.host;
            settings.port = server.port;
            settings.minecraft_version = resolveJavaVersion(server.version);
        } catch (error) {
            console.warn(`[Server] Ping unreachable (${error.message || error}).`);
            if (settings.minecraft_version === "auto" || !settings.minecraft_version) {
                settings.minecraft_version = "1.21.4";
            } else {
                settings.minecraft_version = resolveJavaVersion(settings.minecraft_version);
            }
            if (!settings.port || settings.port <= 0 || settings.port >= 65536) {
                settings.port = (settings.host === 'localhost' || settings.host === '127.0.0.1') ? 55916 : 25565;
            }
            console.log(`\x1b[36m[Doombots]\x1b[0m Direct connecting with protocol \x1b[35m${settings.minecraft_version}\x1b[0m...`);
        }

        // Register agent in MindServer with fully resolved settings
        registerAgent(settings, viewer_port);
        console.log(`\x1b[36m[Doombots]\x1b[0m Spawning agent \x1b[1m\x1b[32m${agent_name}\x1b[0m connecting to \x1b[33m${settings.host}:${settings.port}\x1b[0m...`);

        const agentProcess = new AgentProcess(agent_name, mindserver_port);
        agentProcess.start(load_memory, init_message, agentIndex);
        agent_processes[settings.profile.name] = agentProcess;
    } catch (error) {
        console.error(`Error creating agent ${agent_name}:`, error);
        destroyAgent(agent_name);
        return {
            success: false,
            error: error.message
        };
    }
    return {
        success: true,
        error: null
    };
}

export function getAgentProcess(agentName) {
    return agent_processes[agentName];
}

export function startAgent(agentName) {
    if (agent_processes[agentName]) {
        agent_processes[agentName].forceRestart();
    }
    else {
        console.error(`Cannot start agent ${agentName}; not found`);
    }
}

export function stopAgent(agentName) {
    if (agent_processes[agentName]) {
        agent_processes[agentName].stop();
    }
}

export function destroyAgent(agentName) {
    if (agent_processes[agentName]) {
        agent_processes[agentName].stop();
        delete agent_processes[agentName];
    }
}

export function shutdown() {
    console.log('Shutting down');
    for (let agentName in agent_processes) {
        try {
            agent_processes[agentName].stop();
        } catch {}
    }
    setTimeout(() => {
        process.exit(0);
    }, 1000);
}
