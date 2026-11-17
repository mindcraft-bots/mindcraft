#!/usr/bin/env bash
# Termux setup script for Doombots / Mindcraft
# Designed specifically for Android Termux environment

set -e

echo "=========================================="
echo "    Doombots Termux Setup for Android    "
echo "=========================================="

echo "[1/4] Updating Termux packages..."
pkg update -y

echo "[2/4] Installing Node.js LTS, Git, and Python..."
pkg install -y nodejs-lts git python

echo "[3/4] Installing npm dependencies..."
# Omit optional dependencies (canvas, gl, viewer) which require desktop C++/X11
npm install --omit=optional

echo "[4/4] Setting up keys.json & configuration..."
if [ ! -f "keys.json" ]; then
    cp keys.example.json keys.json
fi

# Run interactive terminal setup wizard
node setup.js

echo ""
echo "=========================================="
echo "Setup complete!"
echo "To start the bot on Termux:"
echo "    ./termux-start.sh"
echo "  or: npm run start:termux"
echo "=========================================="
