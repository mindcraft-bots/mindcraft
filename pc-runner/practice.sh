#!/usr/bin/env bash
# Practices one stage of the speedrun on a local test server (127.0.0.1:25566), alongside the real runs on the Dell:
# a bot called tester starts the task with the gear for that stage already in its inventory, so a stage can be tried
# again in a couple of minutes instead of waiting for a whole run to reach it. Its best splits are kept apart.
#   pc-runner/practice.sh [task id in pc-runner/practice_tasks.json, default practice_nether]
#   -> pc-runner/practice/run-<date>.log
cd "$(dirname "$0")/.." || exit 1
mkdir -p pc-runner/practice
export MINDSERVER_PORT=8081 MINDCRAFT_STATUS_SECONDS=10
export MINDCRAFT_BEST_SPLITS=./pc-runner/practice/best-splits.json
export PROFILES='["./pc-runner/tester.json"]'
export SETTINGS_JSON='{"host": "127.0.0.1", "port": 25566, "init_message": "", "auto_open_ui": false, "render_bot_view": false, "allow_insecure_coding": true, "load_memory": false}'
log="pc-runner/practice/run-$(date +%Y%m%d-%H%M%S).log"
echo "$log"
exec node main.js --task_path pc-runner/practice_tasks.json --task_id "${1:-practice_nether}" > "$log" 2>&1
