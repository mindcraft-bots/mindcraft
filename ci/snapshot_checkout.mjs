import { snapshot } from './quality_gate.mjs';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

if (process.argv.length !== 3) {
    console.error('Usage: node ci/snapshot_checkout.mjs EMPTY_DESTINATION');
    process.exitCode = 2;
} else {
    const destination = path.resolve(process.argv[2]);
    const stat = lstatSync(destination);
    const source = realpathSync(process.cwd());
    const resolved = realpathSync(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(destination).length ||
        resolved === source || resolved.startsWith(`${source}${path.sep}`)) {
        throw new Error('Destination must be an empty directory outside the checkout');
    }
    snapshot(source, destination, { copyIgnoredLock: false });
}
