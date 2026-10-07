#!/usr/bin/env python3
"""Turns one speedrun log into a Markdown report: splits, a timeline of every command with how long it took and how
it went, where the time went, interruptions, failures, deaths and things grabbed on the way, and a few lessons.
The bot logs a [status] line every 10 seconds, which is the clock here.
    python3 make_report.py runs/run-<date>.log ["why the run ended"]   -> runs/report-<date>.md
A run that beats the game also gets a copy as runs/SUCCESS-report-<date>.md.
"""
import os, re, sys
from collections import Counter, defaultdict

log_path = sys.argv[1]
end_reason = sys.argv[2] if len(sys.argv) > 2 else ''
lines = open(log_path, encoding='utf-8', errors='replace').read().splitlines()
TICK = 10
FAILURE_PATTERNS = {
    'not enough resources to craft': r'You do not have the resources',
    'failed to collect': r'Failed to collect',
    'unable to reach': r'Unable to reach',
    "couldn't ...": r"Couldn't",
    'nothing nearby to collect': r'No \S+ nearby',
    'path search timed out': r'Took to long to decide path',
    'could not find': r'Could not find',
    'block in the way': r'is in the way',
}


def clock(sec):
    return f"{int(sec // 60)}:{int(sec % 60):02d}"


t = 0
splits, deaths, grabs, commands = [], [], [], []
interrupts, mode_time, failures = Counter(), Counter(), Counter()
current = None
for i, line in enumerate(lines):
    if line.startswith('[status]'):
        t += TICK
        m = re.search(r'action=(\S+)', line)
        if m and m.group(1).startswith('mode:'):
            mode_time[m.group(1)[5:]] += TICK
        continue
    m = re.match(r'Speedrun split (\d+)/\d+: (.+) at ([\d:]+)', line)
    if m:
        splits.append((m.group(2), m.group(3)))
    if 'Agent died' in line:
        deaths.append((clock(t), re.sub(r'.*andy ', '', line)))
    m = re.match(r'Grabbed on the way: (.+)\.', line)
    if m:
        grabs.extend(x.strip() for x in m.group(1).split(','))
    m = re.match(r'Generated response: (.*)', line)
    if m and '!' in m.group(1):
        cmd = m.group(1)[m.group(1).index('!'):].strip()
        if current:
            current['end'] = t
        current = {'cmd': cmd, 'start': t, 'end': t, 'result': ''}
        commands.append(current)
    m = re.match(r'Agent executed: !\w+ and got: (.*)', line)
    if m and current:
        res = m.group(1).strip()
        if res in ('Action output:', ''):
            after = [l for l in lines[i + 1:i + 6] if l.strip() and not l.startswith('[status]')]
            res = after[0] if after else ''
        if res == 'undefined':
            res = '(interrupted)'
        current['result'] = res[:120]
        current['end'] = t
    m = re.search(r'action "mode:(\w+)" trying to interrupt', line)
    if m:
        interrupts[m.group(1)] += 1
    for label, pat in FAILURE_PATTERNS.items():
        if re.search(pat, line):
            failures[label] += 1
if current:
    current['end'] = max(current['end'], t)

total = t
name = os.path.basename(log_path).replace('run-', '').replace('.log', '')
beaten = any('Beat the game in' in l for l in lines)
out = [f"# Speedrun report: run {name}", '',
       f"- **Result:** {'BEAT THE GAME' if beaten else (end_reason or 'ended')}",
       f"- **Length:** about {clock(total)} (counted from the 10-second status lines)",
       f"- **Decisions by the model:** {len(commands)}",
       f"- **Deaths:** {len(deaths)}", '', '## Splits', '']
if splits:
    out += ['| Milestone | Time |', '|---|---|'] + [f'| {s} | {tm} |' for s, tm in splits]
else:
    out.append('No milestones reached.')
out.append('')

by_cmd = defaultdict(lambda: [0, 0])
for c in commands:
    m = re.match(r'!\w+', c['cmd'])
    key = m.group(0) if m else c['cmd']
    by_cmd[key][0] += 1
    by_cmd[key][1] += c['end'] - c['start']
out += ['## Where the time went', '', '| Command | Times used | Total time |', '|---|---|---|']
out += [f'| `{k}` | {n} | {clock(sec)} |' for k, (n, sec) in sorted(by_cmd.items(), key=lambda kv: -kv[1][1])]
out.append('')
if mode_time:
    out += ['Time spent in automatic modes (interrupting the plan): ' +
            ', '.join(f'{k} {clock(v)}' for k, v in mode_time.most_common()) + '.', '']

out += ['## Timeline', '', '| Start | Took | Command | Result |', '|---|---|---|---|']
for c in commands:
    res = c['result'].replace('|', '/')
    out.append(f"| {clock(c['start'])} | {clock(c['end'] - c['start'])} | `{c['cmd'][:60]}` | {res} |")
out.append('')
if interrupts:
    out += ['## Interruptions', ''] + [f'- {k}: {v}' for k, v in interrupts.most_common()] + ['']
if deaths:
    out += ['## Deaths', ''] + [f'- {tm}: {d}' for tm, d in deaths] + ['']
if failures:
    out += ['## Failures and retries', ''] + [f'- {k}: {v}' for k, v in failures.most_common()] + ['']
if grabs:
    out += ['## Grabbed on the way', '', ', '.join(f'{k} x{v}' for k, v in Counter(grabs).most_common()), '']

lessons = []
for c in sorted(commands, key=lambda c: c['start'] - c['end'])[:3]:
    if c['end'] - c['start'] >= 60:
        lessons.append(f"`{c['cmd'][:60]}` took {clock(c['end'] - c['start'])} (from {clock(c['start'])}): worth making faster.")
for cmd, n in Counter(c['cmd'] for c in commands).most_common(3):
    if n >= 3:
        lessons.append(f"`{cmd[:60]}` was issued {n} times: it kept failing or being interrupted.")
if '!newAction' in by_cmd:
    lessons.append(f"The model wrote its own code (`!newAction`) {by_cmd['!newAction'][0]} times: usually slow; a dedicated command or a better hint would avoid it.")
if '!explore' in by_cmd:
    lessons.append(f"`!explore` was used {by_cmd['!explore'][0]} times ({clock(by_cmd['!explore'][1])}): the seed lacked something nearby, or a hint sent it wandering.")
for k, v in mode_time.most_common(2):
    if v >= 60:
        lessons.append(f"{clock(v)} went to the {k} mode instead of the plan.")
interrupted = sum(1 for c in commands if c['result'] == '(interrupted)')
if interrupted >= 3:
    lessons.append(f'{interrupted} commands were interrupted before finishing (fights, unstuck, drowning or night).')
if not splits:
    lessons.append('No milestones at all: check the first few commands for what went wrong.')
out += ['## Lessons', ''] + ([f'- {l}' for l in lessons] or ['- Nothing stood out.']) + ['']

text = '\n'.join(out)
folder = os.path.dirname(log_path) or '.'
report = os.path.join(folder, f'report-{name}.md')
open(report, 'w', encoding='utf-8').write(text)
if beaten:
    open(os.path.join(folder, f'SUCCESS-report-{name}.md'), 'w', encoding='utf-8').write(text)
print(report)
