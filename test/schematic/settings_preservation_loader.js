import process from 'node:process';
import { resolve as resolveCommands } from './commands-loader.js';

// Keep the real server, createAgent/registerAgent flow, settings store and command
// handler. Only avoid Minecraft discovery/process startup and unrelated services.
export function resolve(specifier, context, nextResolve) {
    if (specifier === './settings.js' && context.parentURL?.endsWith('/main.js')) {
        return { url: `data:text/javascript,export default ${encodeURIComponent(JSON.stringify({
            profiles: [], auto_open_ui: false, mindserver_port: 0,
            trusted_command_senders: JSON.parse(process.env.MINDCRAFT_TEST_STARTUP_TRUST ?? 'null'),
        }))}`, shortCircuit: true };
    }
    if (specifier === './library/full_state.js' && context.parentURL?.endsWith('/src/agent/mindserver_proxy.js')) {
        return { url: 'data:text/javascript,export const getFullState = () => ({});', shortCircuit: true };
    }
    if (context.parentURL?.endsWith('/src/mindcraft/mindcraft.js')) {
        const stubs = {
            '../process/agent_process.js': 'export class AgentProcess { start() {} stop() {} }',
            './mcserver.js': 'export const getServer = async (host, port, version) => ({ host, port, version });',
            'open': 'export default () => {};',
        };
        if (Object.hasOwn(stubs, specifier)) {
            return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
        }
    }
    // The command test loader normally substitutes settings; this regression must
    // exercise the same store that receives get-settings snapshots on startup.
    if (specifier === '../settings.js' && context.parentURL?.includes('/src/agent/')) {
        return nextResolve(specifier, context);
    }
    return resolveCommands(specifier, context, nextResolve);
}
