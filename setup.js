#!/usr/bin/env node
import { runInteractiveSetup } from './src/utils/interactive_setup.js';

console.log('Starting terminal setup wizard...');
runInteractiveSetup(true)
    .then((success) => {
        if (success) {
            console.log('Setup finished! You can now start the bot using:');
            console.log('    node main.js');
            console.log('  or for Linux 4GB: npm run start:low-mem');
            console.log('  or for Termux:    npm run start:termux');
        }
    })
    .catch((err) => {
        console.error('Setup encountered an error:', err?.message || err);
        process.exit(1);
    });
