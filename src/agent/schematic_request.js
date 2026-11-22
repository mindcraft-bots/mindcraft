import { executeCommand, commandExists } from './commands/index.js';
import { resolveSchematicPath } from '../utils/schematic/paths.js';

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function positiveNumber(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0;
}

function stripRequestPunctuation(value) {
    return value.trim().replace(/[,.!?]+$/, '').trimEnd();
}

function scanRequestWords(text) {
    const words = [];
    const quotedSpans = [];
    for (let index = 0; index < text.length;) {
        if (/\s/.test(text[index])) {
            index++;
            continue;
        }
        if (text[index] === '"') {
            const start = index++;
            let closed = false;
            while (index < text.length) {
                if (text[index] === '\\') {
                    if (text[index + 1] !== '"' && text[index + 1] !== '\\') return { words, quotedSpans, invalid: true };
                    index += 2;
                } else if (text[index++] === '"') {
                    closed = true;
                    break;
                }
            }
            if (!closed || (index < text.length && !/[\s,.!?]/.test(text[index]))) {
                return { words, quotedSpans, invalid: true };
            }
            quotedSpans.push([start, index]);
            continue;
        }

        const start = index;
        while (index < text.length && !/\s/.test(text[index]) && text[index] !== '"') index++;
        const raw = text.slice(start, index);
        for (const match of raw.matchAll(/[A-Za-z0-9_]+/g)) {
            words.push({ value: match[0], start: start + match.index, end: start + match.index + match[0].length });
        }
        if (text[index] === '"' && index > start) return { words, quotedSpans, invalid: true };
    }
    return { words, quotedSpans, invalid: false };
}

const SCHEMATIC_WORD = '(?:schema|schem|scheme|schematic)';
const PACK_WORD = '(pack[1-9]\\d*)';
const SAFE_NAME = '([A-Za-z0-9_.-]+)';

