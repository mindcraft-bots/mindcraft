#!/usr/bin/env bash
# Stops the PC runner and its current run right away (touch pc-runner/STOP instead to let the run finish first).
# Practice runs (pc-runner/practice.sh) are left alone.
cd "$(dirname "$0")/.." || exit 1
touch pc-runner/STOP
# the runner by the Windows process id it wrote when it started (matching command lines also hit whatever shell
# ran this, when its own command mentioned the runner), with whatever it started
if [ -f pc-runner/runner.winpid ]; then
    taskkill //F //T //PID "$(cat pc-runner/runner.winpid)" > /dev/null 2>&1 && echo "stopped the runner"
    rm -f pc-runner/runner.winpid pc-runner/runner.pid
fi
# and the bot of a real run, if it outlived the runner: main.js with the real task, and its agent process
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'node.exe' -and \$_.CommandLine -match 'tasks/basic/beat_game\.json|init_agent\.js andy ' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue; \$_.ProcessId }" | sed 's/^/stopped bot process /'
echo "PC runner stopped"
