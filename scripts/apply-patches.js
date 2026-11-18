import { execSync } from 'child_process';
import { existsSync, readdirSync, mkdirSync, copyFileSync, rmSync } from 'fs';
import path from 'path';

// Apply patches safely - skip patches for optional/uninstalled packages (like prismarine-viewer)
try {
    const patchPackageCmd = existsSync('./node_modules/.bin/patch-package')
        ? './node_modules/.bin/patch-package'
        : 'npx patch-package';

    const patchesDir = './patches';
    if (!existsSync(patchesDir)) {
        process.exit(0);
    }

    const tempPatchDir = './.patches-temp';
    if (existsSync(tempPatchDir)) rmSync(tempPatchDir, { recursive: true, force: true });
    mkdirSync(tempPatchDir, { recursive: true });

    let count = 0;
    const patchFiles = readdirSync(patchesDir);
    for (const file of patchFiles) {
        if (!file.endsWith('.patch')) continue;
        const pkgName = file.split('+')[0];
        if (existsSync(path.join('./node_modules', pkgName))) {
            copyFileSync(path.join(patchesDir, file), path.join(tempPatchDir, file));
            count++;
        } else {
            console.log(`[postinstall] Skipping patch for uninstalled package: ${pkgName}`);
        }
    }

    if (count > 0) {
        execSync(`${patchPackageCmd} --patch-dir ${tempPatchDir}`, { stdio: 'inherit' });
    }
    rmSync(tempPatchDir, { recursive: true, force: true });
} catch (err) {
    console.warn('[postinstall] patch-package warning (skipped missing optional packages or mismatch):', err?.message || err);
}
