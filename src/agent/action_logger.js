import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import settings from '../../settings.js';

const ACTION_LOG_STATE = Symbol.for('mindcraft.actionLogState');
const ACTION_LOG_DEPTH = Symbol.for('mindcraft.actionLogDepth');

export function isActionLoggingEnabled() {
    return Boolean(settings.action_logging ?? settings.action_logging_enabled ?? false);
}

function timestampForFilename(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}

function safeName(name, fallback = 'andy') {
    return String(name || fallback).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getBotLogDirectory(bot) {
    const botName = safeName(bot?.username || bot?.name);
    return path.join('.', 'bots', botName, 'logs');
}

function getActionLogPath(bot) {
    if (!bot[ACTION_LOG_STATE]) {
        const logDir = getBotLogDirectory(bot);
        mkdirSync(logDir, { recursive: true });
        const logPath = path.resolve(logDir, `log_${timestampForFilename()}.txt`);
        writeFileSync(logPath, '', 'utf8');
        bot[ACTION_LOG_STATE] = { logPath };
    }
    return bot[ACTION_LOG_STATE].logPath;
}

function blockCoord(coord) {
    if (!coord) return null;
    return {
        x: Math.floor(coord.x),
        y: Math.floor(coord.y),
        z: Math.floor(coord.z),
    };
}

function entityPosition(bot) {
    const pos = bot?.entity?.position;
    if (!pos) return null;
    return { x: pos.x, y: pos.y, z: pos.z };
}

function standingState(bot) {
    const pos = bot?.entity?.position;
    if (!pos) {
        return { position: null, blockName: 'unknown' };
    }
    const standing = {
        x: Math.floor(pos.x),
        y: Math.floor(pos.y - 0.01),
        z: Math.floor(pos.z),
    };
    const blockName = blockNameAt(bot, standing);
    return { position: standing, blockName };
}

function blockNameAt(bot, coord) {
    if (!bot || !coord) return 'unknown';
    try {
        const pos = {
            x: Math.floor(coord.x),
            y: Math.floor(coord.y),
            z: Math.floor(coord.z),
        };
        pos.floor = () => pos;
        pos.floored = () => pos;
        const block = bot.blockAt(pos);
        return block?.name || 'unknown';
    } catch (_) {
        return 'unknown';
    }
}

function heldItemName(bot) {
    return bot?.heldItem?.name || 'none';
}

function getSneakState(bot) {
    if (typeof bot?.getControlState === 'function') {
        return Boolean(bot.getControlState('sneak'));
    }
    return Boolean(bot?.controlState?.sneak);
}

function getBotTick(bot) {
    const candidates = [bot?.time?.age, bot?.time?.time, bot?.time?.timeOfDay];
    return candidates.find(value => Number.isFinite(value)) ?? 'unknown';
}

function radToDeg(radians) {
    return radians * 180 / Math.PI;
}

function actualYawDegrees(bot) {
    return Number.isFinite(bot?.entity?.yaw) ? radToDeg(bot.entity.yaw) : null;
}

function actualPitchDegrees(bot) {
    return Number.isFinite(bot?.entity?.pitch) ? radToDeg(bot.entity.pitch) : null;
}

function actionValue(value) {
    if (value === null || value === undefined || value === '') return 'unknown';
    return String(value).replace(/\s+/g, '_');
}

function intCoordText(coord) {
    if (!coord) return 'unknown';
    return `[${Math.floor(coord.x)},${Math.floor(coord.y)},${Math.floor(coord.z)}]`;
}

function floatText(value, precision = 6) {
    return Number.isFinite(value) ? Number(value).toFixed(precision) : 'unknown';
}

function floatCoordText(coord, precision = 6) {
    if (!coord) return 'unknown';
    return `[${floatText(coord.x, precision)},${floatText(coord.y, precision)},${floatText(coord.z, precision)}]`;
}

function actionNumber(value, precision = 3) {
    return Number.isFinite(value) ? Number(value).toFixed(precision) : 'unknown';
}

function coordArray(coord) {
    if (!coord || !Number.isFinite(coord.x) || !Number.isFinite(coord.y) || !Number.isFinite(coord.z)) {
        return null;
    }
    return [coord.x, coord.y, coord.z];
}

function serializeArg(value, seen = new Set(), depth = 0) {
    if (value === undefined) return 'undefined';
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (depth > 2) return '[Object]';
    if (Array.isArray(value)) {
        return value.map(item => serializeArg(item, seen, depth + 1));
    }
    if (typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        if (value.name && value.position) {
            return {
                name: value.name,
                position: coordArray(value.position),
            };
        }
        if (Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) {
            return coordArray(value);
        }

        seen.add(value);
        const result = {};
        for (const key of Object.keys(value).sort()) {
            const item = value[key];
            if (typeof item === 'function') continue;
            result[key] = serializeArg(item, seen, depth + 1);
        }
        seen.delete(value);
        return result;
    }
    return String(value);
}

function serializeArgs(args) {
    return JSON.stringify(args.slice(1).map(value => serializeArg(value)));
}

export function formatActionLogLine(record) {
    return [
        'ACTION',
        `function=${actionValue(record.functionName)}`,
        `args=${actionValue(record.args)}`,
        `status=${actionValue(record.status)}`,
        `item=${actionValue(record.item)}`,
        `result_block=${actionValue(record.resultBlock)}`,
        `result_coord=${intCoordText(record.resultCoord)}`,
        `clicked_block=${intCoordText(record.clickedBlock)}`,
        `clicked_face=${actionValue(record.clickedFace)}`,
        `player_pos=${floatCoordText(record.playerPos, 6)}`,
        `yaw=${actionNumber(record.yaw, 3)}`,
        `pitch=${actionNumber(record.pitch, 3)}`,
        `sneaking=${record.sneaking === null || record.sneaking === undefined ? 'unknown' : String(Boolean(record.sneaking))}`,
        `standing_on=${intCoordText(record.standingOn)}`,
        `standing_on_block=${actionValue(record.standingOnBlock)}`,
        `hand=${actionValue(record.hand)}`,
        `tick=${actionValue(record.tick)}`,
        `timestamp=${actionValue(record.timestamp)}`,
    ].join(' ');
}

function appendActionInvocationLog(bot, functionName, args, result, metadataAdapter) {
    try {
        const metadata = metadataAdapter?.(args, result) || {};
        const standing = standingState(bot);
        const resultCoord = blockCoord(metadata.resultCoord);
        const record = {
            functionName,
            args: serializeArgs(args),
            status: 'success',
            item: metadata.item || heldItemName(bot),
            resultBlock: metadata.resultBlock ?? blockNameAt(bot, resultCoord),
            resultCoord,
            clickedBlock: blockCoord(metadata.clickedBlock),
            clickedFace: metadata.clickedFace,
            playerPos: entityPosition(bot),
            yaw: actualYawDegrees(bot),
            pitch: actualPitchDegrees(bot),
            sneaking: getSneakState(bot),
            standingOn: standing.position,
            standingOnBlock: standing.blockName,
            hand: metadata.hand || 'main_hand',
            tick: getBotTick(bot),
            timestamp: new Date().toISOString(),
        };
        appendFileSync(getActionLogPath(bot), `${formatActionLogLine(record)}\n`, 'utf8');
        return true;
    } catch (error) {
        console.warn(`Failed to append action log: ${error.message}`);
        return false;
    }
}

export function withActionLogging(functionName, actionFunction, metadataAdapter = null) {
    const wrappedActionFunction = async function(...args) {
        const bot = args[0];
        if (!bot || !isActionLoggingEnabled()) {
            return await actionFunction(...args);
        }

        const depth = bot[ACTION_LOG_DEPTH] || 0;
        bot[ACTION_LOG_DEPTH] = depth + 1;

        let result;
        try {
            result = await actionFunction(...args);
        } finally {
            bot[ACTION_LOG_DEPTH] = depth;
        }

        if (depth === 0 && result !== false) {
            appendActionInvocationLog(bot, functionName, args, result, metadataAdapter);
        }

        return result;
    };

    Object.defineProperty(wrappedActionFunction, 'name', { value: functionName, configurable: true });
    wrappedActionFunction.toString = () => actionFunction.toString();
    return wrappedActionFunction;
}
