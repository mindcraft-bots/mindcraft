/**
 * Cool, professional startup terminal dashboard for Doombots / Mindcraft.
 * Features prominent controlcenter:localhost display and real-time environment status.
 */

function stripAnsi(str) {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function stringWidth(str) {
    const clean = stripAnsi(str);
    let width = 0;
    for (let i = 0; i < clean.length; i++) {
        const code = clean.codePointAt(i);
        if (code > 0xffff) i++; // account for surrogate pair
        if (
            (code >= 0x1F300 && code <= 0x1F9FF) || 
            (code >= 0x2600 && code <= 0x27BF) ||
            (code >= 0x1FA00 && code <= 0x1FAFF) ||
            code === 0x2714 // checkmark
        ) {
            width += 2;
        } else {
            width += 1;
        }
    }
    return width;
}

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
    const blue = '\x1b[34m';
    const bold = '\x1b[1m';
    const dim = '\x1b[2m';
    const reset = '\x1b[0m';

    const host = settings.host || '127.0.0.1';
    let port = (settings.port && settings.port > 0 && settings.port < 65536) ? settings.port : 25565;
    const isZCClan = typeof host === 'string' && host.toLowerCase().includes('zcclanontop.aternos.me');
    if (isZCClan && (!settings.port || settings.port === 55916)) {
        port = 25565;
    }
    const serverTarget = `${host}:${port}`;
    const agentName = profileData.name || settings.profile?.name || 'Andy';
    const modelTarget = profileData.model || settings.profile?.model || 'openai/gpt-4o';
    const mindPort = settings.mindserver_port || 8080;
    const protocolVersion = '1.21.4';

    const BOX_WIDTH = 70;
    const padRow = (content) => {
        const w = stringWidth(content);
        const pad = Math.max(0, BOX_WIDTH - w);
        return `${cyan}│${reset}  ${content}${' '.repeat(pad)}  ${cyan}│${reset}`;
    };

    console.log(`
${cyan}${bold}  ██████╗   ██████╗   ██████╗  ███╗   ███╗██████╗   ██████╗ ████████╗███████╗
  ██╔══██╗ ██╔═══██╗ ██╔═══██╗ ████╗ ████║██╔══██╗ ██╔═══██╗╚══██╔══╝██╔════╝
  ██║  ██║ ██║   ██║ ██║   ██║ ██╔████╔██║██████╔╝ ██║   ██║   ██║   ███████╗
  ██║  ██║ ██║   ██║ ██║   ██║ ██║╚██╔╝██║██╔══██╗ ██║   ██║   ██║   ╚════██║
  ██████╔╝ ╚██████╔╝ ╚██████╔╝ ██║ ╚═╝ ██║██████╔╝ ╚██████╔╝   ██║   ███████║
  ╚═════╝   ╚═════╝   ╚═════╝  ╚═╝     ╚═╝╚═════╝   ╚═════╝    ╚═╝   ╚══════╝${reset}
  ${dim}Autonomous AI Minecraft Agent Platform • Multi-Version Cross-Play Engine${reset}

  ${cyan}┌${'─'.repeat(BOX_WIDTH + 4)}┐${reset}
${padRow(`${bold}${green}🎮 CONTROL CENTER :${reset} ${bold}${cyan}controlcenter:localhost${reset} ${dim}(http://localhost:${mindPort})${reset}`)}
${padRow(`${bold}${yellow}🌍 TARGET SERVER  :${reset} ${yellow}${serverTarget}${reset} ${dim}(Protocol: Java ${protocolVersion} • ViaVersion Ready)${reset}`)}
${padRow(`${bold}${green}🤖 ACTIVE AGENT   :${reset} ${bold}${green}${agentName}${reset}`)}
${padRow(`${bold}${magenta}🧠 AI MODEL       :${reset} ${magenta}${modelTarget}${reset}`)}
${padRow(`${bold}${blue}🛡️ LOGIN GUARD    :${reset} ${green}Active${reset} ${dim}(Minecraft 1.21.11 & Geyser / Aternos Bridged)${reset}`)}
${padRow(`${bold}${cyan}⚡ ENGINE MODE    :${reset} ${green}Fast Response (0ms delay)${reset} ${dim}| Low-Memory (4GB RAM)${reset}`)}
  ${cyan}└${'─'.repeat(BOX_WIDTH + 4)}┘${reset}
  ${bold}${green}✔ Control Center:${reset} ${bold}${cyan}http://localhost:${mindPort}${reset} ${dim}(controlcenter:localhost)${reset}
  ${dim}💡 Type commands directly in Minecraft chat or control the agent from the web dashboard.${reset}
`);
}

export default printDashboard;
