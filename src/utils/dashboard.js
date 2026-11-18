/**
 * Sleek, professional terminal dashboard banner for Doombots / Mindcraft.
 */

export function printDashboard(settings, profileData = {}) {
    // Clear terminal screen cleanly
    try {
        process.stdout.write('\x1Bc');
    } catch {
        console.clear();
    }

    const cyan = '\x1b[36m';
    const green = '\x1b[32m';
    const yellow = '\x1b[33m';
    const magenta = '\x1b[35m';
    const bold = '\x1b[1m';
    const dim = '\x1b[2m';
    const reset = '\x1b[0m';

    const host = settings.host || '127.0.0.1';
    const port = (settings.port && settings.port > 0 && settings.port < 65536) ? settings.port : 25565;
    const serverTarget = `${host}:${port}`;
    const agentName = profileData.name || settings.profile?.name || 'Doombot';
    const modelTarget = profileData.model || settings.profile?.model || 'ollama/qwen2.5:0.5b';
    const controlCenterUrl = `http://localhost:${settings.mindserver_port || 8080}`;
    const protocolVersion = settings.minecraft_version && settings.minecraft_version !== 'auto' ? settings.minecraft_version : '1.21.4';

    console.log(`
${cyan}${bold}  ██████╗  ██████╗  ██████╗ ███╗   ███╗██████╗  ██████╗ ████████╗███████╗
  ██╔══██╗██╔═══██╗██╔═══██╗████╗ ████║██╔══██╗██╔═══██╗╚══██╔══╝██╔════╝
  ██║  ██║██║   ██║██║   ██║██╔████╔██║██████╔╝██║   ██║   ██║   ███████╗
  ██║  ██║██║   ██║██║   ██║██║╚██╔╝██║██╔══██╗██║   ██║   ██║   ╚════██║
  ██████╔╝╚██████╔╝╚██████╔╝██║ ╚═╝ ██║██████╔╝╚██████╔╝   ██║   ███████║
  ╚═════╝  ╚═════╝  ╚═════╝ ╚═╝     ╚═╝╚═════╝  ╚═════╝    ╚═╝   ╚══════╝${reset}
  ${dim}Autonomous AI Minecraft Agent Platform • Fast & Low-Memory Optimized${reset}

  ${cyan}┌────────────────────────────────────────────────────────────────────────┐${reset}
  ${cyan}│${reset}  ${bold}${green}🎮 CONTROL CENTER :${reset} ${bold}${cyan}${controlCenterUrl}${reset} ${dim}(controlcenter:localhost)${reset}${' '.repeat(Math.max(0, 48 - (controlCenterUrl.length + 26)))}${cyan}│${reset}
  ${cyan}│${reset}  ${bold}🌍 SERVER TARGET  :${reset} ${yellow}${serverTarget}${reset} ${dim}(Java ${protocolVersion})${reset}${' '.repeat(Math.max(0, 31 - serverTarget.length))}${cyan}│${reset}
  ${cyan}│${reset}  ${bold}🤖 AGENT NAME     :${reset} ${bold}${green}${agentName}${reset}${' '.repeat(Math.max(0, 48 - agentName.length))}${cyan}│${reset}
  ${cyan}│${reset}  ${bold}🧠 AI MODEL       :${reset} ${magenta}${modelTarget}${reset}${' '.repeat(Math.max(0, 48 - modelTarget.length))}${cyan}│${reset}
  ${cyan}│${reset}  ${bold}⚡ PERFORMANCE    :${reset} ${green}Fast Mode (0ms delay) | Low-Memory (4GB)${reset}        ${cyan}│${reset}
  ${cyan}│${reset}  ${bold}🛡️ LOGIN GUARD   :${reset} ${green}Active (Auto-reconnect & ViaVersion Ready)${reset}     ${cyan}│${reset}
  ${cyan}└────────────────────────────────────────────────────────────────────────┘${reset}
`);
}

export default printDashboard;
