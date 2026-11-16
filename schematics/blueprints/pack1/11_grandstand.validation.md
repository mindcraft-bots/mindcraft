# Folder 11 grandstand compilation and validation

## Source and scope

This is a folder-11-only compilation record. The permanent source is [`11_grandstand.json`](11_grandstand.json:1); the binary is [`11_grandstand.schem`](../11_grandstand.schem). Dimensions are 13 × 8 × 9, volume 936. The JSON remains the sole geometry/state source and was preserved unchanged. Compilation used the existing [`BLUEPRINT_TOOLING.md`](../BLUEPRINT_TOOLING.md:1), [`compile_blueprint.py`](../compile_blueprint.py:122), and [`validate_blueprint.mjs`](../validate_blueprint.mjs:65); no tooling, source, dependencies, unrelated folder, or [`batch_report.md`](../batch_report.md) was changed. No live/server test was run.

## Binary compilation and validation

The compile command [`python3`](../compile_blueprint.py:204) [`schematics/compile_blueprint.py`](../compile_blueprint.py:204) [`compile`](../compile_blueprint.py:207) [`schematics/blueprints/11_grandstand.json`](11_grandstand.json:1) [`schematics/11_grandstand.schem`](../11_grandstand.schem) exited 0; its built-in nbtlib reload and independent full validation passed. A separate [`validate`](../compile_blueprint.py:210) invocation on the same source/output also exited 0. [`test-varints`](../compile_blueprint.py:213) exited 0, passing canonical 1–5 byte boundary encodings and rejecting an overlong encoding.

The gzip Sponge v2 NBT has root `Schematic`, `Version` Int 2, `DataVersion` Int 4189, typed dimensions/palette/block data, zero offset, and empty typed `BlockEntities`/`Entities` lists. Binary validation checked palette identity/IDs, complete canonical signed-byte-backed VarInt stream in x-fastest, z-next, y-next order, all voxels including air, volume, per-state counts, and 14 spot checks. Dimensions `[13,8,9]`; volume 936; non-air/air 369/567; palette entries 9; BlockData 936 bytes; compressed artifact 430 bytes; SHA-256 `bc7f88291fda4e85f66ff22854ab77f1bb9b4bff1c4fa1e9ab9f7b02aff2b801`.

### Canonical state counts

| State | Count |
| --- | ---: |
| `minecraft:air` | 567 |
| `minecraft:chest[facing=north,type=single,waterlogged=false]` | 1 |
| `minecraft:chiseled_nether_bricks` | 5 |
| `minecraft:lantern[hanging=true,waterlogged=false]` | 4 |
| `minecraft:nether_brick_fence[east=true,north=false,south=false,waterlogged=false,west=true]` | 17 |
| `minecraft:nether_brick_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]` | 5 |
| `minecraft:nether_bricks` | 193 |
| `minecraft:quartz_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]` | 27 |
| `minecraft:smooth_quartz_slab[type=bottom,waterlogged=false]` | 117 |

## Registry and production-reader result

[`node`](../validate_blueprint.mjs:1) [`schematics/validate_blueprint.mjs`](../validate_blueprint.mjs:65) on the JSON and schematic exited 0. All 9/9 legend states passed the Minecraft 1.21.4 registry check; the production [`readSchematic()`](../../src/utils/schematic/reader.js:173) path compared 936/936 voxels and full properties. Reader-derived counts matched, spot checks passed 14/14, count diffs 0, spot failures 0, parser mismatches 0, `fullVoxelAndStateComparison=PASS`.

## Determinism and artifact checks

Recompiled from the unchanged JSON to a temporary path with [`compile`](../compile_blueprint.py:207); the temporary output hash matched the permanent SHA-256 above. The owned temporary directory was removed after comparison. Both source JSON and output schematic passed nonempty checks. The chest is the single default-empty chest; no inventory or block-entity NBT was added.

## Reconstruction limitations

The printed track-footprint dimensions are limited to hairpin 24 × 12, turn 12 × 12, and starting grid 9 × 19. The starting-gate mechanism retains seven pistons, an eight-position length, and two-block powder height, but the pit wording is ambiguous; its two-lane/below-road interpretation is inferred. The gate artifact is unpowered/lowered. Arch dimensions, post forms, banner placements, grandstand/fence dimensions, and pixel patterns are inferred where not dimensioned. Only six reusable components are represented; there is no fully dimensioned complete course. Full landscaping is explicitly customizable and excluded (including trees, river, horses, and riders). Grandstand footprint, total height, three-tier seating, aisle/rail placements, roof overhang and half-slab height are not printed dimensions and are inferred from oblique views. Chest optional contents are omitted; it remains empty/default. No fluids, entities, complex NBT, live tests, or physics tests were performed; binary/parser validation does not certify image-perfect geometry.
