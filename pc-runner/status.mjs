// Live status page for a speedrun, in the console, redrawn every second. Run it in a second window while a run plays:
//   node pc-runner\status.mjs
// Live state (what the bot's doing, health, food, gear, where it is, what's around) comes from the bot's MindServer
// (port 8080) every second. The timing board (each split, and how far ahead of or behind the best it is) and the
// recent events come from the run's log: the newest pc-runner\runs\watch-*.log (pc-runner\run-once.ps1) or run-*.log
// (the runner). Ctrl+C to close.
import { io } from 'socket.io-client';
import { readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const RUNS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runs');
const PORT = process.env.MINDSERVER_PORT || 8080;
const SPLITS = ['stone pickaxe', 'iron pickaxe', 'portal kit', 'entered the nether', 'blaze rod', '12 eyes of ender',
    'entered the end', 'killed the ender dragon', 'credits'];
const HOSTILE = ['zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'witch', 'drowned', 'husk', 'stray', 'blaze',
    'ghast', 'piglin', 'piglin_brute', 'hoglin', 'zombified_piglin', 'magma_cube', 'wither_skeleton', 'enderman',
    'slime', 'phantom', 'silverfish', 'endermite', 'pillager', 'vindicator', 'bogged', 'zombie_villager', 'ender_dragon'];

// colours (Windows Terminal and the newer consoles understand these)
const c = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const bold = c('1'), dim = c('2'), red = c('31'), green = c('32'), yellow = c('33'), cyan = c('36'), magenta = c('35');

let state = null, lastState = 0, connected = false;
let logFile = null, logPos = 0, logText = '';
let taskStart = null, splits = {}, events = [], stage = '', deaths = 0;

const clock = (secs) => {
    if (secs == null || !isFinite(secs) || secs < 0) return '--:--';
    const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = Math.floor(secs % 60);
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
};
const bar = (v, max, width, colour) => {
    const n = Math.max(0, Math.min(width, Math.round((v / max) * width)));
    return colour('█'.repeat(n)) + dim('░'.repeat(width - n));
};
// visible width, for padding coloured text
const vlen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - vlen(s)));

function newestLog() {
    try {
        const files = readdirSync(RUNS).filter(f => /^(watch|run)-\d{8}-\d{6}\.log$/.test(f))
            .map(f => ({ f, t: statSync(path.join(RUNS, f)).mtimeMs })).sort((a, b) => b.t - a.t);
        // only one still being written: an old run's log would show its splits as this one's
        return files[0] && Date.now() - files[0].t < 120000 ? path.join(RUNS, files[0].f) : null;
    } catch { return null; }
}

