# Folder 11 safety fence compilation and validation

## Source and scope

This is a folder-11-only compilation record. The permanent source is [`11_safety_fence.json`](11_safety_fence.json:1); the binary is [`11_safety_fence.schem`](../11_safety_fence.schem). Dimensions are 9 × 5 × 3, volume 135. The JSON remains the sole geometry/state source and was preserved unchanged. Compilation used the existing [`BLUEPRINT_TOOLING.md`](../BLUEPRINT_TOOLING.md:1), [`compile_blueprint.py`](../compile_blueprint.py:122), and [`validate_blueprint.mjs`](../validate_blueprint.mjs:65); no tooling, source, dependencies, unrelated folder, or [`batch_report.md`](../batch_report.md) was changed. No live/server test was run.

## Binary compilation and validation

The compile command [`python3`](../compile_blueprint.py:204) [`schematics/compile_blueprint.py`](../compile_blueprint.py:204) [`compile`](../compile_blueprint.py:207) [`schematics/blueprints/11_safety_fence.json`](11_safety_fence.json:1) [`schematics/11_safety_fence.schem`](../11_safety_fence.schem) exited 0; its built-in nbtlib reload and independent full validation passed. A separate [`validate`](../compile_blueprint.py:210) invocation on the same source/output also exited 0. [`test-varints`](../compile_blueprint.py:213) exited 0, passing canonical 1–5 byte boundary encodings and rejecting an overlong encoding.

The gzip Sponge v2 NBT has root `Schematic`, `Version` Int 2, `DataVersion` Int 4189, typed dimensions/palette/block data, zero offset, and empty typed `BlockEntities`/`Entities` lists. Binary validation checked palette identity/IDs, complete canonical signed-byte-backed VarInt stream in x-fastest, z-next, y-next order, all voxels including air, volume, per-state counts, and 7 spot checks. Dimensions `[9,5,3]`; volume 135; non-air/air 75/60; palette entries 7; BlockData 135 bytes; compressed artifact 299 bytes; SHA-256 `4fce019d0f984bd46dd8397c84e119277025aee35f367af1742d95f81e9e94c6`.

### Canonical state counts

| State | Count |
| --- | ---: |
| `minecraft:air` | 60 |
| `minecraft:dirt` | 27 |
| `minecraft:grass_block[snowy=false]` | 20 |
| `minecraft:nether_brick_fence[east=false,north=false,south=false,waterlogged=false,west=true]` | 3 |
| `minecraft:nether_brick_fence[east=true,north=false,south=false,waterlogged=false,west=false]` | 3 |
| `minecraft:nether_brick_fence[east=true,north=false,south=false,waterlogged=false,west=true]` | 15 |
| `minecraft:nether_bricks` | 7 |

## Registry and production-reader result

[`node`](../validate_blueprint.mjs:1) [`schematics/validate_blueprint.mjs`](../validate_blueprint.mjs:65) on the JSON and schematic exited 0. All 7/7 legend states passed the Minecraft 1.21.4 registry check; the production [`readSchematic()`](../../src/utils/schematic/reader.js:173) path compared 135/135 voxels and full properties. Reader-derived counts matched, spot checks passed 7/7, count diffs 0, spot failures 0, parser mismatches 0, `fullVoxelAndStateComparison=PASS`.

## Determinism and artifact checks

Recompiled from the unchanged JSON to a temporary path with [`compile`](../compile_blueprint.py:207); the temporary output hash matched the permanent SHA-256 above. The owned temporary directory was removed after comparison. Both source JSON and output schematic passed nonempty checks.

## Reconstruction limitations

The printed track-footprint dimensions are limited to hairpin 24 × 12, turn 12 × 12, and starting grid 9 × 19. The starting-gate mechanism retains seven pistons, an eight-position length, and two-block powder height, but the pit wording is ambiguous; its two-lane/below-road interpretation is inferred. The gate artifact is unpowered/lowered. Arch dimensions, post forms, banner placements, grandstand/fence dimensions, and pixel patterns are inferred where not dimensioned. Only six reusable components are represented; there is no fully dimensioned complete course. Full landscaping is explicitly customizable and excluded (including trees, river, horses, and riders). The fence vignette has no numeric scale: footprint, footing, three-layer height, lattice/end states and fence-block count are inferred from the image. Other scattered course rails are not exported. The grandstand chest is default-empty. No fluids, entities, complex NBT, live tests, or physics tests were performed; binary/parser validation does not certify image-perfect geometry.
