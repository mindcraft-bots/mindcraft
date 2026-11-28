#!/usr/bin/env node
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const CANCELLATION_SAFETY_VERSION = 'mindcraft-cancellation-v1';
const MINEFLAYER_DIGGING_SHA256 = 'f4a484bb830bcd0f581e133bfe7fb304819f91b26afd8c8429ae5ed6ef261d98';
const require = createRequire(join(process.cwd(), 'package.json'));
const checkpoints = [
    /function isBuildCancelled\(build\)\s*\{\s*return Boolean\(build\?\.isCancelled\);\s*\}/,
    /if \(isBuildCancelled\(build\)\) break;/,
    /await bot\.placeBlock\(refBlock, face\);\s*if \(isBuildCancelled\(build\)\) break;/,
    /if \(currentBuild === build\) currentBuild = null;/,
];

function verifySchematicPatch() {
    const { builder } = require('mineflayer-schem');
    if (builder?.cancellationSafetyVersion !== CANCELLATION_SAFETY_VERSION) {
        throw new Error('the exported cancellation-safety capability marker is missing or incompatible');
    }

    const source = readFileSync(require.resolve('mineflayer-schem'), 'utf8');
    const missingCheckpoint = checkpoints.findIndex((checkpoint) => !checkpoint.test(source));
    if (missingCheckpoint !== -1) {
        throw new Error(`required cancellation checkpoint ${missingCheckpoint + 1} is missing`);
    }
}

function verifyMineflayerPatch() {
    const version = require('mineflayer/package.json').version;
    if (version !== '4.39.0') throw new Error(`expected version 4.39.0, found ${version}`);
    const source = readFileSync(require.resolve('mineflayer/lib/plugins/digging.js'));
    const digest = createHash('sha256').update(source).digest('hex');
    if (digest !== MINEFLAYER_DIGGING_SHA256) throw new Error('patched digging implementation does not match');
}

function verifyChatChecksums() {
    const data = require('minecraft-data')('1.21.6');
    if (data?.version?.minecraftVersion !== '1.21.6') {
        throw new Error('exact Minecraft 1.21.6 protocol data is unavailable');
    }
    for (const packet of ['packet_chat_command_signed', 'packet_chat_message']) {
        const definition = data.protocol?.play?.toServer?.types?.[packet];
        const fields = definition?.[0] === 'container' && Array.isArray(definition[1]) ? definition[1] : [];
        const checksums = fields.filter((field) => field.name === 'checksum');
        if (checksums.length !== 1 || checksums[0].type !== 'u8') {
            throw new Error(`Minecraft 1.21.6 ${packet} checksum must be unsigned u8`);
        }
    }
}

try {
    verifySchematicPatch();
    console.log('Verified mineflayer-schem cancellation-safety patch.');
    verifyMineflayerPatch();
    console.log('Verified mineflayer 4.39.0 digging patch.');
    verifyChatChecksums();
    console.log('Verified Minecraft 1.21.6 unsigned chat checksums.');
} catch (error) {
    console.error(
        `Patch verification failed: ${error.message}\n`
        + 'Check installed dependencies, protocol data, and patch compatibility before reinstalling.',
    );
    process.exitCode = 1;
}
