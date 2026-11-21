> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. The compilation example writes to a fresh temporary file, never to the preserved original.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/01_wardrobe_nether_portal.json "$(mktemp --suffix=.schem)"
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/01_wardrobe_nether_portal.json schematics/schems/pack1/01_wardrobe_nether_portal.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/01_wardrobe_nether_portal.json schematics/schems/pack1/01_wardrobe_nether_portal.schem 1.21.4
> ```

## Relocated pack audit result

The current `pack1` audit reports this schematic's binary validation and production-reader comparison as **PASS** (168/168 full-state voxels). The deterministic compiler output is byte-different from the preserved canonical file: existing SHA-256 `8deb5fee1a8930b321ad9ff066b955854bb4caedf8f5a8cf17eb710c5da7a383`, current temporary rebuild `a6ec7d5919590a27d895af6081a8080ae2b804e271a45c247d4a56164ecea886`. No canonical schematic was overwritten; the difference is retained and reported by the audit. See [`batch_validation.json`](../../tooling/validation/pack1/batch_validation.json) and the [`determinism log`](../../tooling/validation/pack1/build_logs/01_wardrobe_nether_portal.determinism.log) for the latest run.

Exact header/NBT/palette diagnosis, original-commit verification, and the actionable reason for retaining the nonzero byte audit are in the [focused integration review](../../tooling/validation/pack1/integration_review.md). Do not recompile over the original asset; use a separate temporary output for investigation.

# Wardrobe Nether Portal schematic validation

## Artifacts

- Source blueprint: [`01_wardrobe_nether_portal.json`](01_wardrobe_nether_portal.json) — its geometry and block-state content are unchanged; only relocated source-image metadata was updated after the historical byte hash was recorded.
- Compiled schematic: [`01_wardrobe_nether_portal.schem`](../../schems/pack1/01_wardrobe_nether_portal.schem) — 535 bytes.
- Sponge v2 gzip NBT: root name Schematic; Version 2; DataVersion 4189; dimensions 6 × 7 × 4; Offset [0, 0, 0].
- Tag types verified: Version and DataVersion Int; dimensions Short; Offset IntArray; Palette Compound with Int indices; PaletteMax Int; BlockData ByteArray; empty BlockEntities and Entities List[Compound]. Palette has 16 contiguous indices (0–15); block data decodes to exactly 168 bounded VarInts in Y-Z-X order, with X fastest.

## Static verification

- Source layer/row dimensions and explicit cells: valid; 168 total cells.
- Source full-state expected counts: exact match; 90 non-air and 78 air.
- Blueprint spot checks: 21/21 pass.
- Reloaded NBT and gzip magic: pass; every decoded cell matches the source state, 168/168.
- No fluid states, entity records, or block-entity/custom payload records.
- Mindcraft [`readSchematic()`](../../../src/utils/schematic/reader.js:173) using Minecraft 1.21.4: pass; dimensions 6 × 7 × 4 and all 168 decoded names/states match the blueprint cell-for-cell. Boolean properties are compared using registry-typed booleans.
- Public command parser test: pass ([`node --test test/schematic/commands.test.js`](../../../test/schematic/commands.test.js:53)). This is static verification only; no in-game build was executed.

## Full-state counts

| Full state (as authored in the source legend) | Count |
|---|---:|
| [`minecraft:air`](01_wardrobe_nether_portal.json:39) | 78 |
| [`minecraft:dark_oak_button[face=wall,facing=north,powered=false]`](01_wardrobe_nether_portal.json:44) | 2 |
| [`minecraft:dark_oak_door[facing=south,half=lower,hinge=left,open=true,powered=false]`](01_wardrobe_nether_portal.json:45) | 1 |
| [`minecraft:dark_oak_door[facing=south,half=lower,hinge=right,open=true,powered=false]`](01_wardrobe_nether_portal.json:46) | 1 |
| [`minecraft:dark_oak_door[facing=south,half=upper,hinge=left,open=true,powered=false]`](01_wardrobe_nether_portal.json:47) | 1 |
| [`minecraft:dark_oak_door[facing=south,half=upper,hinge=right,open=true,powered=false]`](01_wardrobe_nether_portal.json:48) | 1 |
| [`minecraft:dark_oak_planks`](01_wardrobe_nether_portal.json:40) | 30 |
| [`minecraft:dark_oak_slab[type=bottom,waterlogged=false]`](01_wardrobe_nether_portal.json:43) | 2 |
| [`minecraft:dark_oak_stairs[facing=south,half=top,shape=straight,waterlogged=false]`](01_wardrobe_nether_portal.json:42) | 4 |
| [`minecraft:dark_oak_trapdoor[facing=north,half=top,open=true,powered=false,waterlogged=false]`](01_wardrobe_nether_portal.json:49) | 2 |
| [`minecraft:oak_trapdoor[facing=east,half=bottom,open=true,powered=false,waterlogged=false]`](01_wardrobe_nether_portal.json:51) | 10 |
| [`minecraft:oak_trapdoor[facing=south,half=bottom,open=false,powered=false,waterlogged=false]`](01_wardrobe_nether_portal.json:52) | 8 |
| [`minecraft:oak_trapdoor[facing=west,half=bottom,open=true,powered=false,waterlogged=false]`](01_wardrobe_nether_portal.json:50) | 10 |
| [`minecraft:obsidian`](01_wardrobe_nether_portal.json:41) | 16 |
| [`minecraft:white_wall_banner[facing=east]`](01_wardrobe_nether_portal.json:53) | 1 |
| [`minecraft:white_wall_banner[facing=west]`](01_wardrobe_nether_portal.json:54) | 1 |
| **Total** | **168** |

## Build command

The action accepts a pack-qualified stable ID or filename/stem and optionally all three placement coordinates together. Build near the bot without explicit placement coordinates using [`!buildSchematic("pack1:01:01")`](../../../src/agent/commands/actions.js:492). For explicit placement, use [`!buildSchematic("pack1:01:01", 100, 64, -20)`](../../../src/agent/commands/actions.js:496). The manifest mapping is in [`index.json`](../../schems/pack1/index.json); the `.schem` filename remains `01_wardrobe_nether_portal.schem`.
