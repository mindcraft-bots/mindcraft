const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8090;
const RUNS_DIR = path.resolve(__dirname, '..', 'pc-runner', 'runs');
const RUNNER_LOG = path.join(RUNS_DIR, 'runner.log');
const INDEX_FILE = path.join(__dirname, 'index.html');

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function getCurrentRun() {
  const runner = safeRead(RUNNER_LOG);
  const re = /^(.*?)starting run\s+(\d+)\s+->\s+(.+?run-(\d{8})-(\d{6})\.log)\s*$/gmi;
  let m, last = null;
  while ((m = re.exec(runner)) !== null) {
    last = {
      startedText: m[1].trim(),
      number: Number(m[2]),
      file: path.join(RUNS_DIR, path.basename(m[3].trim())),
      stampDate: m[4],
      stampTime: m[5]
    };
  }
  return last;
}

function elapsedFromStamp(d, t) {
  if (!d || !t) return 0;
  const dt = new Date(
    Number(d.slice(0,4)), Number(d.slice(4,6))-1, Number(d.slice(6,8)),
    Number(t.slice(0,2)), Number(t.slice(2,4)), Number(t.slice(4,6))
  );
  return Math.max(0, Math.floor((Date.now() - dt.getTime()) / 1000));
}

function formatElapsed(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? [h,m,s].map((v,i)=>i===0?String(v):String(v).padStart(2,'0')).join(':')
           : [m,s].map(v=>String(v).padStart(2,'0')).join(':');
}

function parseStatus(lines) {
  const statuses = lines.filter(x => /^\[status\]/.test(x));
  const line = statuses.at(-1) || '';
  const out = { dimension:'unknown', position:'—', x:null, y:null, z:null, hp:null, food:null, air:null, water:null, path:'—', digging:'—', action:'—' };
  let m;
  if ((m = line.match(/^\[status\]\s+(\S+)/))) out.dimension = m[1];
  if ((m = line.match(/\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)/))) {
    out.x = Number(m[1]); out.y = Number(m[2]); out.z = Number(m[3]);
    out.position = `${m[1]}, ${m[2]}, ${m[3]}`;
  }
  if ((m = line.match(/hp=(\d+)/))) out.hp = Number(m[1]);
  if ((m = line.match(/food=(\d+)/))) out.food = Number(m[1]);
  if ((m = line.match(/air=(\d+)/))) out.air = Number(m[1]);
  if ((m = line.match(/water=(\w+)/))) out.water = m[1] === 'true';
  if ((m = line.match(/path=([^\s]+)/))) out.path = m[1];
  if ((m = line.match(/dig=([^\s]+)/))) out.digging = m[1];
  if ((m = line.match(/action=([^\s]+)/))) out.action = m[1].replace(/^action:/,'');
  return out;
}

function milestoneTime(text, label) {
  const re = new RegExp('Speedrun split\\s+\\d+\\/\\d+:\\s*' + label + '\\s+at\\s+(\\d+:\\d+)', 'ig');
  let m, val = null;
  while ((m = re.exec(text)) !== null) val = m[1];
  return val;
}

function hasAny(text, patterns) {
  return patterns.some(p => p.test(text));
}

function parseMilestones(text, status) {
  const stone = milestoneTime(text, 'stone pickaxe');
  const iron = milestoneTime(text, 'iron pickaxe');
  const kit = milestoneTime(text, 'portal kit');
  const nether = /nether/i.test(status.dimension) || hasAny(text, [
    /entered (?:the )?nether/i, /dimension.*nether/i, /\[status\]\s+(?:the_)?nether/i
  ]);
  const blaze = hasAny(text, [/blaze_rod/i, /blaze rod/i]);
  const pearls = hasAny(text, [/ender_pearl/i, /ender pearl/i]);
  const stronghold = /stronghold/i.test(text);
  const theEnd = /\[status\]\s+(?:the_)?end\b/i.test(text) || /entered (?:the )?end/i.test(text);
  const dragon = /ender dragon.*(?:killed|defeated|dead)|beat(?:en)? the game/i.test(text);

  return [
    { key:'stone', label:'Stone Pickaxe', done:!!stone, value:stone || null },
    { key:'iron', label:'Iron Pickaxe', done:!!iron, value:iron || null },
    { key:'kit', label:'Portal Kit', done:!!kit, value:kit || null },
    { key:'nether', label:'Enter Nether', done:nether, value:nether ? 'Reached' : null },
    { key:'blaze', label:'Blaze Rods', done:blaze, value:blaze ? 'Found' : null },
    { key:'pearls', label:'Ender Pearls', done:pearls, value:pearls ? 'Found' : null },
    { key:'stronghold', label:'Stronghold', done:stronghold, value:stronghold ? 'Found' : null },
    { key:'end', label:'The End', done:theEnd, value:theEnd ? 'Reached' : null },
    { key:'dragon', label:'Kill Dragon', done:dragon, value:dragon ? 'DONE' : null }
  ];
}

