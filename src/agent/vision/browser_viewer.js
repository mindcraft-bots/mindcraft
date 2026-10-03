import settings from '../settings.js';
import http from 'http';
import prismarineViewer from 'prismarine-viewer';
const mineflayerViewer = prismarineViewer.mineflayer;

export function addBrowserViewer(bot, count_id) {
    if (!settings.render_bot_view) return;
    const port = 3000 + count_id;

    const fail = (err) => {
        console.warn(`prismarine-viewer failed on port ${port}: ${err.message}. Continuing without viewer.`);
    };

    // mineflayerViewer creates its own http server and never exposes it, so a
    // listen failure (e.g. EADDRINUSE) surfaces as an unhandled 'error' event
    // that kills the process. Hook createServer just long enough to attach an
    // error listener to that server.
    const origCreateServer = http.createServer;
    http.createServer = (...args) => {
        const server = origCreateServer(...args);
        server.on('error', fail);
        return server;
    };
    try {
        mineflayerViewer(bot, { port, firstPerson: true });
    } catch (err) {
        fail(err);
    } finally {
        http.createServer = origCreateServer;
    }
}
