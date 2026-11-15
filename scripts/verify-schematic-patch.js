import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const CANCELLATION_SAFETY_VERSION = 'mindcraft-cancellation-v1';
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

try {
    verifySchematicPatch();
    console.log('Verified mineflayer-schem cancellation-safety patch.');
} catch (error) {
    console.error(
        `mineflayer-schem cancellation-safety patch verification failed: ${error.message}\n`
        + 'Reinstall dependencies and ensure patches/mineflayer-schem+1.5.2.patch applies cleanly.',
    );
    process.exitCode = 1;
}
