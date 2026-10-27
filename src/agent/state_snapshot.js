import { getFullState } from './library/full_state.js';
import { getNearbyBlockTypes } from './library/world.js';

const MAX_LIST_ITEMS = 24;

export function buildStateSnapshotDiff(agent) {
    if (!agent || !agent.bot?.entity?.position || !agent.bot?.inventory || !agent.bot?.world) return null;

    let snapshot;
    try {
        snapshot = normalizeSnapshot(agent);
    } catch (err) {
        console.warn('Could not build state snapshot diff:', err?.message || err);
        return null;
    }

    if (!snapshot) return null;

    const previous = agent._lastStateSnapshot || null;
    agent._lastStateSnapshot = snapshot;

    if (!previous) {
        return formatInitialSnapshot(snapshot);
    }

    const lines = [];
    appendScalarDiff(lines, 'position', previous.position, snapshot.position);
    appendScalarDiff(lines, 'dimension', previous.dimension, snapshot.dimension);
    appendScalarDiff(lines, 'biome', previous.biome, snapshot.biome);
    appendScalarDiff(lines, 'time', previous.time, snapshot.time);
    appendScalarDiff(lines, 'weather', previous.weather, snapshot.weather);
    appendScalarDiff(lines, 'health', previous.health, snapshot.health);
    appendScalarDiff(lines, 'hunger', previous.hunger, snapshot.hunger);
    appendScalarDiff(lines, 'action', previous.action, snapshot.action);
    appendMapDiff(lines, 'inventory', previous.inventory, snapshot.inventory);
    appendMapDiff(lines, 'equipment', previous.equipment, snapshot.equipment);
    appendListDiff(lines, 'nearby blocks', previous.nearbyBlocks, snapshot.nearbyBlocks);
    appendListDiff(lines, 'nearby entities', previous.nearbyEntities, snapshot.nearbyEntities);
    appendListDiff(lines, 'nearby players', previous.nearbyPlayers, snapshot.nearbyPlayers);

    if (!lines.length) return null;
    return `State update:\n${lines.join('\n')}`;
}

function normalizeSnapshot(agent) {
    const state = getFullState(agent);
    const nearbyBlocks = safeArray(() => getNearbyBlockTypes(agent.bot, 16));
    return {
        position: formatPosition(state.gameplay?.position),
        dimension: state.gameplay?.dimension || '',
        biome: state.gameplay?.biome || '',
        time: state.gameplay?.timeLabel || '',
        weather: state.gameplay?.weather || '',
        health: `${state.gameplay?.health ?? '?'} / 20`,
        hunger: `${state.gameplay?.hunger ?? '?'} / 20`,
        action: state.action?.current || 'Idle',
        inventory: normalizeMap(state.inventory?.counts || {}),
        equipment: normalizeMap(state.inventory?.equipment || {}),
        nearbyBlocks: normalizeList(nearbyBlocks),
        nearbyEntities: normalizeList(state.nearby?.entityTypes || []),
        nearbyPlayers: normalizeList([...(state.nearby?.humanPlayers || []), ...(state.nearby?.botPlayers || [])])
    };
}

function formatInitialSnapshot(snapshot) {
    const lines = [
        `* position: ${snapshot.position}`,
        `* dimension: ${snapshot.dimension}`,
        `* biome: ${snapshot.biome}`,
        `* time/weather: ${snapshot.time}, ${snapshot.weather}`,
        `* health/hunger: ${snapshot.health}, ${snapshot.hunger}`,
        `* action: ${snapshot.action}`,
        `* inventory: ${formatMap(snapshot.inventory) || 'empty'}`,
        `* equipment: ${formatMap(snapshot.equipment) || 'none'}`,
        `* nearby blocks: ${formatList(snapshot.nearbyBlocks) || 'none'}`,
        `* nearby entities: ${formatList(snapshot.nearbyEntities) || 'none'}`,
        `* nearby players: ${formatList(snapshot.nearbyPlayers) || 'none'}`
    ];
    return `State update:\n${lines.join('\n')}`;
}

function appendScalarDiff(lines, label, before, after) {
    if (before !== after) lines.push(`* ${label}: ${before || 'none'} -> ${after || 'none'}`);
}

function appendMapDiff(lines, label, before, after) {
    const beforeKeys = Object.keys(before || {});
    const afterKeys = Object.keys(after || {});
    const allKeys = [...new Set([...beforeKeys, ...afterKeys])].sort();
    const changes = [];
    for (const key of allKeys) {
        const oldValue = before?.[key];
        const newValue = after?.[key];
        if (oldValue === newValue) continue;
        if (oldValue == null || oldValue === 0 || oldValue === '') changes.push(`+${key}:${newValue}`);
        else if (newValue == null || newValue === 0 || newValue === '') changes.push(`-${key}:${oldValue}`);
        else changes.push(`${key}:${oldValue}->${newValue}`);
    }
    if (changes.length) lines.push(`* ${label}: ${changes.slice(0, MAX_LIST_ITEMS).join(', ')}${changes.length > MAX_LIST_ITEMS ? ', ...' : ''}`);
}

function appendListDiff(lines, label, before, after) {
    const beforeSet = new Set(before || []);
    const afterSet = new Set(after || []);
    const added = [...afterSet].filter(item => !beforeSet.has(item)).sort();
    const removed = [...beforeSet].filter(item => !afterSet.has(item)).sort();
    if (!added.length && !removed.length) return;
    const parts = [];
    if (added.length) parts.push(`+ ${added.slice(0, MAX_LIST_ITEMS).join(', ')}${added.length > MAX_LIST_ITEMS ? ', ...' : ''}`);
    if (removed.length) parts.push(`- ${removed.slice(0, MAX_LIST_ITEMS).join(', ')}${removed.length > MAX_LIST_ITEMS ? ', ...' : ''}`);
    lines.push(`* ${label}: ${parts.join('; ')}`);
}

function normalizeMap(map) {
    return Object.fromEntries(
        Object.entries(map || {})
            .filter(([, value]) => value != null && value !== 0 && value !== '')
            .sort(([a], [b]) => a.localeCompare(b))
    );
}

function normalizeList(items) {
    return [...new Set((items || []).filter(Boolean).map(String))].sort();
}

function formatMap(map) {
    const entries = Object.entries(map || {});
    return entries.slice(0, MAX_LIST_ITEMS).map(([key, value]) => `${key}:${value}`).join(', ') + (entries.length > MAX_LIST_ITEMS ? ', ...' : '');
}

function formatList(items) {
    return (items || []).slice(0, MAX_LIST_ITEMS).join(', ') + ((items || []).length > MAX_LIST_ITEMS ? ', ...' : '');
}

function formatPosition(position) {
    if (!position) return 'unknown';
    return `${formatCoord(position.x)}, ${formatCoord(position.y)}, ${formatCoord(position.z)}`;
}

function formatCoord(value) {
    const num = Number(value);
    return Number.isFinite(num) ? String(Math.round(num)) : 'unknown';
}

function safeArray(fn) {
    try {
        const value = fn();
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}
