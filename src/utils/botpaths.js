import settings from '../agent/settings.js';

/**
 * World namespace for everything a bot persists (history, memory.db, logs, screenshots, action code).
 *
 * Set `world_name` in settings.js (or the MINDCRAFT_WORLD environment variable) to keep each Minecraft
 * world's bot data apart: with `world_name: "survival1"` the files live in `bots/<bot>/worlds/survival1/`.
 * Empty (default) keeps the legacy layout `bots/<bot>/`, so existing bots keep their data.
 * Use the SAME name you run the topography service with (`--name`).
 */
export function worldName() {
    const raw = globalThis.process?.env?.MINDCRAFT_WORLD ?? settings.world_name ?? '';
    return String(raw).trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 64);
}

/** Directory for one bot's persisted data, relative to the repo root, with a leading `./`. */
export function botDir(name) {
    const world = worldName();
    return world ? `./bots/${name}/worlds/${world}` : `./bots/${name}`;
}
