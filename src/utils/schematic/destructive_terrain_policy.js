import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const minecraftData = require("minecraft-data");

// This is only a material classification, not authorization to edit. A caller
// must separately establish exact mismatch, bounds, identity, occupancy and
// surrounding physics, and revalidate its approved snapshot before each write.
// Player-placed and naturally generated blocks cannot be distinguished here.
const REVIEWED_TERRAIN = new Set(["dirt", "stone"]);

export function isReviewedDestructiveTerrain(bot, block) {
  try {
    if (!REVIEWED_TERRAIN.has(block?.name) || block.diggable !== true
        || block.entity != null || block.blockEntity != null
        || block._blockEntity != null || block.nbt != null) return false;
    const vanilla = minecraftData(bot?.version)?.blocksByName?.[block.name];
    const current = bot?.registry?.blocksByName?.[block.name];
    if (!vanilla || !current || vanilla.id !== current.id
        || vanilla.minStateId !== current.minStateId || vanilla.maxStateId !== current.maxStateId
        || !Array.isArray(vanilla.states) || vanilla.states.length !== 0
        || !Array.isArray(current.states) || current.states.length !== 0) return false;
    const properties = typeof block.getProperties === "function"
      ? block.getProperties() : (block._properties ?? block.properties);
    return properties != null && typeof properties === "object" && !Array.isArray(properties)
      && Object.keys(properties).length === 0;
  } catch {
    return false;
  }
}
