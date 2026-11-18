import settings from '../settings.js';

export async function addBrowserViewer(bot, count_id) {
    if (!settings.render_bot_view) return;
    try {
        const mod = await import('prismarine-viewer');
        const mineflayerViewer = mod.mineflayer || mod.default?.mineflayer;
        if (typeof mineflayerViewer === 'function') {
            mineflayerViewer(bot, { port: 3000 + count_id, firstPerson: true });
        }
    } catch (err) {
        console.warn('[Viewer] Could not start browser viewer:', err?.message || err);
    }
}