import { executeCommand, commandExists } from './commands/index.js';
import { resolveSchematicPath, conservativeBotVersion } from '../utils/schematic/paths.js';
import settings from './settings.js';
import { resolvePlacementOptions } from '../utils/schematic/placement_options.js';

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

function numericSelectorStart(words, index) {
    if (!/^\d+$/.test(words[index].value) || words[index + 1]?.value.toLowerCase() !== 'from') return false;
    const afterFrom = words[index + 2]?.value.toLowerCase() ?? '';
    return afterFrom === 'group' || (/^\d+$/.test(afterFrom) && words[index + 3]?.value.toLowerCase() === 'group');
}

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
        // Recognize a malformed bare group-before-word target as selector intent too,
        // even if its pack label is invalid, so it cannot fall back to inference.
        return numericSelectorStart(words, index) || (/^\d+$/.test(value)
            && /^\d+\s+from\s+\S+\s+group\b/i.test(text.slice(word.start)));
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

    const numeric = new RegExp(`^(?:using\\s+|via\\s+)?${alias}(?:(?:file\\s+)?(?:id|offset)\\s+#?\\s*(\\d+)|#?\\s*(\\d+))\\s+from\\s+(?:group\\s+#?\\s*(\\d+)|#?\\s*(\\d+)\\s+group)\\s+of\\s+${PACK_WORD}(\\s+instead\\s+of\\s+this\\s+unfinished\\s+building)?$`, 'i').exec(tail);
    if (!numeric) return null;
    const rawFileId = numeric[1] ?? numeric[2];
    const rawGroup = numeric[3] ?? numeric[4];
    const rawPack = numeric[5];
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
        ...(numeric[6] ? { inertReplacementPhrase: true } : {}),
    };
}

