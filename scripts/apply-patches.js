import { execSync } from 'child_process';
import { existsSync } from 'fs';

// Apply patches safely - do not fail if optional packages (like prismarine-viewer) were skipped
try {
    const patchPackageCmd = existsSync('./node_modules/.bin/patch-package')
        ? './node_modules/.bin/patch-package'
        : 'npx patch-package';
    execSync(`${patchPackageCmd} --error-on-fail=false`, { stdio: 'inherit' });
} catch (err) {
    console.warn('[postinstall] patch-package warning (skipped missing optional packages or mismatch):', err?.message || err);
}
