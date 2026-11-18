import md from 'minecraft-data';
import data from 'minecraft-data/data.js';
import versionMod from 'mineflayer/lib/version.js';

/**
 * Universal version compatibility patch for Mindcraft / Mineflayer.
 * 1. Polyfills missing '26.1' in minecraft-data which prismarine-chunk checks via mcData.version['>=']('26.1').
 * 2. Aliases synthetic Bedrock / Geyser / ViaVersion strings (1.21.11, 1.21.50, etc.) to 1.21.4 so
 *    minecraft-data, prismarine-registry, and mineflayer won't throw "Do not have data for 1.21.11".
 */

// 1. Fix prismarine-chunk RangeError for '26.1'
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

// 2. Universal Proxy fallback for data.pc and versionsByMinecraftVersion.pc
try {
    const originalDataPc = data.pc;
    const base121Data = originalDataPc['1.21.4'] || originalDataPc['1.21.1'];
    const base120Data = originalDataPc['1.20.4'] || originalDataPc['1.20.1'];
    const base119Data = originalDataPc['1.19.4'] || originalDataPc['1.19.2'];

    data.pc = new Proxy(originalDataPc, {
        get(target, prop) {
            if (typeof prop === 'string') {
                if (target[prop]) return target[prop];
                if (prop.startsWith('1.21') && base121Data) return base121Data;
                if (prop.startsWith('1.20') && base120Data) return base120Data;
                if (prop.startsWith('1.19') && base119Data) return base119Data;
            }
            return target[prop];
        }
    });

    const pcVersions = md.versionsByMinecraftVersion?.pc;
    if (pcVersions) {
        const baseMeta121 = pcVersions['1.21.4'] || pcVersions['1.21.1'];
        const baseMeta120 = pcVersions['1.20.4'] || pcVersions['1.20.1'];
        const baseMeta119 = pcVersions['1.19.4'] || pcVersions['1.19.2'];

        md.versionsByMinecraftVersion.pc = new Proxy(pcVersions, {
            get(target, prop) {
                if (typeof prop === 'string') {
                    if (target[prop]) return target[prop];
                    if (prop.startsWith('1.21') && baseMeta121) return { ...baseMeta121, minecraftVersion: prop };
                    if (prop.startsWith('1.20') && baseMeta120) return { ...baseMeta120, minecraftVersion: prop };
                    if (prop.startsWith('1.19') && baseMeta119) return { ...baseMeta119, minecraftVersion: prop };
                }
                return target[prop];
            }
        });
    }

    // Also populate testedVersions in mineflayer
    if (versionMod?.testedVersions) {
        const extraVersions = ['1.21.11', '1.21.10', '1.21.9', '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.20', '1.21.30', '1.21.40', '1.21.50'];
        for (const v of extraVersions) {
            if (!versionMod.testedVersions.includes(v)) {
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
    let s = String(ver).trim();

    // Extract numeric version if surrounded by modded server prefix like "Paper 1.21.11", "Geyser v1.21.11"
    const match = s.match(/\d+\.\d+(?:\.\d+)?/);
    if (match) {
        s = match[0];
    }

    // Bedrock / Geyser / ViaVersion client versions in 1.21 family bridge to 1.21.4
    if (s.startsWith('1.21')) {
        return '1.21.4';
    }

    // 1.20 family bridge to 1.20.4
    if (s.startsWith('1.20')) {
        return '1.20.4';
    }

    // 1.19 family bridge to 1.19.4
    if (s.startsWith('1.19')) {
        return '1.19.4';
    }

    // 1.18 family bridge to 1.18.2
    if (s.startsWith('1.18')) {
        return '1.18.2';
    }

    // 1.17 family bridge to 1.17.1
    if (s.startsWith('1.17')) {
        return '1.17.1';
    }

    // 1.16 family bridge to 1.16.5
    if (s.startsWith('1.16')) {
        return '1.16.5';
    }

    return '1.21.4';
}

export default resolveJavaVersion;
