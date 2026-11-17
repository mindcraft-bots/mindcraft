import md from 'minecraft-data';
import data from 'minecraft-data/data.js';
import versionMod from 'mineflayer/lib/version.js';

/**
 * Universal version compatibility patch for Mindcraft / Mineflayer.
 * 1. Polyfills missing '26.1' in minecraft-data which prismarine-chunk 1.41.0 checks via mcData.version['>=']('26.1').
 * 2. Aliases synthetic Bedrock / Geyser / ViaVersion strings (1.21.11, 1.21.10, etc.) to 1.21.4 so
 *    minecraft-data, prismarine-registry, and mineflayer won't throw "Do not have data for 1.21.11".
 */

// 1. Fix prismarine-chunk 1.41.0 RangeError for '26.1'
try {
    if (md.versionsByMinecraftVersion?.pc) {
        if (!md.versionsByMinecraftVersion.pc['26.1']) {
            md.versionsByMinecraftVersion.pc['26.1'] = {
                dataVersion: 99999,
                minecraftVersion: '26.1',
                version: 99999
            };
        }
    }
} catch (e) {
    // ignore
}

// 2. Alias Bedrock/Geyser/ViaVersion 1.21.x and 1.20.x versions
try {
    const base121 = data.pc['1.21.4'] || data.pc['1.21.1'];
    const pcVersions = md.versionsByMinecraftVersion?.pc;
    const base121Meta = pcVersions ? (pcVersions['1.21.4'] || pcVersions['1.21.1']) : null;

    if (base121 && pcVersions && base121Meta) {
        const extraVersions121 = [
            '1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.3', '1.21.2'
        ];
        for (const v of extraVersions121) {
            if (!data.pc[v]) {
                data.pc[v] = base121;
            }
            if (!pcVersions[v]) {
                pcVersions[v] = { ...base121Meta, minecraftVersion: v };
            }
            if (versionMod?.testedVersions && !versionMod.testedVersions.includes(v)) {
                versionMod.testedVersions.push(v);
            }
        }
    }

    const base120 = data.pc['1.20.4'] || data.pc['1.20.1'];
    const base120Meta = pcVersions ? (pcVersions['1.20.4'] || pcVersions['1.20.1']) : null;
    if (base120 && pcVersions && base120Meta) {
        const extraVersions120 = ['1.20.10', '1.20.5'];
        for (const v of extraVersions120) {
            if (!data.pc[v]) {
                data.pc[v] = base120;
            }
            if (!pcVersions[v]) {
                pcVersions[v] = { ...base120Meta, minecraftVersion: v };
            }
            if (versionMod?.testedVersions && !versionMod.testedVersions.includes(v)) {
                versionMod.testedVersions.push(v);
            }
        }
    }
} catch (e) {
    // ignore
}

/**
 * Resolves any version string (like 1.21.11, auto, unknown) to a standard, fully supported Java Minecraft version.
 * @param {string} ver
 * @returns {string}
 */
export function resolveJavaVersion(ver) {
    if (!ver || ver === 'auto') return '1.21.4';
    const s = String(ver).trim();

    // 1.21.11 is a Bedrock / Geyser / ViaVersion client version. For Java connection, 1.21.4 is the standard.
    if (s === '1.21.11' || s === '1.21.10' || s === '1.21.9') {
        return '1.21.4';
    }

    // If it's a known tested version, keep it
    if (versionMod?.testedVersions?.includes(s) && s !== '1.21.11') {
        return s;
    }

    // If it's in 1.21 family, fall back to 1.21.4
    if (s.startsWith('1.21')) {
        return '1.21.4';
    }

    // If it's in 1.20 family, fall back to 1.20.4
    if (s.startsWith('1.20')) {
        return '1.20.4';
    }

    // If it's in 1.19 family, fall back to 1.19.4
    if (s.startsWith('1.19')) {
        return '1.19.4';
    }

    return s;
}

export default resolveJavaVersion;
