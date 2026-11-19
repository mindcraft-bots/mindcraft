import md from 'minecraft-data';
import data from 'minecraft-data/data.js';
import versionMod from 'mineflayer/lib/version.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Universal version compatibility patch for Mindcraft / Mineflayer.
 * 1. Polyfills missing '26.1' in minecraft-data which prismarine-chunk checks via mcData.version['>=']('26.1').
 * 2. Aliases synthetic Bedrock / Geyser / ViaVersion strings (1.21.11, 1.21.50, etc.) to 1.21.4 so
 *    minecraft-data, prismarine-registry, and mineflayer won't throw "Do not have data for 1.21.11".
 * 3. Bridges ViaVersion, ViaBackwards, and Geyser protocols seamlessly.
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
                if (base121Data) return base121Data;
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
                    if (baseMeta121) return { ...baseMeta121, minecraftVersion: prop };
                }
                return target[prop];
            }
        });
    }

    // Proxy data.bedrock and versionsByMinecraftVersion.bedrock for Geyser / Bedrock support
    if (data.bedrock) {
        const originalDataBedrock = data.bedrock;
        const baseBedrockData = originalDataBedrock['1.21.50'] || originalDataBedrock['1.21.0'] || originalDataBedrock['1.20.0'];
        data.bedrock = new Proxy(originalDataBedrock, {
            get(target, prop) {
                if (typeof prop === 'string') {
                    if (target[prop]) return target[prop];
                    if (prop.startsWith('1.21') && baseBedrockData) return baseBedrockData;
                    if (baseBedrockData) return baseBedrockData;
                }
                return target[prop];
            }
        });
    }

    const bedrockVersions = md.versionsByMinecraftVersion?.bedrock;
    if (bedrockVersions) {
        const baseMetaBedrock = bedrockVersions['1.21.50'] || bedrockVersions['1.21.0'] || bedrockVersions['1.20.0'];
        md.versionsByMinecraftVersion.bedrock = new Proxy(bedrockVersions, {
            get(target, prop) {
                if (typeof prop === 'string') {
                    if (target[prop]) return target[prop];
                    if (prop.startsWith('1.21') && baseMetaBedrock) return { ...baseMetaBedrock, minecraftVersion: prop };
                    if (baseMetaBedrock) return { ...baseMetaBedrock, minecraftVersion: prop };
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

    // Wrap require('minecraft-data') in CommonJS cache for complete coverage
    const mdPath = require.resolve('minecraft-data');
    if (require.cache[mdPath]) {
        const originalMdExport = require.cache[mdPath].exports;
        const wrappedMd = function(version, preNetty) {
            let result = originalMdExport(version, preNetty);
            if (!result) {
                const fallbackVer = resolveJavaVersion(version);
                result = originalMdExport(fallbackVer, preNetty);
            }
            return result;
        };
        Object.assign(wrappedMd, originalMdExport);
        require.cache[mdPath].exports = wrappedMd;
    }

    // Wrap require('prismarine-registry') in CommonJS cache
    const prPath = require.resolve('prismarine-registry');
    if (require.cache[prPath]) {
        const originalPrExport = require.cache[prPath].exports;
        require.cache[prPath].exports = function(version) {
            try {
                return originalPrExport(version);
            } catch (_) {
                return originalPrExport('1.21.4');
            }
        };
    }
} catch (e) {
    // ignore
}

/**
 * Resolves any version string (like 1.21.11, auto, unknown) to a standard, fully supported Java Minecraft version.
 * Compatible with ViaVersion, ViaBackwards, and Geyser.
 * @param {string} ver
 * @returns {string}
 */
export function resolveJavaVersion(ver) {
    if (!ver || ver === 'auto') return '1.21.4';
    let s = String(ver).trim();

    // Strip Bedrock / PocketEdition prefixes
    if (s.startsWith('pe_') || s.startsWith('bedrock_')) {
        s = s.replace(/^(pe_|bedrock_)/, '');
    }

    const sLower = s.toLowerCase();
    // Server setups running ViaVersion, ViaBackwards, or Geyser bridge to 1.21.4 protocol
    if (
        sLower.includes('viaversion') || 
        sLower.includes('viabackwards') || 
        sLower.includes('geyser') ||
        sLower.includes('bedrock') ||
        sLower.includes('1.21.11')
    ) {
        return '1.21.4';
    }

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
