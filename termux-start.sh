#!/usr/bin/env bash
# Termux start script for Doombots / Mindcraft
# Limits memory to 1024MB to avoid Android OOM killer, and enables fast response mode

export LOW_MEMORY_MODE=true
export FAST_MODE=true
export AGENT_MAX_MEMORY=768
export NODE_OPTIONS="--max-old-space-size=1024"

# If profiles are not passed as args, use fast profile if keys exist, or default
node --max-old-space-size=1024 main.js "$@"
