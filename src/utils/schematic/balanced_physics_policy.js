// Balanced-only positive policy. "Placeable", "solid", or absence from a
// hazard denylist is NOT enough: sponge absorbs remotely, pistons move blocks,
// and even a passive conductor can complete an existing redstone circuit.
// Additions require review of placement/update behavior, not just item lookup.
const PASSIVE = new Set([
  "air", "cave_air", "void_air",
  "stone", "granite", "polished_granite", "diorite", "polished_diorite", "andesite", "polished_andesite",
  "deepslate", "cobbled_deepslate", "polished_deepslate", "deepslate_bricks", "cracked_deepslate_bricks",
  "deepslate_tiles", "cracked_deepslate_tiles", "tuff", "calcite", "cobblestone", "mossy_cobblestone",
  "stone_bricks", "mossy_stone_bricks", "cracked_stone_bricks", "chiseled_stone_bricks", "smooth_stone",
  "bricks", "mud_bricks", "packed_mud", "sandstone", "cut_sandstone", "chiseled_sandstone", "smooth_sandstone",
  "red_sandstone", "cut_red_sandstone", "chiseled_red_sandstone", "smooth_red_sandstone",
  "dirt", "coarse_dirt", "rooted_dirt", "grass_block", "podzol", "mycelium", "mud", "clay",
  "netherrack", "end_stone", "end_stone_bricks", "basalt", "polished_basalt", "smooth_basalt",
  "blackstone", "polished_blackstone", "chiseled_polished_blackstone", "polished_blackstone_bricks",
  "cracked_polished_blackstone_bricks", "nether_bricks", "red_nether_bricks", "cracked_nether_bricks",
  "chiseled_nether_bricks", "quartz_block", "quartz_bricks", "chiseled_quartz_block", "smooth_quartz",
  "quartz_pillar", "purpur_block", "purpur_pillar", "glass", "tinted_glass", "terracotta",
]);
const AXIS = new Set(["deepslate", "basalt", "polished_basalt", "quartz_pillar", "purpur_pillar"]);
const SNOWY = new Set(["grass_block", "podzol", "mycelium"]);
for (const wood of ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak"]) {
  PASSIVE.add(`${wood}_planks`);
  for (const name of [`${wood}_log`, `${wood}_wood`, `stripped_${wood}_log`, `stripped_${wood}_wood`]) {
    PASSIVE.add(name);
    AXIS.add(name);
  }
}
for (const color of ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"]) {
  for (const material of ["wool", "concrete", "terracotta", "stained_glass"]) PASSIVE.add(`${color}_${material}`);
}

// Reviewed, stateless singleton obstructions only. This is intentionally not
// the broader legacy natural-obstruction policy: saplings, fungi and crops can
// grow/spread or have state-dependent behavior while asynchronous work waits.
const CLEARABLE = new Set([
  "short_grass", "fern", "dead_bush", "dandelion", "poppy", "blue_orchid", "allium",
  "azure_bluet", "red_tulip", "orange_tulip", "white_tulip", "pink_tulip",
  "oxeye_daisy", "cornflower", "lily_of_the_valley", "torchflower",
]);

/** Local passive-state classification, NOT a universal physics simulator. */
export function isSupportedBalancedPassiveState(registry, state) {
  if (!PASSIVE.has(state?.name)) return false;
  const definition = registry?.blocksByName?.[state.name];
  const properties = state.properties;
  if (!definition || !Array.isArray(definition.states) || !properties || typeof properties !== "object" || Array.isArray(properties)) return false;
  const expected = AXIS.has(state.name) ? ["axis"] : SNOWY.has(state.name) ? ["snowy"] : [];
  const names = Object.keys(properties);
  if (names.length !== expected.length || definition.states.length !== expected.length) return false;
  return definition.states.every(item => {
    if (!expected.includes(item.name) || !Object.hasOwn(properties, item.name)) return false;
    const value = properties[item.name];
    if (item.name === "axis") return item.type === "enum" && ["x", "y", "z"].includes(value) && item.values?.includes(value);
    return item.name === "snowy" && item.type === "bool" && typeof value === "boolean";
  });
}

/** Only these additional states may exist inside the volume awaiting clearing. */
export function isSupportedBalancedClearableState(registry, state) {
  const definition = registry?.blocksByName?.[state?.name];
  return CLEARABLE.has(state?.name) && Array.isArray(definition?.states) && definition.states.length === 0
    && state.properties != null && typeof state.properties === "object" && !Array.isArray(state.properties)
    && Object.keys(state.properties).length === 0;
}

export function assertBalancedTargets(bot, build) {
  for (const cell of build.cells) {
    const definition = bot.registry?.blocksByStateId?.[cell.stateId];
    if (!isSupportedBalancedPassiveState(bot.registry, cell) || definition?.name !== cell.name) {
      throw Object.assign(new Error(`Unsupported balanced target ${cell.name} at ${cell.position.x},${cell.position.y},${cell.position.z}: only reviewed passive block states are supported`), { code: "SCHEMATIC_SITE_UNSAFE" });
    }
  }
}

// A two-step local screen includes diagonal/above redstone and piston/quasi-
// connectivity neighbors, not merely six face neighbors. This is deliberately
// NOT a claim that all Minecraft effects stop at a fixed distance. Safety also
// depends on the positive target policy; active sources cannot be put here and
// justified by an empty halo. Remote light/tick/plugin effects are not modeled.
export const BALANCED_NEIGHBOR_MARGIN = 2;

export function balancedCandidateExtraReads(build) {
  const { width, height, length } = build.dimensions;
  const padding = 2 * BALANCED_NEIGHBOR_MARGIN;
  return width * length + (width + padding) * (height + padding) * (length + padding) - width * height * length;
}
