> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/04_pagoda.json schematics/schems/pack1/04_pagoda.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/04_pagoda.json schematics/schems/pack1/04_pagoda.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/04_pagoda.json schematics/schems/pack1/04_pagoda.schem 1.21.4
> ```

# Folder 04 compilation and verification — Pagoda

## Current production-reader result — 2026-11-15 repair

**PASS:** all 9,360 voxels, exact block states/counts and all 19 spot checks now match. The original 4 mismatched voxels were caused by the shared dependency encoding one-based integer values as literal offsets instead of registry value indices. The [narrow dependency patch](../../../patches/prismarine-schematic+1.3.0.patch) repairs the reader without altering this blueprint or schematic; both hashes match the [preserved baseline](../../tooling/validation/reader_baseline.json). See the [current batch diagnosis and placement limitations](../../schems/pack1/batch_report.md) and [fresh production-reader log](../../tooling/validation/pack1/build_logs/pre_relocation/04_pagoda.reader.log). This does not certify live placement or remove reconstruction/physics limitations. The initial narrative below is retained as historical evidence, including its now-resolved reader-failure statements.

## Original reconstruction validation — before reader repair

## Inputs and audit interpretation

- Permanent source: [04_pagoda.json](04_pagoda.json), preserved unchanged.
- Compiled artifact: [04_pagoda.schem](../../schems/pack1/04_pagoda.schem).
- Source images, inspected in recorded order: [IMG_20261115_155906-1536x1152.jpg](../../screenshots/pack1/4/IMG_20261115_155906-1536x1152.jpg), then [IMG_20261115_155915-1536x1152.jpg](../../screenshots/pack1/4/IMG_20261115_155915-1536x1152.jpg).
- Dimensions are 15×39×16 (X×Y×Z), including front stairs and lanterns: the northwest bottom podium corner is origin (0,0,0), +X east, +Y up, +Z south/front, with zero schematic offset. The podium spans x=0..14 and z=0..14; attachments extend to z=15.
- Diagram labels indicate a 15×15 outer foundation and 7×7 central dark square; the ground walls are printed as four blocks high. The first-step prose ambiguously appears to state “2×2”; that conflicts with the diagram, so the blueprint follows the labeled diagram, not 2×2.
- The printed material notes guide the stone/black foundation, mangrove-and-wool walls, glass, oxidized copper eaves, and gold/anvil/iron finial selections. Some fine details are interpretations: upper floor and room dimensions, elevations, roof courses, hidden supports/backing, exact half-block/corner distribution, window symmetry, ladder run, furnishings, plant species/locations, and finial arrangement. Only two rooms have shown furnishing arrangements; higher interiors are left empty. These uncertainties are recorded in the blueprint; the source geometry and states were not changed for verification.

## Commands and verification results

All commands ran from the repository root using the existing [compiler](../../tooling/compile_blueprint.py) and [validator](../../tooling/validate_blueprint.mjs). The required commands were:

- [`python3 schematics/compile_blueprint.py compile schematics/blueprints/04_pagoda.json schematics/04_pagoda.schem`](../../tooling/compile_blueprint.py:204) — PASS, exit 0; compiler reloaded and independently validated its output using nbtlib.
- [`python3 schematics/compile_blueprint.py validate schematics/blueprints/04_pagoda.json schematics/04_pagoda.schem`](../../tooling/compile_blueprint.py:221) — PASS, exit 0.
- [`python3 schematics/compile_blueprint.py test-varints`](../../tooling/compile_blueprint.py:213) — PASS, exit 0; canonical 1–5 byte boundary cases passed and overlong encodings were rejected.
- [`node schematics/validate_blueprint.mjs schematics/blueprints/04_pagoda.json schematics/04_pagoda.schem`](../../tooling/validate_blueprint.mjs:65) — exit 2 due to the production-reader discrepancy below. All 41 legend states passed Minecraft 1.21.4 registry validation before voxel comparison.
- Determinism: compiled the same JSON to `/tmp/04_pagoda.schem`; `cmp -s schematics/04_pagoda.schem /tmp/04_pagoda.schem` returned 0 and SHA-256 hashes matched.

### Binary and registry facts

| Check | Verified result |
|---|---|
| Format | Gzip-compressed Sponge schematic Version 2; DataVersion 4189 |
| Root and NBT tags | Root name Schematic. Version/DataVersion/PaletteMax are Int; Width/Height/Length are Short; Offset is IntArray; Palette is Compound with Int values; BlockData is ByteArray; BlockEntities and Entities are empty List[Compound]. All expected tag types passed validation. |
| Dimensions / volume | 15×39×16 / 9,360 voxels |
| Non-air / air | 2,468 / 6,892 |
| Palette | 41 unique canonical states; zero-based, contiguous Int IDs; exactly matched the blueprint palette |
| VarInts | 9,360 canonical one-byte VarInts for 9,360 voxels (all 41 palette indices are 0–40); complete stream in x-fastest, then z, then y order; every value is within PaletteMax and the full decoded volume matched the blueprint |
| Binary voxel/count checks | PASS: all 9,360 canonical states, including air, matched the explicit blueprint volume; expected counts matched |
| Binary spot checks | PASS: 19 of 19 |
| Minecraft 1.21.4 registry | PASS: all 41 legend states have valid vanilla block names, complete property sets, and legal property values; no registry mismatch |
| Production [readSchematic()](../../../src/utils/schematic/reader.js:173) | 9,360/9,360 voxels were visited including air; dimensions and all 19 spots matched. Full canonical voxel/state comparison FAIL: four voxels differ, all at (4,8,10), (10,8,10), (4,9,10), and (10,9,10). Expected `minecraft:oak_leaves[distance=7,persistent=true,waterlogged=false]`; production parser returned `minecraft:spruce_leaves[distance=1,persistent=true,waterlogged=false]` at each. Parser-derived counts consequently differ by oak leaves 4 expected / 0 actual and spruce leaves 0 expected / 4 actual. |
| Interpretation | Explicit registry validation and independent raw-NBT validation pass; the mismatch is in the production parser's state conversion, not a registry rejection or a blueprint edit. The parser discrepancy is reported as-is. |

### Blueprint state counts

| Canonical state | Count |
|---|---:|
| minecraft:air | 6,892 |
| minecraft:anvil[facing=north] | 3 |
| minecraft:barrel[facing=south,open=false] | 9 |
| minecraft:barrel[facing=up,open=false] | 2 |
| minecraft:black_concrete | 169 |
| minecraft:cyan_carpet | 4 |
| minecraft:glass_pane[east=false,north=true,south=true,waterlogged=false,west=false] | 33 |
| minecraft:glass_pane[east=true,north=false,south=false,waterlogged=false,west=true] | 24 |
| minecraft:glass_pane[east=true,north=true,south=true,waterlogged=false,west=false] | 1 |
| minecraft:gold_block | 1 |
| minecraft:iron_bars[east=false,north=false,south=false,waterlogged=false,west=false] | 1 |
| minecraft:ladder[facing=west,waterlogged=false] | 22 |
| minecraft:lantern[hanging=false,waterlogged=false] | 2 |
| minecraft:lantern[hanging=true,waterlogged=false] | 18 |
| minecraft:mangrove_fence[east=false,north=false,south=false,waterlogged=false,west=false] | 12 |
| minecraft:mangrove_fence[east=false,north=false,south=false,waterlogged=false,west=true] | 1 |
| minecraft:mangrove_fence[east=false,north=true,south=false,waterlogged=false,west=false] | 2 |
| minecraft:mangrove_fence[east=false,north=true,south=true,waterlogged=false,west=false] | 52 |
| minecraft:mangrove_fence[east=true,north=false,south=false,waterlogged=false,west=false] | 1 |
| minecraft:mangrove_fence[east=true,north=false,south=false,waterlogged=false,west=true] | 45 |
| minecraft:mangrove_fence[east=true,north=false,south=true,waterlogged=false,west=true] | 2 |
| minecraft:mangrove_planks | 1,023 |
| minecraft:mangrove_slab[type=top,waterlogged=false] | 4 |
| minecraft:mangrove_stairs[facing=east,half=top,shape=straight,waterlogged=false] | 11 |
| minecraft:mangrove_stairs[facing=north,half=bottom,shape=straight,waterlogged=false] | 4 |
| minecraft:mangrove_stairs[facing=north,half=top,shape=straight,waterlogged=false] | 10 |
| minecraft:mangrove_stairs[facing=south,half=top,shape=straight,waterlogged=false] | 10 |
| minecraft:mangrove_stairs[facing=west,half=top,shape=straight,waterlogged=false] | 11 |
| minecraft:mossy_stone_bricks | 6 |
| minecraft:oak_leaves[distance=7,persistent=true,waterlogged=false] | 4 |
| minecraft:potted_oak_sapling | 2 |
| minecraft:stone_brick_stairs[facing=north,half=bottom,shape=straight,waterlogged=false] | 6 |
| minecraft:stone_bricks | 276 |
| minecraft:waxed_oxidized_cut_copper | 47 |
| minecraft:waxed_oxidized_cut_copper_slab[type=bottom,waterlogged=false] | 128 |
| minecraft:waxed_oxidized_cut_copper_slab[type=top,waterlogged=false] | 65 |
| minecraft:waxed_oxidized_cut_copper_stairs[facing=east,half=bottom,shape=straight,waterlogged=false] | 47 |
| minecraft:waxed_oxidized_cut_copper_stairs[facing=north,half=bottom,shape=straight,waterlogged=false] | 47 |
| minecraft:waxed_oxidized_cut_copper_stairs[facing=south,half=bottom,shape=straight,waterlogged=false] | 47 |
| minecraft:waxed_oxidized_cut_copper_stairs[facing=west,half=bottom,shape=straight,waterlogged=false] | 47 |
| minecraft:white_wool | 269 |

### Artifacts

| Artifact | Size | SHA-256 |
|---|---:|---|
| [04_pagoda.json](04_pagoda.json) | 31,559 bytes | `8e49d9c1e0943ab7fecfbcdcfd2eb1255bd125c79eb2566217a7e9d7fa331529` |
| [04_pagoda.schem](../../schems/pack1/04_pagoda.schem) | 1,413 bytes | `42858a838218a29e250c8176be52bf7d74bca18f7caed6b692c806578a8f8a44` |
| Temporary deterministic recompile, `/tmp/04_pagoda.schem` | 1,413 bytes | `42858a838218a29e250c8176be52bf7d74bca18f7caed6b692c806578a8f8a44` |

Both permanent artifacts are nonempty. The deterministic recompile was byte-identical.

## Limitations

The blueprint preserves explicit source-audit uncertainties: the foundation prose/diagram conflict; no printed overall height or upper-room measurements; inferred room/floor/roof proportions and concealed supports; appearance-based material interpretations; and inferred furnishing, foliage, window, and finial details. It is a measured interpretation of the supplied views, not proof of exact photographic recovery. No live-server placement or world test was performed; these checks establish local format, registry, and artifact consistency only, not placement, neighbor-update stability, or in-game behavior. No source, dependency, blueprint, or unrelated report was modified for validation; the permanent JSON and compiled schematic are both retained.
