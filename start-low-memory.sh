#!/usr/bin/env bash
# Start script for Linux systems with 4GB RAM or less
# Constrains Node V8 heap and enables memory optimization to avoid Linux OOM killer

export LOW_MEMORY_MODE=true
export FAST_MODE=true
export AGENT_MAX_MEMORY=1024
export NODE_OPTIONS="--max-old-space-size=1536"

node --max-old-space-size=1536 main.js "$@"
