import settings from '../settings.js';
import prismarineViewer from 'prismarine-viewer';
const mineflayerViewer = prismarineViewer.mineflayer;

export function addBrowserViewer(bot, count_id) {
    if (!settings.render_bot_view)
        return;
    // to watch from another machine through a web server's reverse proxy: MINDCRAFT_VIEWER_PREFIX serves it under a
    // path (e.g. /andy-view), MINDCRAFT_VIEWER_HOST=127.0.0.1 keeps it off the network itself, and
    // MINDCRAFT_VIEWER_THIRD_PERSON=1 follows the bot from behind, which is easier to watch than its own eyes
    mineflayerViewer(bot, {
        port: 3000 + count_id,
        firstPerson: process.env.MINDCRAFT_VIEWER_THIRD_PERSON !== '1',
        prefix: process.env.MINDCRAFT_VIEWER_PREFIX || '',
        host: process.env.MINDCRAFT_VIEWER_HOST || undefined,
    });
}