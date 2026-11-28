// Replace only the launcher boundary; main.js and settings/profile parsing stay real.
export function resolve(specifier, context, nextResolve) {
    if (specifier === './src/mindcraft/mindcraft.js' && context.parentURL?.endsWith('/main.js')) {
        const stub = `export function init(_public, port) { console.log('INIT ' + port); }
            export function createAgent(s) { console.log('AGENT ' + JSON.stringify({name:s.profile.name, host:s.host, port:s.port, peers:s.known_bot_peers})); }`;
        return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
