#!/usr/bin/env bash
# Universal launcher for Doombots
set -e

# Automatically move to the directory where this script is located
cd "$(dirname "$0")"

# If node_modules does not exist, install dependencies
if [ ! -d "node_modules" ]; then
    echo "[Doombots] Installing dependencies..."
    npm install --omit=optional
fi

# Launch the bot (main.js will automatically launch the setup wizard if keys are missing)
node main.js "$@"