function hasSelectorCue(words, text) {
    return words.some((word, index) => {
        const value = word.value.toLowerCase();
        const next = words[index + 1]?.value?.toLowerCase() ?? '';
        const previous = words[index - 1]?.value?.toLowerCase() ?? '';
        if (/^pack[1-9]\d*$/.test(value)) return true;
        if (/^(?:id|offset)$/.test(value)) return true;
        if (value === 'group') return /^\d+$/.test(next) || next === '#';
        if (value === 'file') {
            if (index === 0 || previous === 'using' || previous === 'via' || /^(?:id|offset|name)$/.test(next)) return true;
            if (next && !/^(?:a|an|the)$/.test(previous)) return true;
            const rest = text.slice(word.end);
            return new RegExp(`^\\s*${SAFE_NAME}\\s+of\\s+${PACK_WORD}$`, 'i').test(rest)
                || new RegExp(`^\\s*${PACK_WORD}\\/${SAFE_NAME}$`, 'i').test(rest);
        }
        if (new RegExp(`^${SCHEMATIC_WORD}$`, 'i').test(value)) {
            // A common noun such as “colour scheme” or “database schema” is ordinary chat.
            // An alias is a selector cue only when it starts the selector, is connected to it,
            // or is followed by a recognizable typed target shape.
            const aliasTarget = /^(?:file(?:\s+(?:id|offset|name)\b)?\b|(?:id|offset)\s*(?:#?\s*\d+)?\b|name\b|pack[1-9]\d*(?:\s*\/)?\b|[A-Za-z0-9_.-]+\s+of\s+pack[1-9]\d*)/i.test(text.slice(word.end).trimStart());
            return index === 0 || previous === 'using' || previous === 'via' || aliasTarget;
        }
        return /^\d+$/.test(value) && next === 'from' && words[index + 2]?.value.toLowerCase() === 'group';
    });
}

function selectorAt(text, start) {
    const tail = text.slice(start);
    const alias = `(?:${SCHEMATIC_WORD}\\s+)?`;
    const filenameOf = new RegExp(`^(?:using\\s+|via\\s+)?${alias}(?:(?:file\\s+name|name|file)\\s+)?${SAFE_NAME}\\s+of\\s+${PACK_WORD}$`, 'i').exec(tail);
    const filenameQualified = new RegExp(`^(?:using\\s+|via\\s+)?${alias}(?:(?:file\\s+name|name|file)\\s+)?${PACK_WORD}\\/${SAFE_NAME}$`, 'i').exec(tail);
    if (filenameOf || filenameQualified) {
        const basename = filenameOf?.[1] ?? filenameQualified[2];
        const pack = (filenameOf?.[2] ?? filenameQualified[1]).toLowerCase();
        if (basename === '.' || basename === '..' || /^\d+$/.test(basename)) return null;
        const explicitFilenameForm = /^(?:(?:using|via)\s+)?(?:(?:schema|schem|scheme|schematic)\s+)?(?:file\s+(?:name\s+)?|name\s+)/i.test(tail);
        const filenameAliasForm = /^(?:(?:using|via)\s+)?(?:schema|schem|scheme|schematic)\s+/i.test(tail);
        if (filenameOf && /^(?:id|name)$/i.test(basename) && !explicitFilenameForm && !filenameAliasForm && !/\./.test(basename)) return null;
        return {
            kind: 'filename',
            selectorKind: 'fileName',
            fileName: basename,
            filename: basename,
            selector: `${pack}:${basename}`,
        };
    }

    const numeric = new RegExp(`^(?:using\\s+|via\\s+)?${alias}(?:(?:file\\s+)?(?:id|offset)\\s+#?\\s*(\\d+)|#?\\s*(\\d+))\\s+from\\s+group\\s+#?\\s*(\\d+)\\s+of\\s+${PACK_WORD}$`, 'i').exec(tail);
    if (!numeric) return null;
    const rawFileId = numeric[1] ?? numeric[2];
    const rawGroup = numeric[3];
    const rawPack = numeric[4];
    if (!positiveNumber(rawFileId) || !positiveNumber(rawGroup)) return null;
    const group = Number(rawGroup);
    const fileId = Number(rawFileId);
    return {
        kind: 'id',
        selectorKind: 'fileId',
        group,
        fileId,
        id: fileId,
        selector: `${rawPack.toLowerCase()}:${group}:${fileId}`,
    };
}

/** Parse one anchored selector after an inert description prefix; never recover a partial match. */
function parseSchematicSelector(text, addressedTo) {
    const normalized = stripRequestPunctuation(text);
    const scanned = scanRequestWords(normalized);
    const rawSelectorCue = /\b(?:file\s+(?:id|offset|name)|(?:id|offset)\s+\d+|pack[1-9]\d*|\d+\s+from\s+group)\b/i.test(normalized);
    if (!hasSelectorCue(scanned.words, normalized) && !(scanned.invalid && rawSelectorCue)) return null;

    // Natural-language descriptions are inert, but command/control syntax and controls never enter a target.
    // Quote spans use UTF-16 offsets, so keep the same indexing even after non-BMP text.
    const hasUnquotedBackslash = normalized.split('').some((character, index) => character === '\\'
        && !scanned.quotedSpans.some(([quoteStart, quoteEnd]) => index >= quoteStart && index < quoteEnd));
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029;&|`$<>()[\]{}]|!(?=[A-Za-z0-9_])/i.test(normalized)
        || hasUnquotedBackslash) {
        return { addressedTo, error: 'I could not safely identify that schematic request; command fragments and control characters are not allowed.' };
    }
    if (scanned.invalid) {
        return { addressedTo, error: 'I could not safely identify that schematic request; descriptions may use balanced double quotes only.' };
    }

    const selectorWords = scanned.words.filter((word, index) => /^(?:file|id|offset|schema|schem|scheme|schematic)$/i.test(word.value)
        || (/^\d+$/.test(word.value) && scanned.words[index + 1]?.value.toLowerCase() === 'from'
            && scanned.words[index + 2]?.value.toLowerCase() === 'group'
            && !/^(?:id|offset)$/i.test(scanned.words[index - 1]?.value ?? '')));
    const matches = [];
    for (const word of selectorWords) {
        // Dotted extensions are tokenized into word fragments; words inside a filename
        // (for example the “schem” in “house.schem”) are never selector starts.
        if (word.start > 0 && !/\s/.test(normalized[word.start - 1])) continue;
        const previous = scanned.words.find(candidate => candidate.end <= word.start && normalized.slice(candidate.end, word.start).trim() === '');
        const start = previous && /^(?:using|via)$/i.test(previous.value) ? previous.start : word.start;
        if (scanned.quotedSpans.some(([quoteStart, quoteEnd]) => start >= quoteStart && start < quoteEnd)) continue;
        if (matches.some(match => match.start === start)) continue;
        const parsed = selectorAt(normalized, start);
        if (parsed) matches.push({ ...parsed, start });
    }

    // Alias + explicit file forms are intentionally composable; nested attempts point at
    // the same terminal selector and collapse to one candidate, never to multiple matches.
    const uniqueMatches = matches.filter((match, index) => matches.findIndex(candidate =>
        candidate.kind === match.kind && candidate.selector === match.selector) === index);

    if (uniqueMatches.length !== 1) {
        return {
            addressedTo,
            error: 'I could not safely identify that schematic. Use exactly one filename selector (“file name <filename> of pack1” or “file pack1/<filename>”) or one numeric selector (“file id 01 from group 02 of pack1”); schema, schem, scheme, and schematic are optional selector prefixes.',
        };
    }

    const selected = uniqueMatches[0];
    const description = normalized.slice(0, selected.start);
    const descriptionScan = scanRequestWords(description);
    if (descriptionScan.invalid || hasSelectorCue(descriptionScan.words, description)
        || descriptionScan.words.some(word => /^(?:file|id|offset|group|pack[1-9]\d*|schema|schem|scheme|schematic)$/i.test(word.value))
        || /^\s*\d+\s*$/.test(description)
        || scanned.quotedSpans.some(([, quoteEnd]) => quoteEnd > selected.start)) {
        return {
            addressedTo,
            error: 'I could not safely identify that schematic request; use one selector only, quote reserved words in the description, and use “file id”, “id”, “offset”, or the bare numeric shorthand for an indexed selection.',
        };
    }
    const { start, ...request } = selected;
    return { addressedTo, ...request };
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

/** Recognize only explicitly addressed, typed schematic build requests. */
export function parseAddressedSchematicRequest(message, agentName, knownBotPeers = []) {
    const address = parseChatAddress(message, agentName, knownBotPeers);
    if (!address) return null;
    const { addressedTo } = address;
    const text = address.text.replace(/^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?/i, '');
    if (!/^build\b/i.test(text)) return null;
    const requestText = text.replace(/^build\b/i, '').trim();
    const parsed = parseSchematicSelector(requestText, addressedTo);
    if (!parsed) return null;
    return parsed;
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
        await resolveSchematicPath(request.selector, undefined, { version: agent.bot?.version });
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
