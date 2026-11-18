import { sendOutputToServer } from './mindserver_proxy.js';

// Definitions of error types, keywords, and full human-readable messages.
const ERROR_DEFINITIONS = {
    'name_conflict': {
        keywords: ['name_taken', 'duplicate_login', 'already connected', 'already logged in', 'username is already'],
        msg: 'Name Conflict: The name is already in use or you are already logged in.',
        isFatal: true
    },
    'access_denied': {
        keywords: ['whitelist', 'not white-listed', 'banned', 'suspended', 'verify'],
        msg: 'Access Denied: You are not whitelisted or banned.',
        isFatal: true
    },
    'server_full': {
        keywords: ['server is full', 'full server'],
        msg: 'Connection Failed: The server is full.',
        isFatal: false
    },
    'version_mismatch': {
        keywords: ['outdated', 'version', 'client', 'missing-data', 'do not have data', '1.21.11'],
        msg: 'Version Compatibility: Minecraft protocol normalized by LoginGuard to Java 1.21.4.',
        isFatal: false
    },
    'maintenance': {
        keywords: ['maintenance', 'updating', 'closed', 'restarting'],
        msg: 'Connection Failed: Server is under maintenance or restarting.',
        isFatal: false
    },
    'network_error': {
        keywords: ['timeout', 'timed out', 'connection lost', 'reset', 'refused', 'keepalive', 'epipe', 'socketclosed', 'econnreset', 'closed'],
        msg: 'Network Error: Connection timed out, refused, or closed by server.',
        isFatal: false
    },
    'behavior': {
        keywords: ['flying', 'spam', 'speed'],
        msg: 'Kicked: Removed from server due to flying, spamming, or invalid movement.',
        isFatal: true
    }
};

// Helper to log messages to console (once) and MindServer.
export const log = (agentName, msg) => {
    // Use console.error for visibility in terminal
    console.error(msg);
    try { sendOutputToServer(agentName || 'system', msg); } catch (_) {}
};

// Analyzes the kick reason and returns a full, human-readable sentence.
export function parseKickReason(reason) {
    if (!reason) return { type: 'unknown', msg: 'Unknown reason (Empty)', isFatal: true };
    
    const raw = (typeof reason === 'string' ? reason : JSON.stringify(reason)).toLowerCase();

    // Search for keywords in definitions
    for (const [type, def] of Object.entries(ERROR_DEFINITIONS)) {
        if (def.keywords.some(k => raw.includes(k))) {
            console.error(`Disconnected: ${raw}`);
            return { type, msg: def.msg, isFatal: def.isFatal };
        }
    }
    
    // Fallback: Extract text from JSON
    let fallback = raw;
    try {
        const obj = typeof reason === 'string' ? JSON.parse(reason) : reason;
        fallback = obj.translate || obj.text || (obj.value?.translate) || raw;
    } catch (_) {}
    
    return { type: 'other', msg: `Disconnected: ${fallback}`, isFatal: true };
}

// Centralized handler for disconnections.
export function handleDisconnection(agentName, reason) {
    const { type, msg } = parseKickReason(reason);
    
    // Format: [LoginGuard] Error Message
    const finalMsg = `[LoginGuard] ${msg}`;
    
    // Only call log once (it handles console printing)
    log(agentName, finalMsg);

    if (type === 'network_error') {
        console.error(`\n[LoginGuard] 💡 Server Connection Tips:`);
        console.error(`   1. Verify your server is fully ONLINE and running.`);
        console.error(`   2. Aternos Note: Aternos servers use a unique 5-digit Port (e.g. 12345, not 25565).`);
        console.error(`      Find your port on your Aternos dashboard under 'Connect'.`);
        console.error(`   3. In Aternos Options: turn ON 'Cracked' if using offline authentication.`);
        console.error(`   4. If Whitelist is on: type '/whitelist add ${agentName}' in server console.\n`);
    } else if (type === 'version_mismatch' || String(reason).includes('1.21.11') || String(reason).includes('missing-data')) {
        console.log(`\n[LoginGuard] 💡 Version Compatibility Note:`);
        console.log(`   Minecraft 1.21.11 (Geyser/Bedrock/ViaVersion) detected.`);
        console.log(`   LoginGuard bridges this connection to Java 1.21.4 protocol for full compatibility.\n`);
    } else if (type === 'access_denied') {
        console.error(`\n[LoginGuard] 💡 Whitelist Notice: Type '/whitelist add ${agentName}' in your Minecraft server console to allow the bot to join.\n`);
    } else if (type === 'name_conflict') {
        console.error(`\n[LoginGuard] 💡 Name Conflict: The username '${agentName}' is already online on the server. Change the bot name in config.json or kick the duplicate player.\n`);
    }
    
    return { type, msg: finalMsg };
}

// Validates name format.
export function validateNameFormat(name) {
    if (!name || !/^[a-zA-Z0-9_]{3,16}$/.test(name)) {
        return { 
            success: false, 
            // Added [LoginGuard] prefix here for consistency
            msg: `[LoginGuard] Invalid name '${name}'. Must be 3-16 alphanumeric/underscore characters.` 
        };
    }
    return { success: true };
}