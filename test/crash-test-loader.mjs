// ESM loader for test/crash-regressions.mjs.
// mcdata.js only fills its data after a real bot logs in to a Minecraft server.
// The regression script must not contact a server, so swap in a minimal module
// whose getItemCraftingRecipes() returns null, exactly the crash precondition.
const MOCK_SOURCE = `
export function getItemCraftingRecipes() { return null; }
export function getItemBlockSources() { return []; }
export function getBlockTool() { return null; }
export function getItemSmeltingIngredient() { return undefined; }
export function getItemAnimalSource() { return undefined; }
export function mustCollectManually() { return false; }
export function getBlockId() { return null; }
export function getAllBlockIds() { return []; }
export function getBlockName() { return null; }
export function getItemId() { return null; }
export function getItemName() { return null; }
export function isSmeltable() { return false; }
export function getSmeltingFuel() { return 0; }
export function getFuelSmeltOutput() { return 0; }
export function makeItem() { return null; }
export function ingredientsFromPrismarineRecipe() { return {}; }
export function calculateLimitingResource() { return 0; }
export function initializeLoopingItems() {}
export function getDetailedCraftingPlan() { return {}; }
export function initBot() { throw new Error('test stub: no Minecraft connection'); }
export function isHuntable() { return false; }
export function isHostile() { return false; }
export const WOOD_TYPES = [];
export const MATCHING_WOOD_BLOCKS = [];
`;

export async function resolve(specifier, context, nextResolve) {
    const result = await nextResolve(specifier, context);
    if (result.url.endsWith('/src/utils/mcdata.js')) {
        return { url: 'mock:mcdata', format: 'module', shortCircuit: true };
    }
    return result;
}

export async function load(url, context, nextLoad) {
    if (url === 'mock:mcdata') {
        return { format: 'module', source: MOCK_SOURCE, shortCircuit: true };
    }
    return nextLoad(url, context);
}
