# Wardrobe Nether Portal schematic validation

## Artifacts

- Source blueprint: [`wardrobe_nether_portal.json`](wardrobe_nether_portal.json) — 8,640 bytes; retained unchanged.
- Compiled schematic: [`wardrobe_nether_portal.schem`](../wardrobe_nether_portal.schem) — 535 bytes.
- Sponge v2 gzip NBT: root name Schematic; Version 2; DataVersion 4189; dimensions 6 × 7 × 4; Offset [0, 0, 0].
- Tag types verified: Version and DataVersion Int; dimensions Short; Offset IntArray; Palette Compound with Int indices; PaletteMax Int; BlockData ByteArray; empty BlockEntities and Entities List[Compound]. Palette has 16 contiguous indices (0–15); block data decodes to exactly 168 bounded VarInts in Y-Z-X order, with X fastest.

## Static verification

- Source layer/row dimensions and explicit cells: valid; 168 total cells.
- Source full-state expected counts: exact match; 90 non-air and 78 air.
- Blueprint spot checks: 21/21 pass.
- Reloaded NBT and gzip magic: pass; every decoded cell matches the source state, 168/168.
- No fluid states, entity records, or block-entity/custom payload records.
- Mindcraft [`readSchematic()`](../../src/utils/schematic/reader.js:173) using Minecraft 1.21.4: pass; dimensions 6 × 7 × 4 and all 168 decoded names/states match the blueprint cell-for-cell. Boolean properties are compared using registry-typed booleans.
- Public command parser test: pass ([`node --test test/schematic/commands.test.js`](../../test/schematic/commands.test.js:53)). This is static verification only; no in-game build was executed.

## Full-state counts

| Full state (as authored in the source legend) | Count |
|---|---:|
| [`minecraft:air`](wardrobe_nether_portal.json:39) | 78 |
| [`minecraft:dark_oak_button[face=wall,facing=north,powered=false]`](wardrobe_nether_portal.json:44) | 2 |
| [`minecraft:dark_oak_door[facing=south,half=lower,hinge=left,open=true,powered=false]`](wardrobe_nether_portal.json:45) | 1 |
| [`minecraft:dark_oak_door[facing=south,half=lower,hinge=right,open=true,powered=false]`](wardrobe_nether_portal.json:46) | 1 |
| [`minecraft:dark_oak_door[facing=south,half=upper,hinge=left,open=true,powered=false]`](wardrobe_nether_portal.json:47) | 1 |
| [`minecraft:dark_oak_door[facing=south,half=upper,hinge=right,open=true,powered=false]`](wardrobe_nether_portal.json:48) | 1 |
| [`minecraft:dark_oak_planks`](wardrobe_nether_portal.json:40) | 30 |
| [`minecraft:dark_oak_slab[type=bottom,waterlogged=false]`](wardrobe_nether_portal.json:43) | 2 |
| [`minecraft:dark_oak_stairs[facing=south,half=top,shape=straight,waterlogged=false]`](wardrobe_nether_portal.json:42) | 4 |
| [`minecraft:dark_oak_trapdoor[facing=north,half=top,open=true,powered=false,waterlogged=false]`](wardrobe_nether_portal.json:49) | 2 |
| [`minecraft:oak_trapdoor[facing=east,half=bottom,open=true,powered=false,waterlogged=false]`](wardrobe_nether_portal.json:51) | 10 |
| [`minecraft:oak_trapdoor[facing=south,half=bottom,open=false,powered=false,waterlogged=false]`](wardrobe_nether_portal.json:52) | 8 |
| [`minecraft:oak_trapdoor[facing=west,half=bottom,open=true,powered=false,waterlogged=false]`](wardrobe_nether_portal.json:50) | 10 |
| [`minecraft:obsidian`](wardrobe_nether_portal.json:41) | 16 |
| [`minecraft:white_wall_banner[facing=east]`](wardrobe_nether_portal.json:53) | 1 |
| [`minecraft:white_wall_banner[facing=west]`](wardrobe_nether_portal.json:54) | 1 |
| **Total** | **168** |

## Build command

The action accepts a schematic filename and optionally all three placement coordinates together. Build near the bot without explicit placement coordinates using [`!buildSchematic("wardrobe_nether_portal.schem")`](../../src/agent/commands/actions.js:492). For explicit placement, use [`!buildSchematic("wardrobe_nether_portal.schem", 100, 64, -20)`](../../src/agent/commands/actions.js:496). The public command reads files from the schematics folder; the filename is not a blueprint path.
