import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users 
// - host for webapp

let io;
let server;
const agent_connections = {};
const agent_listeners = [];

const base_settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));
let active_settings_spec = base_settings_spec;
const runtime_default_settings = new Set(['llm_providers']);

export function buildRuntimeSettingsSpec(runtimeSettings = {}) {
    const spec = JSON.parse(JSON.stringify(base_settings_spec));
    for (const [key, value] of Object.entries(runtimeSettings || {})) {
        if (!runtime_default_settings.has(key) || !(key in spec) || value === undefined) continue;
        spec[key].default = value;
    }
    return spec;
}


function isSafeAgentName(agentName) {
    return /^[A-Za-z0-9_-]+$/.test(String(agentName || ''));
}

function resolveProjectPath(cwd, maybePath) {
    if (!maybePath || typeof maybePath !== 'string') return null;
    return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

function readJsonLines(filePath) {
    const raw = readFileSync(filePath, 'utf8').trim();
    if (!raw) return [];
    return raw
        .split(/\r?\n/)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

function newestJsonlFile(dirPath) {
    if (!existsSync(dirPath)) return null;
    const files = readdirSync(dirPath)
        .filter(name => name.endsWith('.jsonl'))
        .map(name => path.join(dirPath, name))
        .filter(file => {
            try { return statSync(file).isFile(); }
            catch { return false; }
        })
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0] || null;
}

export function readSavedChatHistory(agentName, options = {}) {
    const { loadMemory = true, cwd = process.cwd() } = options;
    if (loadMemory !== true) {
        return { loaded: false, reason: 'load_memory_disabled', events: [] };
    }
    if (!isSafeAgentName(agentName)) {
        return { loaded: false, reason: 'invalid_agent_name', events: [] };
    }

    const botDir = path.join(cwd, 'bots', agentName);
    const memoryPath = path.join(botDir, 'memory.json');
    const candidates = [];
    let memoryData = null;

    if (existsSync(memoryPath)) {
        try {
            memoryData = JSON.parse(readFileSync(memoryPath, 'utf8'));
            candidates.push(resolveProjectPath(cwd, memoryData.chat_history_trace));
            candidates.push(resolveProjectPath(cwd, memoryData.chat_history_latest));
        } catch (error) {
            console.warn(`Failed to read ${agentName}'s memory file for chat history: ${error.message}`);
        }
    }

    candidates.push(...allJsonlFiles(path.join(botDir, 'chat-history')));
    candidates.push(path.join(botDir, 'chat_history.jsonl'));
    candidates.push(newestJsonlFile(path.join(botDir, 'chat-history')));

    const historyFiles = uniqueExistingFiles(candidates).sort(compareTraceFiles);
    if (historyFiles.length > 0) {
        try {
            const events = dedupeChatEvents(historyFiles.flatMap(file => readJsonLines(file)));
            return {
                loaded: true,
                source: historyFiles[0],
                sources: historyFiles,
                events: expandArchivedCompactHistory(events, cwd, agentName)
            };
        } catch (error) {
            return { loaded: false, reason: 'read_error', error: error.message, events: [] };
        }
    }

    if (Array.isArray(memoryData?.turns) && memoryData.turns.length > 0) {
        return {
            loaded: true,
            source: memoryPath,
            restored_from_memory: true,
            events: expandArchivedCompactHistory(memoryData.turns.map((turn, index) => ({
                timestamp: memoryData.updated_at || null,
                agent: agentName,
                type: 'history_turn_added',
                turn,
                active_turn_count: index + 1,
                restored_from_memory: true
            })), cwd, agentName)
        };
    }

    return { loaded: false, reason: 'not_found', events: [] };
}

function allJsonlFiles(dirPath) {
    if (!existsSync(dirPath)) return [];
    return readdirSync(dirPath)
        .filter(name => name.endsWith('.jsonl'))
        .map(name => path.join(dirPath, name))
        .filter(file => {
            try { return statSync(file).isFile(); }
            catch { return false; }
        });
}

function uniqueExistingFiles(files) {
    const seen = new Set();
    const out = [];
    for (const file of files) {
        if (!file || !existsSync(file)) continue;
        const resolved = path.resolve(file);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        out.push(resolved);
    }
    return out;
}

function compareTraceFiles(a, b) {
    const nameCompare = path.basename(a).localeCompare(path.basename(b));
    if (nameCompare !== 0) return nameCompare;
    try {
        return statSync(a).mtimeMs - statSync(b).mtimeMs;
    } catch {
        return 0;
    }
}

function dedupeChatEvents(events) {
    const seen = new Set();
    const out = [];
    for (const event of events) {
        const key = chatEventKey(event);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(event);
    }
    return out;
}

function chatEventKey(event) {
    if (!event || typeof event !== 'object') return JSON.stringify(event);
    const toolId = event.tool_call?.id || event.tool_call?.tool_call_id || event.tool_call?.function?.id || '';
    const toolName = event.tool_call?.name || event.tool_call?.function?.name || '';
    const model = event.model?.model || event.model?.api || '';
    const turnKey = event.turn ? historyTurnKey(event.turn) : '';
    return [event.timestamp || '', event.agent || '', event.type || '', event.tag || '', toolId || toolName, model, turnKey].join('|');
}

function expandArchivedCompactHistory(events, cwd, agentName) {
    const output = [];
    const seenTurns = new Set();
    for (const event of events) {
        const archiveFile = getArchiveFileFromEvent(event);
        if (archiveFile) {
            const archivedTurns = readArchivedTurns(cwd, archiveFile);
            archivedTurns.forEach((turn, index) => {
                const key = historyTurnKey(turn);
                if (!key || seenTurns.has(key)) return;
                const archiveEvent = {
                    timestamp: event.timestamp || null,
                    agent: event.agent || agentName,
                    type: 'history_turn_added',
                    turn,
                    active_turn_count: index + 1,
                    restored_from_archive: true,
                    archive_file: archiveFile
                };
                output.push(archiveEvent);
                seenTurns.add(key);
            });
        }
        output.push(event);
        if (event?.type === 'history_turn_added' && event.turn) {
            const key = historyTurnKey(event.turn);
            if (key) seenTurns.add(key);
        }
    }
    return output;
}

function getArchiveFileFromEvent(event) {
    return event?.full_history_file ||
        event?.turn?.archive_file ||
        event?.turn?.compact_metadata?.archive_file ||
        event?.compact_metadata?.archive_file ||
        null;
}

function readArchivedTurns(cwd, archiveFile) {
    const archivePath = resolveProjectPath(cwd, archiveFile);
    if (!archivePath || !existsSync(archivePath)) return [];
    try {
        const parsed = JSON.parse(readFileSync(archivePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.warn(`Failed to read compact archive ${archiveFile}: ${error.message}`);
        return [];
    }
}

function historyTurnKey(turn) {
    if (!turn || typeof turn !== 'object') return '';
    const calls = Array.isArray(turn.native_tool_calls)
        ? turn.native_tool_calls.map(call => call.id || call.name || call.function?.name || '').join(',')
        : '';
    return [turn.role || '', turn.content || '', turn.tool_call_id || '', calls].join('|');
}

class AgentConnection {
    constructor(settings, viewer_port) {
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
    }
    setSettings(settings) {
        this.settings = settings;
    }
}

export function registerAgent(settings, viewer_port) {
    let agentConnection = new AgentConnection(settings, viewer_port);
    agent_connections[settings.profile.name] = agentConnection;
}

export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agentsStatusUpdate();
    }
}

// Initialize the server
export function createMindServer(host_public = false, port = 8080, runtimeSettings = {}) {
    active_settings_spec = buildRuntimeSettingsSpec(runtimeSettings);
    const app = express();
    server = http.createServer(app);
    io = new Server(server);

    // Serve runtime-aware settings spec before static files so the New Agent form
    // inherits the actual settings.js defaults, including the LLM provider registry path.
    app.get('/settings_spec.json', (_req, res) => {
        res.json(active_settings_spec);
    });


    app.get('/chat-history/:agent', (req, res) => {
        const agentName = req.params.agent;
        const conn = agent_connections[agentName];
        if (!conn) {
            res.status(404).json({ loaded: false, reason: 'agent_not_found', events: [] });
            return;
        }
        const history = readSavedChatHistory(agentName, {
            loadMemory: conn.settings?.load_memory === true
        });
        res.json(history);
    });

    // Serve static files
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.join(__dirname, 'public')));

    // Texture proxy: resolve item/block textures using minecraft-assets with version fallback
    app.get('/assets/item/:agent/:name.png', async (req, res) => {
        try {
            const agentName = req.params.agent;
            const rawName = req.params.name;
            const itemName = String(rawName).toLowerCase();
            const conn = agent_connections[agentName];
            const preferred = conn?.settings?.minecraft_version;
            const candidates = [];
            if (preferred && preferred !== 'auto') candidates.push(preferred);
            candidates.push('1.21.8');

            // Lazy import to avoid ESM/CJS conflicts
            const mod = await import('minecraft-assets');
            const mcAssetsFactory = mod.default || mod;

            for (const ver of candidates) {
                try {
                    const assets = mcAssetsFactory(ver);
                    // Prefer items path first, then blocks
                    const item = assets.items[itemName];
                    const block = assets.blocks[itemName];
                    const tex = assets.textureContent?.[itemName]?.texture
                        || (item ? assets.textureContent?.[itemName]?.texture : null)
                        || (block ? assets.textureContent?.[itemName]?.texture : null);
                    if (tex) {
                        // textureContent already provides a data URL in many versions
                        if (tex.startsWith('data:image')) {
                            const base64 = tex.split(',')[1];
                            const img = globalThis.Buffer.from(base64, 'base64');
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(img);
                        }
                    }
                    // If textureContent missing, try static path resolution inside package
                    // Helps with some strange blocks like Leaf Litter
                    const guessPaths = [];
                    const base = assets.directory;
                    guessPaths.push(path.join(base, 'items', `${itemName}.png`));
                    guessPaths.push(path.join(base, 'blocks', `${itemName}.png`));
                    for (const p of guessPaths) {
                        try {
                            const fsMod = await import('fs');
                            const buf = fsMod.readFileSync(p);
                            res.setHeader('Content-Type', 'image/png');
                            return res.end(buf);
                        } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
            // Not found, fallback svg
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">?</text></svg>');
        } catch (e) {
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(500).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">!</text></svg>');
        }
    });

    // Socket.io connection handling
    io.on('connection', (socket) => {
        let curAgentName = null;
        console.log('Client connected');

        agentsStatusUpdate(socket);

        socket.on('create-agent', async (settings, callback) => {
            console.log('API create agent...');
            for (let key in active_settings_spec) {
                if (!(key in settings)) {
                    if (active_settings_spec[key].required) {
                        callback({ success: false, error: `Setting ${key} is required` });
                        return;
                    }
                    else {
                        settings[key] = active_settings_spec[key].default;
                    }
                }
            }
            for (let key in settings) {
                if (!(key in active_settings_spec)) {
                    delete settings[key];
                }
            }
            if (settings.profile?.name) {
                if (settings.profile.name in agent_connections) {
                    callback({ success: false, error: 'Agent already exists' });
                    return;
                }
                let returned = await mindcraft.createAgent(settings);
                callback({ success: returned.success, error: returned.error });
                let name = settings.profile.name;
                if (!returned.success && agent_connections[name]) {
                    mindcraft.destroyAgent(name);
                    delete agent_connections[name];
                }
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                callback({ success: false, error: 'Agent name is required in profile' });
            }
        });

        socket.on('get-settings', (agentName, callback) => {
            if (agent_connections[agentName]) {
                callback({ settings: agent_connections[agentName].settings });
            } else {
                callback({ error: `Agent '${agentName}' not found.` });
            }
        });

        socket.on('connect-agent-process', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agentsStatusUpdate();
            }
        });

        socket.on('login-agent', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                curAgentName = agentName;
                agentsStatusUpdate();
            }
            else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        socket.on('disconnect', () => {
            if (agent_connections[curAgentName]) {
                console.log(`Agent ${curAgentName} disconnected`);
                agent_connections[curAgentName].in_game = false;
                agent_connections[curAgentName].socket = null;
                agentsStatusUpdate();
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        socket.on('chat-message', (agentName, json) => {
            if (!agent_connections[agentName]) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                return;
            }
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            agent_connections[agentName].socket.emit('chat-message', curAgentName, json);
        });

        socket.on('set-agent-settings', (agentName, settings) => {
            const agent = agent_connections[agentName];
            if (agent) {
                agent.setSettings(settings);
                agent.socket.emit('restart-agent');
            }
        });

        socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            agent_connections[agentName].socket.emit('restart-agent');
        });

        socket.on('stop-agent', (agentName) => {
            const agent = agent_connections[agentName];
            if (agent?.socket) {
                agent.socket.emit('stop-agent');
                return;
            }
            mindcraft.stopAgent(agentName);
        });

        socket.on('start-agent', (agentName) => {
            mindcraft.startAgent(agentName);
        });

        socket.on('destroy-agent', (agentName) => {
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
            // wait 2 seconds
            setTimeout(() => {
                console.log('Exiting MindServer');
                globalThis.process.exit(0);
            }, 2000);
            
        });

		socket.on('send-message', (agentName, data) => {
			if (!agent_connections[agentName]) {
				console.warn(`Agent ${agentName} not in game, cannot send message via MindServer.`);
                return;
			}
			try {
                agent_connections[agentName].socket.emit('send-message', data);
			} catch (error) {
				console.error('Error: ', error);
			}
		});

        socket.on('bot-output', (agentName, message) => {
            io.emit('bot-output', agentName, message);
        });

        socket.on('agent-trace', (agentName, event) => {
            io.emit('agent-trace', agentName, event);
        });

        socket.on('listen-to-agents', () => {
            addListener(socket);
        });
    });

    if (host_public) {
        console.log('Public hosting not supported yet. Using localhost.');
    }
    const host = 'localhost';
    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
    });

    return server;
}

function agentsStatusUpdate(socket) {
    if (!socket) {
        socket = io;
    }
    let agents = [];
    for (let agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName, 
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket
        });
    };
    socket.emit('agents-status', agents);
}


let listenerInterval = null;
function addListener(listener_socket) {
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        listenerInterval = setInterval(async () => {
            const states = {};
            for (let agentName in agent_connections) {
                let agent = agent_connections[agentName];
                if (agent.in_game) {
                    try {
                        const state = await new Promise((resolve) => {
                            agent.socket.emit('get-full-state', (s) => resolve(s));
                        });
                        states[agentName] = state;
                    } catch (e) {
                        states[agentName] = { error: String(e) };
                    }
                }
            }
            for (let listener of agent_listeners) {
                listener.emit('state-update', states);
            }
        }, 1000);
    }
}

function removeListener(listener_socket) {
    agent_listeners.splice(agent_listeners.indexOf(listener_socket), 1);
    if (agent_listeners.length === 0) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

// Optional: export these if you need access to them from other files
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;