#!/usr/bin/env bash
# Runs the beat_the_game speedrun over and over from this PC, against the Minecraft server on serverdell: the same as
# ~/mindcraft-speedrun/run-overnight.sh on the Dell, but the bot runs here, where planning a path is ~3x faster than
# on the Dell's i3-2100 (path searches there kept running out of time: 11 in one run). Each run gets a brand-new world
# (new-world.sh on the Dell, over ssh) and is reset when the bot dies, has no wood 90 seconds in, no stone pickaxe by
# 3:00 or no iron pickaxe by 7:00 (the stages after it are scripted now, so a slower start is still worth playing). Logs and a report for each run go to pc-runner/runs/.
#   start:  pc-runner/start.ps1      (detached, keeps going with no terminal open)
#   stop:   touch pc-runner/STOP     (after the current run)     or  pc-runner/stop.sh  (right away)
# The Minecraft server and its worlds stay on the Dell; the model is Ollama on this PC (pc-runner/andy.json).
cd "$(dirname "$0")/.." || exit 1
DELL=kieron@192.168.1.144
RUNS=pc-runner/runs
mkdir -p "$RUNS"
rm -f pc-runner/STOP
echo $$ > pc-runner/runner.pid
cat /proc/$$/winpid > pc-runner/runner.winpid 2> /dev/null

export MINDCRAFT_STATUS_SECONDS=10
# This runner is currently proving the critical milestone first: get Andy from a fresh world into the Nether reliably.
export MINDCRAFT_NETHER_ONLY=1
export MINDCRAFT_VIEWER_HOST=127.0.0.1 MINDCRAFT_VIEWER_THIRD_PERSON=1
export PROFILES='["./pc-runner/andy.json"]'
# the Dell's server; no greeting at spawn (its reply can cut the opening short); no UI window opening for every run
export SETTINGS_JSON='{"host": "192.168.1.144", "port": 25565, "init_message": "", "auto_open_ui": false, "render_bot_view": true, "allow_insecure_coding": true, "load_memory": false}'
WOOD_DEADLINE=90
STONE_DEADLINE=180
IRON_DEADLINE=420

clear_leftovers() {
    # a bot left over from the last run (its MindServer still holding port 8080) made every run after it crash at
    # once, for 13 minutes: end any bot of a real run before starting the next
    powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -eq 'node.exe' -and \$_.CommandLine -match 'tasks/basic/beat_game\.json|init_agent\.js andy ' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" > /dev/null 2>&1
}

stop_bot() {
    # node here is a Windows program: end the whole tree (main.js and the agent process it started)
    local winpid
    winpid=$(cat "/proc/$1/winpid" 2>/dev/null)
    [ -n "$winpid" ] && taskkill //F //T //PID "$winpid" > /dev/null 2>&1
    kill "$1" 2> /dev/null
}

# the Dell's own runner and this one would fight over the server: wait for it to finish its last run
# ("[.]" so the pattern doesn't match the remote shell running pgrep, whose command line holds it too)
while ssh -o BatchMode=yes "$DELL" 'pgrep -f "bash [.]/run-overnight[.]sh" > /dev/null'; do
    echo "$(date '+%F %T') waiting for the Dell's runner to finish its run"
    sleep 30
done

n=0
while [ ! -f pc-runner/STOP ]; do
    n=$((n + 1))
    echo "$(date '+%F %T') new world $(ssh -o BatchMode=yes "$DELL" mindcraft-speedrun/new-world.sh | tail -1)"
    log="$RUNS/run-$(date +%Y%m%d-%H%M%S).log"
    echo "$(date '+%F %T') starting run $n -> $log"
    clear_leftovers
    node main.js --task_path tasks/basic/beat_game.json --task_id beat_the_game > "$log" 2>&1 &
    pid=$!
    launched=$(date +%s)
    # the deadlines count from when the bot is in the world: getting in took over a minute once (the new world's
    # server paused while empty), and a run was reset for "no wood after 90 seconds" 12 seconds after it spawned
    start=""
    reason=""
    while kill -0 $pid 2> /dev/null; do
        sleep 5
        if [ -z "$start" ]; then
            if grep -aq "andy spawned" "$log"; then
                start=$(date +%s)
            elif [ $(( $(date +%s) - launched )) -ge 240 ]; then
                reason="the bot never got into the world"
                echo "$(date '+%F %T') resetting run $n: $reason"
                stop_bot $pid
                break
            else
                continue
            fi
        fi
        if grep -aq "Agent died" "$log"; then reason="died: $(grep -a 'Agent died' "$log" | head -1 | sed 's/.*andy //')"; fi
        has_wood=$(grep -acE "Collected [1-9][0-9]* [a-z_]*_(log|stem)\.|Successfully crafted wooden_pickaxe" "$log")
        if [ -z "$reason" ] && [ "$has_wood" = 0 ] && grep -aq "Generated response: .*!explore" "$log"; then
            reason="no trees near the spawn (had to explore for wood)"
        fi
        if [ -z "$reason" ] && [ "$has_wood" = 0 ] && [ $(( $(date +%s) - start )) -ge $WOOD_DEADLINE ]; then
            reason="no wood after $WOOD_DEADLINE seconds"
        fi
        if [ -z "$reason" ] && [ $(( $(date +%s) - start )) -ge $STONE_DEADLINE ] && ! grep -aq "stone pickaxe at" "$log"; then
            reason="no stone pickaxe after $((STONE_DEADLINE / 60)):$(printf %02d $((STONE_DEADLINE % 60)))"
        fi
        if [ -z "$reason" ] && [ $(( $(date +%s) - start )) -ge $IRON_DEADLINE ] && ! grep -aq "iron pickaxe at" "$log"; then
            reason="no iron pickaxe after $((IRON_DEADLINE / 60)) minutes"
        fi
        if [ -n "$reason" ]; then
            echo "$(date '+%F %T') resetting run $n: $reason"
            stop_bot $pid
            break
        fi
    done
    wait $pid 2> /dev/null
    clear_leftovers
    echo "$(date '+%F %T') run $n ended"
    grep -a "Speedrun split" "$log" | tail -8
    # a report to learn from: splits, a timeline, where the time went, interruptions, failures and lessons
    python pc-runner/make_report.py "$log" "${reason:-ended on its own}" || true
    if grep -aq "Beat the game in" "$log"; then
        echo "$(date '+%F %T') the game was beaten, stopping"
        break
    fi
    sleep 5
done
rm -f pc-runner/runner.pid pc-runner/runner.winpid
echo "$(date '+%F %T') PC runner stopped"
