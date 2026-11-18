import net from 'net';
import mc from 'minecraft-protocol';
import { resolveJavaVersion } from '../utils/version_patch.js';

/**
 * Scans the IP address for Minecraft LAN servers and collects their info.
 * @param {string} ip - The IP address to scan.
 * @param {number} port - The port to check.
 * @param {number} timeout - The connection timeout in ms.
 * @param {boolean} verbose - Whether to print output on connection errors.
 * @returns {Promise<Array>} - A Promise that resolves to an array of server info objects.
 */
export async function serverInfo(ip, port, timeout = 3500, verbose = false) {
    return new Promise((resolve) => {

        let timeoutId = setTimeout(() => {
            if (verbose)
                console.error(`Timeout pinging server ${ip}:${port}`);
            resolve(null); // Resolve as null if no response within timeout
        }, timeout);

        mc.ping({
            host: ip,
            port
        }, (err, response) => {
            clearTimeout(timeoutId);

            if (err) {
                if (verbose)
                    console.error(`Error pinging server ${ip}:${port}`, err);
                return resolve(null);
            }

            // extract version number from modded servers like "Paper 1.21.4"
            const version = response?.version?.name || '';
            const match = String(version).match(/\d+\.\d+(?:\.\d+)?/);
            let numericVersion = match ? match[0] : null;
            if (numericVersion) {
                const resolved = resolveJavaVersion(numericVersion);
                if (resolved !== numericVersion) {
                    console.log(`[mcserver] Server reported version '${version}' (${numericVersion}). Using compatible Java version '${resolved}' (compatible with ViaVersion / ViaBackwards / Geyser).`);
                    numericVersion = resolved;
                } else if (numericVersion !== version) {
                    console.log(`Modded server found (${version}), attempting to use ${numericVersion}...`);
                }
            }

            let descText = 'No description provided.';
            if (typeof response?.description === 'string') {
                descText = response.description;
            } else if (response?.description?.text) {
                descText = response.description.text;
            } else if (Array.isArray(response?.description?.extra)) {
                descText = response.description.extra.map(e => e.text || '').join('');
            }

            const serverInfo = {
                host: ip,
                port,
                name: descText,
                ping: response?.latency || 0,
                version: numericVersion
            };

            resolve(serverInfo);
        });
    });
}

/**
 * Scans the IP address for Minecraft LAN servers and collects their info.
 * @param {string} ip - The IP address to scan.
 * @param {boolean} earlyExit - Whether to exit early after finding a server.
 * @param {number} timeout - The connection timeout in ms.
 * @returns {Promise<Array>} - A Promise that resolves to an array of server info objects.
 */
export async function findServers(ip, earlyExit = false, timeout = 100) {
    const servers = [];
    const startPort = 49000;
    const endPort = 65000;

    const checkPort = (port) => {
        return new Promise((resolve) => {
            const socket = net.createConnection({ host: ip, port, timeout }, () => {
                socket.end();
                resolve(port); // Port is open
            });

            socket.on('error', () => resolve(null)); // Port is closed
            socket.on('timeout', () => {
                socket.destroy();
                resolve(null);
            });
        });
    };

    // This supresses a lot of annoying console output from the mc library
    // TODO: find a better way to do this, it supresses other useful output
    const originalConsoleLog = console.log;
    console.log = () => { };
    
    for (let port = startPort; port <= endPort; port++) {
        const openPort = await checkPort(port);
        if (openPort) {
            const server = await serverInfo(ip, port, 200, false);
            if (server) {
                servers.push(server);

                if (earlyExit) break;
            }
        }
    }

    // Restore console output
    console.log = originalConsoleLog;

    return servers;
}

/**
 * Gets the MC server info from the host and port.
 * @param {string} host - The host to search for.
 * @param {number} port - The port to search for.
 * @param {string} version - The version to search for.
 * @returns {Promise<Object>} - A Promise that resolves to the server info object.
 */
export async function getServer(host, port, version) {
    if (typeof host === 'string' && host.includes(':') && !host.startsWith('http')) {
        const parts = host.split(':');
        host = parts[0];
        const parsedPort = parseInt(parts[1], 10);
        if (!isNaN(parsedPort)) port = parsedPort;
    }

    let server = null;
    let serverString = "";
    let serverVersion = "";
    
    const isLocal = host === 'localhost' || host === '127.0.0.1';

    // Search for server
    if (!isLocal && (port === 55916 || port == -1 || !port || port <= 0 || port >= 65536)) {
        console.log(`[mcserver] Remote host ${host} detected. Using standard port 25565.`);
        port = 25565;
        server = await serverInfo(host, port, 3500, false);
    } else if (port == -1) {
        if (isLocal) {
            console.log(`No port provided. Searching for LAN server on host ${host}...`);
            
            await findServers(host, true).then((servers) => {
                if (servers.length > 0)
                    server = servers[0];
            });

            if (server == null)
                throw new Error(`No server found on LAN.`);
        } else {
            console.log(`No port provided for remote host ${host}. Defaulting to port 25565.`);
            port = 25565;
            server = await serverInfo(host, port, 3500, false);
        }
    } else {
        server = await serverInfo(host, port, 3500, false);
    }

    // If ping fails or times out (common for reverse proxies like Aternos/Bungee/Geyser), proceed directly
    if (server == null) {
        console.log(`[mcserver] Direct ping to ${host}:${port} did not return status (common for proxies like Aternos / BungeeCord). Proceeding with direct connection.`);
        server = {
            host,
            port,
            version: resolveJavaVersion(version)
        };
    }

    server.version = resolveJavaVersion(server.version || version);
    if (!server.port || server.port <= 0 || server.port >= 65536) {
        server.port = isLocal ? 55916 : 25565;
    }
    serverString = `(Host: ${server.host}, Port: ${server.port}, Version: ${server.version})`;

    if (version === "auto" || !version) 
        serverVersion = server.version;
    else
        serverVersion = resolveJavaVersion(version);

    console.log(`MC server target ready. ${serverString}`);
    return server;
}