function readLog() {
    const file = newestLog();
    if (!file) {
        if (logFile) { logFile = null; logPos = 0; logText = ''; taskStart = null; splits = {}; events = []; stage = ''; deaths = 0; }
        return;
    }
    if (file !== logFile) {
        // a new run: start over
        logFile = file; logPos = 0; logText = '';
        taskStart = null; splits = {}; events = []; stage = ''; deaths = 0;
    }
    let size;
    try { size = statSync(file).size; } catch { return; }
    if (size <= logPos) return;
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - logPos);
    readSync(fd, buf, 0, buf.length, logPos);
    closeSync(fd);
    logPos = size;
    const lines = (logText + buf.toString('utf8')).split(/\r?\n/);
    logText = lines.pop(); // a line still being written
    for (const raw of lines) {
        const line = raw.trim();
        let m;
        if ((m = line.match(/^Task start time set to (\d+)/))) taskStart = Number(m[1]) / 1000;
        else if ((m = line.match(/^Speedrun split \d+\/\d+: (.+?) at ([\d:]+)(?: \((.+)\))?/))) {
            splits[m[1]] = { time: m[2], gap: m[3] || '' };
            event(green(`split: ${m[1]} at ${m[2]}${m[3] ? `  (${m[3]})` : ''}`));
        }
        else if ((m = line.match(/^Agent died:\s+\S+ (.+)/))) { deaths++; event(red(`DIED: ${m[1]}`)); }
        else if ((m = line.match(/^\[autopilot\] running (.+)/))) { stage = m[1]; event(cyan(`stage: ${m[1]}`)); }
        else if ((m = line.match(/^parsed command: \{ commandName: '(![a-zA-Z]+)'/))) stage = m[1];
        else if ((m = line.match(/^Generated response: (.*)/))) event(magenta(`model: ${m[1].slice(0, 70)}`));
        else if (/^(Lava pool at|Casting a nether portal|Cast and lit|Entering nether_portal|In a nether fortress|No nether fortress|Going (up )?to the surface|Smelting \d+|Kit done|The kit (still needs|stopped)|The opening stopped|Opening done|Getting to the nether stopped|Couldn't|Got out of the lava|Bunkered down|Night is falling|Collected \d+ (iron_ore|gold_ore|coal_ore|flint|blaze_rod)|Successfully crafted (iron_|golden_|bucket|flint_and_steel|shield|stone_pickaxe|furnace|wooden_pickaxe)|Mined \d+ gravel|You have \d+ blaze_rod|Fetched \d+)/.test(line))
            event(line.slice(0, 90));
    }
}
function event(text) {
    events.push(`${dim(clock(taskStart ? Date.now() / 1000 - taskStart : null))}  ${text}`);
    if (events.length > 9) events.shift();
}

function draw() {
    readLog();
    const W = 80, out = [];
    const now = Date.now() / 1000;
    const g = state?.gameplay, inv = state?.inventory, counts = inv?.counts || {};
    const live = connected && state && Date.now() - lastState < 5000;
    out.push(bold(cyan(' ANDY SPEEDRUN ')) + `  run ${bold(clock(taskStart ? now - taskStart : null))}` +
        `   deaths ${deaths ? red(String(deaths)) : green('0')}   ` + (live ? green('* live') : yellow('- waiting for the bot')) +
        dim(`   ${new Date().toLocaleTimeString()}`));
    out.push(dim('-'.repeat(W)));
    if (g) {
        const dimn = (g.dimension || '').replace('minecraft:', '');
        const p = g.position || {};
        const hpColour = g.health > 12 ? green : g.health > 6 ? yellow : red;
        out.push(`${pad('Health', 8)}${bar(g.health, 20, 20, hpColour)} ${pad(hpColour(`${g.health}/20`), 7)}` +
            `   Food ${bar(g.hunger, 20, 10, yellow)} ${g.hunger}/20`);
        out.push(`${pad('Where', 8)}${pad(bold(dimn), 12)} ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}` +
            `   ${dim(g.biome || '')}   ${g.timeLabel === 'Night' ? yellow('night') : (g.timeLabel || '').toLowerCase()}`);
        out.push(`${pad('Doing', 8)}${bold((state.action?.current || '?').replace(/^(action|mode):/, ''))}${stage ? dim(`   (last command ${stage})`) : ''}`);
        const eq = inv.equipment || {};
        const armor = [eq.helmet, eq.chestplate, eq.leggings, eq.boots].filter(Boolean).map(a => a.replace('_', ' ')).join(', ');
        out.push(`${pad('Gear', 8)}${eq.mainHand || 'nothing'} in hand${armor ? `, wearing ${armor}` : ', no armor'}`);
        const mobs = (state.nearby?.entityTypes || []).filter(t => !['experience_orb', 'arrow', 'item'].includes(t));
        const near = mobs.map(t => HOSTILE.includes(t) ? red(t) : t).join(', ');
        out.push(`${pad('Nearby', 8)}${near || dim('nothing')}`);
        const keys = ['iron_ingot', 'raw_iron', 'gold_ingot', 'raw_gold', 'coal', 'cobblestone', 'cooked_beef', 'cooked_porkchop',
            'cooked_mutton', 'cooked_chicken', 'bread', 'torch', 'blaze_rod', 'ender_pearl', 'ender_eye'];
        const items = keys.filter(k => counts[k]).map(k => `${k.replace('_', ' ')} ${bold(String(counts[k]))}`);
        out.push(`${pad('Items', 8)}${items.join(dim(', ')) || dim('-')}`);
    }
    else out.push(dim('No live state yet: is the bot running? (pc-runner\\run-once.ps1)'));
    out.push('');
    out.push(bold('SPLITS') + dim('   (gap to the best time)'));
    const buckets = (counts.bucket || 0) + (counts.water_bucket || 0) + (counts.lava_bucket || 0);
    const hints = {
        'portal kit': `buckets ${buckets}/2, flint and steel ${counts.flint_and_steel ? 'yes' : 'no'}`,
        'blaze rod': `${counts.blaze_rod || 0}/7 rods`,
        '12 eyes of ender': `${counts.ender_pearl || 0}/12 pearls, ${counts.ender_eye || 0}/12 eyes`,
    };
    // reached by what it has and where it is, for a run without a log (no time for those)
    const has = (...names) => names.some(n => counts[n] > 0);
    const dimn = (g?.dimension || '').replace('minecraft:', '');
    const reachedNow = {
        'stone pickaxe': has('stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'),
        'iron pickaxe': has('iron_pickaxe', 'diamond_pickaxe'),
        'portal kit': buckets >= 2 && has('flint_and_steel', 'fire_charge'),
        'entered the nether': dimn === 'the_nether',
        'blaze rod': has('blaze_rod', 'blaze_powder', 'ender_eye'),
        '12 eyes of ender': (counts.ender_eye || 0) >= 12,
        'entered the end': dimn === 'the_end',
    };
    const order = SPLITS.map(n => !!splits[n] || !!reachedNow[n]);
    const furthest = order.lastIndexOf(true);
    let next = true;
    for (const [i, name] of SPLITS.entries()) {
        const s = splits[name] || (i <= furthest ? { time: '-', gap: '' } : null);
        if (s) {
            const gap = s.gap.replace(/ vs best [\d:]+/, '');
            const gapColour = /NEW BEST|^-/.test(gap) ? green : /first time/.test(gap) ? cyan : yellow;
            out.push(`  ${green('+')} ${pad(name, 24)}${pad(bold(s.time), 9)}${gapColour(gap)}`);
        }
        else {
            out.push(`  ${next ? yellow('>') : dim('.')} ${pad(next ? name : dim(name), 24)}${next ? dim(hints[name] || '') : ''}`);
            next = false;
        }
    }
    out.push('');
    out.push(bold('RECENT') + (logFile ? dim(`   ${path.basename(logFile)}`) : dim('   no run log: start the run with pc-runner/run-once.ps1 for splits and events')));
    for (const e of events) out.push('  ' + e);
    for (let i = events.length; i < 9; i++) out.push('');
    process.stdout.write('\x1b[H\x1b[2J' + out.join('\n') + '\n');
}

const socket = io(`http://localhost:${PORT}`, { reconnection: true, reconnectionDelay: 2000 });
socket.on('connect', () => { connected = true; socket.emit('listen-to-agents'); });
socket.on('disconnect', () => { connected = false; });
socket.on('state-update', (states) => {
    const s = states?.andy || Object.values(states || {})[0];
    if (s && !s.error) { state = s; lastState = Date.now(); }
});

setInterval(draw, 1000);
draw();
