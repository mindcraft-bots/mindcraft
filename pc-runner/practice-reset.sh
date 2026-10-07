#!/usr/bin/env bash
# Ends a practice attempt on the local test server: moves the tester bot somewhere far away and untouched (so the next
# attempt doesn't come back to the same pools, half-built portals and stray obsidian), then stops it. Real runs are
# left alone.
#   pc-runner/practice-reset.sh [path to the scratchpad holding rcon.py and testserver/]
RCON_DIR="${1:-$RCON_DIR}"
x=$(( (RANDOM % 4000) - 2000 )); z=$(( (RANDOM % 4000) - 2000 ))
python "$RCON_DIR/rcon.py" "spreadplayers $x $z 0 30 false tester" || true
sleep 2
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'node.exe' -and \$_.CommandLine -match 'practice_tasks\.json|init_agent\.js tester ' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue; \$_.ProcessId }" | sed 's/^/stopped practice process /'
