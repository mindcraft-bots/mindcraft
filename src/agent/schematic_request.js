import { executeCommand, commandExists } from './commands/index.js';
import { resolveSchematicPath } from '../utils/schematic/paths.js';

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function positiveNumber(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0;
}

/** Identify the addressee before interpreting any command or natural-language intent. */
export function parseChatAddress(message, agentName, knownBotPeers = []) {
    if (typeof message !== 'string' || typeof agentName !== 'string') return null;
    const names = [agentName, ...knownBotPeers].filter((name, index, all) =>
        typeof name === 'string' && name.length > 0 && all.indexOf(name) === index);
    if (!names.length) return null;
    const address = new RegExp(`^\\s*@?(${names.map(escapeRegExp).join('|')})(?=$|[\\s,:!])\\s*[,:]?\\s*`, 'i').exec(message);
    if (!address) return null;

    const addressedTo = names.find(name => name.toLowerCase() === address[1].toLowerCase());
    return { addressedTo, text: message.slice(address[0].length) };
}

/** Recognize only explicitly addressed, pack/group/file-ID natural-language build requests. */
export function parseAddressedSchematicRequest(message, agentName, knownBotPeers = []) {
    const address = parseChatAddress(message, agentName, knownBotPeers);
    if (!address) return null;
    const { addressedTo } = address;
    const text = address.text.replace(/^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?/i, '');
    if (!/^build\b/i.test(text)) return null;

    const hasSchematicSelectors = /\bpack\w*\b|\bgroup\b|\b(?:schematic|file\s*id|file|id|offset)\b/i.test(text);
    if (!hasSchematicSelectors) return null;

    const packMatches = [...text.matchAll(/\b(pack\d+)\b/gi)];
    const groupMatches = [...text.matchAll(/\bgroup\s*#?\s*(\d+)/gi)];
    const explicitFileMatches = [...text.matchAll(/\b(?:file\s*id|file|id|offset)\s*#?\s*(\d+)/gi)];
    const groupIndex = groupMatches[0]?.index ?? text.length;
    const prefix = text.slice(5, groupIndex);
    const leadingFileMatch = /^\s+(?:the\s+)?(?:schematic\s+)?(\d+)\b/i.exec(prefix);
    const fileMatches = [...explicitFileMatches, ...(leadingFileMatch ? [leadingFileMatch] : [])];

    const errors = [];
    if (packMatches.length !== 1) errors.push(packMatches.length ? 'include exactly one pack name' : 'include a pack name such as pack1');
    if (groupMatches.length !== 1) errors.push(groupMatches.length ? 'include exactly one numeric group' : 'include a numeric group');
    if (fileMatches.length !== 1) errors.push(fileMatches.length ? 'include exactly one file ID' : 'include a numeric file ID');

    // Reject partial numeric matches, extra instructions/coordinates, and conflicting selectors.
    // Only connector words may remain after removing the three complete selector phrases.
    let remainder = text.slice(5);
    for (const match of [...packMatches, ...groupMatches, ...explicitFileMatches]) {
        remainder = remainder.replace(match[0], ' ');
    }
    if (leadingFileMatch) remainder = remainder.replace(leadingFileMatch[0], ' ');
    remainder = remainder.replace(/\b(?:the|schematic|from|of|in|file|id|offset|please)\b/gi, '');
    if (!/^[\s,!?]*$/.test(remainder)) errors.push('use only whole-number selectors, without additional instructions; use a direct command for coordinates');

    if (!errors.length) {
        const pack = packMatches[0][1].toLowerCase();
        const group = groupMatches[0][1];
        const fileId = fileMatches[0][1];
        if (!/^pack[1-9]\d*$/.test(pack)) errors.push('use a valid pack name such as pack1');
        if (!positiveNumber(group)) errors.push('the group must be a positive whole number');
        if (!positiveNumber(fileId)) errors.push('the file ID must be a positive whole number');
        if (!errors.length) {
            return {
                addressedTo,
                selector: `${pack}:${String(Number(group)).padStart(2, '0')}:${String(Number(fileId)).padStart(2, '0')}`,
            };
        }
    }

    return {
        addressedTo,
        error: `I could not safely identify that schematic. Please specify one pack, group, and file ID (for example: build ID 01 from group 02 of pack1). ${errors.join('; ')}.`,
    };
}

/** Extract an explicitly addressed direct chat command without accepting extra/spoofed command data. */
export function parseAddressedChatCommand(message, agentName, knownBotPeers = []) {
    const address = parseChatAddress(message, agentName, knownBotPeers);
    if (!address || !/^!\w+/.test(address.text)) return null;
    return { addressedTo: address.addressedTo, command: address.text.trim() };
}

/** Dispatch a recognized request through the existing command map and action lifecycle. */
export async function dispatchAddressedSchematicRequest(agent, source, message, {
    agentName = agent.name,
    knownBotPeers = [],
    trusted = false,
} = {}) {
    const request = parseAddressedSchematicRequest(message, agentName, knownBotPeers);
    if (!request) return false;
    if (request.addressedTo !== agentName) return true;

    if (!trusted) {
        await agent.routeResponse(source, 'Schematic build requests are restricted to configured trusted command senders.');
        return true;
    }
    if (request.error) {
        await agent.routeResponse(source, request.error);
        return true;
    }

    if (agent.blocked_actions?.includes('!buildSchematic') || !commandExists('!buildSchematic')) {
        await agent.routeResponse(source, '!buildSchematic is unavailable or blocked by this agent configuration.');
        return true;
    }

    try {
        await resolveSchematicPath(request.selector);
    } catch (error) {
        await agent.routeResponse(source, `Schematic selector ${request.selector} could not be resolved: ${error.message}`);
        return true;
    }

    agent.self_prompter?.handleUserPromptedCmd(false, true);
    await agent.routeResponse(source, `*${source} requested a schematic build*`);
    const result = await executeCommand(agent, `!buildSchematic("${request.selector}")`);
    if (result) await agent.routeResponse(source, result);
    return true;
}

/** Remove executable command tokens before sending bot output into shared/public chat. */
export function redactCommandFragments(message) {
    return String(message).replace(/!(\w+)(?:\([^\r\n)]*(?:\)|$))?/g, '[command omitted]');
}
