> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/07_secret_island_base.json schematics/schems/pack1/07_secret_island_base.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/07_secret_island_base.json schematics/schems/pack1/07_secret_island_base.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/07_secret_island_base.json schematics/schems/pack1/07_secret_island_base.schem 1.21.4
> ```

# Folder 07 compilation and validation

## Current production-reader result — 2026-11-15 repair

**PASS:** all 4,056 voxels, exact block states/counts and all 29 spot checks now match. The original 36 mismatched voxels were caused by the shared dependency encoding one-based integer values as literal offsets instead of registry value indices. The [narrow dependency patch](../../../patches/prismarine-schematic+1.3.0.patch) repairs the reader without altering this blueprint or schematic; both hashes match the [preserved baseline](../../tooling/validation/reader_baseline.json). See the [current batch diagnosis and placement limitations](../../schems/pack1/batch_report.md) and [fresh production-reader log](../../tooling/validation/build_logs/pack1/07_secret_island_base.reader.log). This does not certify live placement or remove reconstruction/physics limitations. The initial narrative below is retained as historical evidence, including its now-resolved reader-failure statements.

## Original reconstruction validation — before reader repair

## Artifacts

- Source of truth: [`07_secret_island_base.json`](07_secret_island_base.json) — 21,380 bytes; SHA-256 `1669bce4d246a6edbcaca0b8a41c3604b62e8a1a2e7df95e6494ee15e7b8164b`.
- Compiled output: [`07_secret_island_base.schem`](../../schems/pack1/07_secret_island_base.schem) — 965 bytes; SHA-256 `38b8b48afb7e800b135ac73e9c088ed8ed4354982ac345cdb7901cf5ceede015`.
- Both permanent artifacts are nonempty. The JSON source was preserved unchanged.

## Compilation and binary validation

Compiled only this blueprint using [`compile_blueprint.py`](../../tooling/compile_blueprint.py) and `nbtlib`; compile succeeded. The independent `validate` invocation also succeeded. Confirmed gzip-compressed Sponge schematic v2, DataVersion 4189, correctly typed NBT tags, zero offset `[0,0,0]`, empty typed `BlockEntities` and `Entities` lists, complete palette and canonical x-fastest/z-next/y-next VarInt block stream. Dimensions are **13 × 24 × 13 = 4,056** voxels; palette has **32** full states; counts are **1,222 non-air** and **2,834 air**; all **29** binary spot checks pass. The block-data byte stream has 4,056 bytes and all voxel values, palette indices, expected counts, and spots passed the independent `nbtlib` reload validation.

The separate VarInt boundary test passed 1–5-byte canonical values and rejected an overlong encoding.

## Registry and production-reader validation

The existing [`validate_blueprint.mjs`](../../tooling/validate_blueprint.mjs) used the production `readSchematic` reader and the installed Minecraft 1.21.4 registry. All **32** legend states passed registry validation with complete canonical property sets. Dimensions matched and the reader compared all **4,056** voxels, including air. Of **29** reader spot checks, **28 passed and one failed** at `(6,23,7)` (`highest leaf`): expected `minecraft:spruce_leaves[distance=3,persistent=true,waterlogged=false]`, actual `minecraft:spruce_leaves[distance=4,persistent=true,waterlogged=false]`. Reader-derived air remained 2,834, but full palette/count comparison and full state comparison **failed with 36 voxel mismatches**, all in spruce leaf states; no geometry or intended state values were changed to mask this.

Count differences reported by the production validator:

| Canonical state | Expected | Reader |
| --- | ---: | ---: |
| `minecraft:birch_leaves[distance=1,persistent=true,waterlogged=false]` | 0 | 2 |
| `minecraft:spruce_leaves[distance=1,persistent=true,waterlogged=false]` | 13 | 0 |
| `minecraft:spruce_leaves[distance=2,persistent=true,waterlogged=false]` | 18 | 13 |
| `minecraft:spruce_leaves[distance=3,persistent=true,waterlogged=false]` | 3 | 18 |
| `minecraft:spruce_leaves[distance=4,persistent=true,waterlogged=false]` | 0 | 3 |
| `minecraft:spruce_leaves[distance=7,persistent=true,waterlogged=false]` | 2 | 0 |

The coordinate-level comparison found these 36 mismatches (coordinates are `(x,y,z)`):

- Expected spruce leaves `distance=1`, reader returned spruce leaves `distance=2` (13): `(6,20,4)`, `(3,20,7)`, `(9,20,7)`, `(6,20,10)`, `(6,21,5)`, `(6,21,6)`, `(4,21,7)`, `(5,21,7)`, `(6,21,7)`, `(7,21,7)`, `(8,21,7)`, `(6,21,8)`, `(6,21,9)`.
- Expected spruce leaves `distance=2`, reader returned spruce leaves `distance=3` (18): `(3,19,7)`, `(9,19,7)`, `(6,19,10)`, `(6,21,4)`, `(5,21,5)`, `(4,21,6)`, `(5,21,6)`, `(7,21,6)`, `(8,21,6)`, `(3,21,7)`, `(9,21,7)`, `(4,21,8)`, `(5,21,8)`, `(7,21,8)`, `(8,21,8)`, `(7,21,9)`, `(6,21,10)`, `(6,22,7)`.
- Expected spruce leaves `distance=3`, reader returned spruce leaves `distance=4` (3): `(5,22,6)`, `(7,22,8)`, `(6,23,7)`.
- Expected spruce leaves `distance=7`, reader returned birch leaves `distance=1` (2): `(4,22,5)`, `(8,22,9)`.

This is a parser state-ID/property conversion defect affecting leaf distance values, including a block-name conversion for two `distance=7` states. The binary NBT palette and binary validator retain the intended canonical spruce leaf states. The production-reader failure is reported as-is; no intended states were rewritten.

## Determinism

A second compile to a temporary directory succeeded. Its output matched the permanent schematic byte-for-byte; both hashes were `38b8b48afb7e800b135ac73e9c088ed8ed4354982ac345cdb7901cf5ceede015`, and both files were 965 bytes. The temporary output and its owned temporary directory were removed after comparison.

## Reconstruction scope and caveats

The foundation is a 13 × 13 symmetric chamfered footprint with row lengths `5, 9, 11, 11, 13, 13, 13, 13, 13, 11, 11, 9, 5`; the exact rasterization is inferred, not numerically specified. Eight inset purpur columns at `(4,1)`, `(8,1)`, `(1,4)`, `(11,4)`, `(1,8)`, `(11,8)`, `(4,11)`, `(8,11)` run from y=1 through y=10. Column insets, stair/capital footprints, stair orientations and halves, sill details, and end-rod placement are inferred from the renders. Stair bases are bottom-half at y=1; capitals are top-half at y=10.

The two central one-cell bores are at `(5,*,6)` and `(7,*,6)`, separated by purpur at x=6. Soul sand and magma are at y=0; the shafts are air through y=14. Closed south-facing spruce door pairs at x=5 and x=7, z=7 use inferred species and hinge states (west hinge right, east hinge left). Closed south-facing spruce trapdoors cover the bores at y=15. The roof is sandstone at y=11, sand at y=12, then inferred broad lower dirt and smaller upper grass terraces at y=13 and y=14. Their contours and hatch elevation are inferred.

The tree is an inferred sparse artificial bent spruce: logs span y=15–20 and persistent leaves y=19–23, with asymmetric branches/crown; hidden foliage and sparse grass are also inferred. These renders do not guarantee exact fidelity for hidden or occluded details. No surrounding ocean, seabed, fish, squid, player, scenery kelp, furniture, entities, fluids, block entities, or complex NBT are included. Water and bubble columns are deliberately absent, so the lifts are nonfunctional until water is supplied separately. No live-server tests were run.