function hasReplacementIntent(text) {
    // Match actions/relations aimed at an existing structure or an explicit referent,
    // not building nouns alone, material alternatives ("oak instead of birch"), or
    // words such as "replacement" in a shop description. Quotes do not waive safety.
    const structure = '(?:buildings?|barns?|houses?|structures?|homes?|cottages?|cabins?|castles?|huts?|towers?|sheds?|walls?|roofs?|ruins?|bases?)\\b';
    const existing = '(?:old|existing|unfinished|current|abandoned|partially\\s+built)\\b';
    const target = `(?:(?:this|that|these|those|it|them)\\b|(?:(?:the|an?|my|our|your|their)\\s+)?(?:${existing}|${structure})|(?:the|an?|my|our|your|their)\\s+(?:[a-z-]+\\s+)+?${structure})`;
    const relation = '(?:instead\\s+of|rather\\s+than|in\\s+place\\s+of|(?:as\\s+)?(?:a\\s+)?replacement\\s+(?:for|of)|demolition\\s+of)';
    // Spatial descriptions alone ("a tower on top of a cottage") are not replacement.
    const existingTarget = `(?:(?:this|that|these|those|it|them)\\b|(?:(?:the|my|our|your|their)\\s+)?${existing})`;
    const overlay = `(?:on\\s+top\\s+of|(?:build(?:ing)?\\s+)?over)\\s+${existingTarget}`;
    const takeDown = '(?:tear(?:ing)?|knock(?:ing)?|tak(?:e|ing)|pull(?:ing)?)';
    const action = `(?:replac(?:e|es|ing)|rebuild(?:s|ing)?|demolish(?:es|ing)?|destroy(?:s|ing)?|remov(?:e|es|ing)|raz(?:e|es|ing)|clear(?:s|ing)?(?:\\s+away)?|overwrit(?:e|es|ing)|get(?:ting)?\\s+rid\\s+of|${takeDown}\\s+down)`;
    // A filename is data even without a selector cue. Do not turn its separators
    // into a prose instruction; retain a placeholder so surrounding words cannot join.
    const prose = text.replace(/\S+\.(?:schem|schematic|litematic|nbt)(?=$|[\s"'.,!?])/gi, ' filename ')
        .replace(/[^A-Za-z0-9_]+/g, ' ');
    return new RegExp(`\\b(?:${relation}|${action})\\s+${target}|\\b${overlay}|\\b${takeDown}\\s+${target}(?:\\s+[a-z]+)*?\\s+down\\b`, 'i').test(prose);
}

/** Parse one anchored selector after an inert description prefix; never recover a partial match. */
function parseSchematicSelector(text, addressedTo, { replacementOnly = false } = {}) {
    const normalized = stripRequestPunctuation(text);
    const scanned = scanRequestWords(normalized);
    const rawSelectorCue = /\b(?:file\s+(?:id|offset|name)|(?:id|offset)\s+\d+|pack[1-9]\d*|\d+\s+from\s+(?:group|\S+\s+group))\b/i.test(normalized);
    // Explicit unsupported intent must be refused even without a schematic selector.
    // Still leave benign descriptions and ordinary conversation outside this route.
    if (!hasSelectorCue(scanned.words, normalized) && !(scanned.invalid && rawSelectorCue)
        && !hasReplacementIntent(normalized)) return null;

    // Natural-language descriptions are inert, but command/control syntax and controls never enter a target.
    // Quote spans use UTF-16 offsets, so keep the same indexing even after non-BMP text.
    const hasUnquotedBackslash = normalized.split('').some((character, index) => character === '\\'
        && !scanned.quotedSpans.some(([quoteStart, quoteEnd]) => index >= quoteStart && index < quoteEnd));
    // eslint-disable-next-line no-control-regex -- reject control characters in human requests.
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029;&|`$<>()[\]{}]|!(?=[A-Za-z0-9_])/i.test(normalized)
        || hasUnquotedBackslash) {
        return { addressedTo, error: 'I could not safely identify that schematic request; command fragments and control characters are not allowed.' };
    }
    if (scanned.invalid) {
        return { addressedTo, error: 'I could not safely identify that schematic request; descriptions may use balanced double quotes only.' };
    }

    const selectorWords = scanned.words.filter((word, index) => /^(?:file|id|offset|schema|schem|scheme|schematic)$/i.test(word.value)
        || (numericSelectorStart(scanned.words, index)
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

    // Valid selectors contain identifiers, not prose: inspect only their description.
    // This also leaves the intentionally supported exact numeric trailing phrase inert,
    // without allowing it to exempt any replacement intent in the prefix. For invalid
    // requests inspect the whole text for a useful explanation; never recover a selector.
    const intentText = uniqueMatches.length === 1 ? normalized.slice(0, uniqueMatches[0].start) : normalized;
    if (hasReplacementIntent(intentText)) {
        return {
            addressedTo,
            error: 'I cannot replace an existing building or demolish it. A bare selector starts an ordinary nearby build, not a replacement.',
        };
    }

    // Non-build directives are recognized only to refuse targeted replacement intent.
    // In particular a literal selector filename must never make them start a build.
    if (replacementOnly) return null;

    if (uniqueMatches.length !== 1) {
        return {
            addressedTo,
            error: 'I could not safely identify that schematic. Use exactly one filename selector (“file name <filename> of pack1” or “file pack1/<filename>”) or one numeric selector (“file id 01 from group 02 of pack1” or “file id 01 from 02 group of pack1”); schema, schem, scheme, and schematic are optional selector prefixes.',
        };
    }

    const selected = uniqueMatches[0];
    const description = normalized.slice(0, selected.start);
    const descriptionScan = scanRequestWords(description);
    const unquotedDescription = description.split('').map((character, index) =>
        descriptionScan.quotedSpans.some(([start, end]) => index >= start && index < end) ? ' ' : character).join('');
    // Descriptions remain inert, but a recognizable direction instruction here
    // must not silently disappear or conflict with a terminal orientation.
    if (/\b(?:facing|oriented|rotate|rotated|rotating)\s+(?:it\s+)?(?:(?:to|towards)\s+)?(?:face\s+)?(?:north|east|south|west|n|e|s|w|northeast|northwest|southeast|southwest)\b/i.test(unquotedDescription)) {
        return { addressedTo, error: 'Put exactly one orientation clause after the complete schematic selector; no build was started.' };
    }
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

/** Recognize addressed typed builds and refuse explicit unsupported replacement requests. */
export function parseAddressedSchematicRequest(message, agentName, knownBotPeers = []) {
    const address = parseChatAddress(message, agentName, knownBotPeers);
    if (!address) return null;
    const { addressedTo } = address;
    const text = address.text.replace(/^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?/i, '');
    const build = /^build\b/i.test(text);
    // Anchoring keeps questions/discussion about replacement out of deterministic routing.
    // Only imperative openings are refusal-only aliases; noun-led discussion is chat.
    if (!build && !/^(?:replace|rebuild|demolish|destroy|remove|raze|clear|overwrite|tear|knock|take|pull|get\s+rid\s+of)\b/i.test(text)) return null;
    let requestText = (build ? text.replace(/^build\b/i, '') : text).trim();
    const normalized = stripRequestPunctuation(requestText);
    requestText = normalized;
    const scan = scanRequestWords(normalized);
    const overrides = {};
    let suffixCount = 0;
    // Peel only complete, unquoted terminal clauses. The remainder must still be
    // exactly one complete selector; malformed or extra tails cannot be recovered.
    while (build && !scan.invalid) {
        const modeSuffix = /\s+(?:using|via)\s+(delicate|raise|balanced|destructive)\s+mode((?:\s+(?:(?:radius|threshold|step|bisect_depth)=\d+|strategy=(?:all|stepped|bisect)|policy=(?:first_valid|exhaustive)))*)$/i.exec(requestText);
        const orientationSuffix = /\s+(?:(?:and|then)\s+)?(?:facing|oriented|rotate|rotated|rotating)\s+(?:it\s+)?(?:(?:to|towards)\s+)?(?:face\s+)?(north|east|south|west|n|e|s|w)$/i.exec(requestText);
        const suffix = modeSuffix || orientationSuffix;
        if (!suffix || scan.quotedSpans.some(([start, end]) => suffix.index >= start && suffix.index < end)) break;
        if (modeSuffix) {
            if (Object.hasOwn(overrides, 'mode')) return { addressedTo, error: 'Duplicate placement mode; no build was started.' };
            overrides.mode = modeSuffix[1].toLowerCase();
            for (const token of modeSuffix[2].trim().split(/\s+/).filter(Boolean)) {
                const [rawKey, value] = token.split('=');
                const normalizedKey = rawKey.toLowerCase();
                const key = normalizedKey === 'bisect_depth' ? 'bisectDepth' : normalizedKey;
                if (Object.hasOwn(overrides, key)) return { addressedTo, error: `Duplicate ${key} placement option; no build was started.` };
                overrides[key] = ['strategy', 'policy'].includes(key) ? value : Number(value);
            }
        } else {
            if (Object.hasOwn(overrides, 'orientation')) return { addressedTo, error: 'Duplicate orientation; no build was started.' };
            overrides.orientation = orientationSuffix[1];
        }
        suffixCount++;
        requestText = requestText.slice(0, suffix.index);
    }
    // Inspect the complete input before removing any suffix, including controls
    // that might otherwise disappear with a clause.
    // eslint-disable-next-line no-control-regex -- reject control characters before suffix extraction.
    if (suffixCount && /[\u0000-\u001f\u007f-\u009f\u2028\u2029;&|`$<>()[\]{}]|!(?=[A-Za-z0-9_])/i.test(normalized))
        return { addressedTo, error: 'I could not safely identify that schematic request; command fragments and control characters are not allowed.' };
    if (!suffixCount) requestText = normalized;
    const baseScan = scanRequestWords(requestText);
    const unquotedBase = requestText.split('').map((character, index) =>
        baseScan.quotedSpans.some(([start, end]) => index >= start && index < end) ? ' ' : character).join('');
    if (build && (/\b(?:using|via)\s+(?:delicate|raise|destructive|balanced)\b/i.test(unquotedBase)
        || /\b(?:using|via)\s+\S+\s+mode\b/i.test(unquotedBase)
        || /\b(?:radius|threshold|strategy|step|policy|bisect_depth)\s*=/i.test(unquotedBase)))
        return { addressedTo, error: 'Malformed or duplicate placement mode/options; no build was started.' };
    const parsed = parseSchematicSelector(requestText, addressedTo, { replacementOnly: !build });
    if (!parsed) {
        if (build && scan.words.some((word, index) => /^(?:using|via)$/i.test(word.value)
            && /^(?:delicate|raise|destructive|balanced|\w+)$/i.test(scan.words[index + 1]?.value ?? '')
            && /^mode$/i.test(scan.words[index + 2]?.value ?? '')))
            return { addressedTo, error: 'A placement mode requires exactly one valid schematic selector.' };
        return null;
    }
    if (build && suffixCount && !parsed.error) {
        try { resolvePlacementOptions({}, overrides); }
        catch (error) { return { addressedTo, error: `${error.message}; no build was started.` }; }
        return { ...parsed, placementOverrides: overrides };
    }
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
    checkBuild = () => null,
    executeBuild = executeCommand,
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

    const override = request.placementOverrides;
    const args = override ? [request.selector, null, null, null, override.mode ?? null, override.radius ?? null, override.threshold ?? null, override.orientation ?? null, override.strategy ?? null, override.step ?? null, override.policy ?? null, override.bisectDepth ?? null] : [request.selector];
    const command = `!buildSchematic(${args.map(value => JSON.stringify(value)).join(', ')})`;
    const refusal = checkBuild(command);
    if (refusal) {
        await agent.routeResponse(source, refusal);
        return true;
    }

    try {
        await resolveSchematicPath(request.selector, undefined, { version: conservativeBotVersion(agent.bot), allowNonvalidatedSchematic: settings.allow_nonvalidated_schematic_builds === true, requireStrictSchematicValidation: settings.require_strict_schematic_validation === true });
    } catch (error) {
        await agent.routeResponse(source, `Schematic selector ${request.selector} could not be resolved: ${error.message}`);
        return true;
    }

    const changedRefusal = checkBuild(command);
    if (changedRefusal) {
        await agent.routeResponse(source, changedRefusal);
        return true;
    }

    if (request.inertReplacementPhrase) {
        await agent.routeResponse(source, 'The trailing phrase does not remove or replace the unfinished building. The schematic uses normal nearby placement and build safety checks.');
    }
    agent.self_prompter?.handleUserPromptedCmd(false, true);
    await agent.routeResponse(source, `*${source} requested a schematic build*`);
    const result = await executeBuild(agent, command);
    if (result) await agent.routeResponse(source, result);
    return true;
}

/** Remove executable command tokens before sending bot output into shared/public chat. */
export function redactCommandFragments(message) {
    return String(message).replace(/!(\w+)(?:\([^\r\n)]*(?:\)|$))?/g, '[command omitted]');
}
