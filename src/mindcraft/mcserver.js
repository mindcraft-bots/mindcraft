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

            const serverInfo = {
                host: ip,
                port,
                name: response?.description?.text || response?.description || 'No description provided.',
                ping: response.latency,
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
    let server = null;
    let serverString = "";
    let serverVersion = "";
    
    // Search for server
    if (port == -1)
    {
        console.log(`No port provided. Searching for LAN server on host ${host}...`);
        
        await findServers(host, true).then((servers) => {
            if (servers.length > 0)
                server = servers[0];
        });

        if (server == null)
            throw new Error(`No server found on LAN.`);
    }
    else
        server = await serverInfo(host, port, 3500, true);

    // Server not found
    if (server == null) 
        throw new Error(`MC server not found. (Host: ${host}, Port: ${port}) Check the host and port in settings.js or config.json, and ensure the server is online.`);

    if (server.version) {
        server.version = resolveJavaVersion(server.version);
    }
    serverString = `(Host: ${server.host}, Port: ${server.port}, Version: ${server.version})`;

    if (version === "auto") 
        serverVersion = server.version;
    else
        serverVersion = resolveJavaVersion(version);

    // Server version check
    const isSupported = mc.supportedVersions.some(v => 
        serverVersion === v || (serverVersion.startsWith(v) && serverVersion.charAt(v.length) === '.')
    );
    if (!isSupported) {
        console.warn(`[mcserver] Server version '${serverVersion}' not in default protocol list. Using compatible Java 1.21.4 for ViaVersion / ViaBackwards.`);
        server.version = '1.21.4';
    } else {
        console.log(`MC server found. ${serverString}`);
    }

    return server;
}