function cleanAction(s) {
  return (s || '—').replace(/^mode:/,'').replace(/^action:/,'').replaceAll('_',' ');
}

function recentEvents(lines) {
  const events = [];
  let lastStatusKey = '';
  for (const raw of lines.slice(-900)) {
    const line = raw.trim();
    if (!line) continue;
    if (/Ollama Status: 404|Failed to send Ollama request|^at\s|node:internal|skill_library\.js/.test(line)) continue;

    let type = 'info', text = null;
    let m;
    if ((m = line.match(/Speedrun split\s+\d+\/\d+:\s*(.+?)\s+at\s+(\d+:\d+)(.*)/i))) {
      type = /NEW BEST/i.test(line) ? 'best' : 'success';
      text = `${m[1]} — ${m[2]}${/NEW BEST/i.test(line) ? ' • NEW BEST' : ''}`;
    } else if (/You died|was slain|shot by|tried to swim in lava|drowned/i.test(line)) {
      type = 'danger';
      text = line.replace(/^received message from system\s*:\s*/i,'').replace(/Don't go back.*$/i,'').trim();
    } else if ((m = line.match(/Successfully crafted\s+([^,]+),/i))) {
      type = 'success'; text = 'Crafted ' + m[1].replaceAll('_',' ');
    } else if ((m = line.match(/parsed command:\s*\{ commandName: ['"]!([^'"]+)/i))) {
      type = 'action'; text = 'Started ' + cleanAction(m[1]);
    } else if (/\[status\]/.test(line)) {
      const dig = (line.match(/dig=([^\s]+)/)||[])[1];
      const act = (line.match(/action=([^\s]+)/)||[])[1];
      const dim = (line.match(/^\[status\]\s+(\S+)/)||[])[1];
      const key = [dim,act,dig].join('|');
      if (key !== lastStatusKey) {
        lastStatusKey = key;
        if (dig) { type='work'; text='Mining ' + dig.replaceAll('_',' '); }
        else if (act) { type='action'; text=cleanAction(act); }
      }
    } else if (/portal|nether|blaze|pearl|stronghold|dragon/i.test(line) && line.length < 220) {
      type = 'info'; text = line;
    }
    if (text && !events.some(e => e.text === text)) events.push({type,text});
  }
  return events.slice(-10).reverse();
}

function getLastResult(runner, currentFileName) {
  const lines = runner.split(/\r?\n/);
  let last = null;
  for (const line of lines) {
    if (/resetting run/i.test(line)) last = line.replace(/^\S+\s+\S+\s+/,'');
  }
  return last || 'No completed run yet';
}

function bestSplits(runner) {
  const best = {};
  const re = /Speedrun split\s+\d+\/\d+:\s*(.+?)\s+at\s+(\d+):(\d+)/gi;
  let m;
  while ((m = re.exec(runner)) !== null) {
    const sec = Number(m[2])*60 + Number(m[3]);
    const key = m[1].trim().toLowerCase();
    if (!best[key] || sec < best[key].sec) best[key] = {sec, time:`${m[2]}:${m[3].padStart(2,'0')}`};
  }
  return {
    stone: best['stone pickaxe']?.time || null,
    iron: best['iron pickaxe']?.time || null,
    kit: best['portal kit']?.time || null
  };
}

function buildStatus() {
  const run = getCurrentRun();
  const runner = safeRead(RUNNER_LOG);
  if (!run) return { online:false, message:'Waiting for Mindcraft runner…', updatedAt:new Date().toISOString() };

  const text = safeRead(run.file);
  const lines = text.split(/\r?\n/);
  const status = parseStatus(lines);
  const elapsedSeconds = elapsedFromStamp(run.stampDate, run.stampTime);

  return {
    online: true,
    run: run.number,
    file: path.basename(run.file),
    elapsed: formatElapsed(elapsedSeconds),
    elapsedSeconds,
    status: {
      ...status,
      action: cleanAction(status.action),
      digging: cleanAction(status.digging),
      path: cleanAction(status.path)
    },
    milestones: parseMilestones(text, status),
    events: recentEvents(lines),
    best: bestSplits(runner + '\n' + text),
    lastResult: getLastResult(runner, path.basename(run.file)),
    logBytes: Buffer.byteLength(text, 'utf8'),
    updatedAt: new Date().toISOString()
  };
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/status')) {
    const data = JSON.stringify(buildStatus());
    res.writeHead(200, {
      'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin':'*'
    });
    return res.end(data);
  }

  if (req.url === '/' || req.url.startsWith('/index.html')) {
    const html = safeRead(INDEX_FILE);
    res.writeHead(html ? 200 : 500, {
      'Content-Type':'text/html; charset=utf-8',
      'Cache-Control':'no-store'
    });
    return res.end(html || 'Dashboard HTML missing');
  }

  res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mindcraft dashboard: http://127.0.0.1:${PORT}`);
  console.log(`Reading runs from: ${RUNS_DIR}`);
});