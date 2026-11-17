import settings from '../settings.js';

export async function addBrowserViewer(bot, count_id) {
    if (!settings.render_bot_view) return;
    try {
        const prismarineViewer = (await import('prismarine-viewer')).default;
        const mineflayerViewer = prismarineViewer.mineflayer;
        mineflayerViewer(bot, { port: 3000 + count_id, firstPerson: true });
    } catch (err) {
        console.warn('[Viewer] Could not start browser viewer:', err?.message || err);
    }
}