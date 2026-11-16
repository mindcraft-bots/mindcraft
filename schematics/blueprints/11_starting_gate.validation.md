# Folder 11 starting gate compilation and validation

## Source and scope

This is a folder-11-only compilation record. The permanent source is [`11_starting_gate.json`](11_starting_gate.json:1); the binary is [`11_starting_gate.schem`](../11_starting_gate.schem). The explicit source dimensions are 11 × 11 × 7, with 847 voxels. The JSON remains the sole geometry/state source and was preserved unchanged. Compilation used the existing [`BLUEPRINT_TOOLING.md`](../BLUEPRINT_TOOLING.md:1), [`compile_blueprint.py`](../compile_blueprint.py:122), and [`validate_blueprint.mjs`](../validate_blueprint.mjs:65); no tooling, source, dependencies, unrelated folder, or [`batch_report.md`](../batch_report.md) was changed. No live/server test was run.

## Binary compilation and validation

The compile command [`python3`](../compile_blueprint.py:204) [`schematics/compile_blueprint.py`](../compile_blueprint.py:204) [`compile`](../compile_blueprint.py:207) [`schematics/blueprints/11_starting_gate.json`](11_starting_gate.json:1) [`schematics/11_starting_gate.schem`](../11_starting_gate.schem) exited 0; its built-in nbtlib reload and independent full validation passed. A separate [`validate`](../compile_blueprint.py:210) invocation on the same source/output also exited 0. [`test-varints`](../compile_blueprint.py:213) exited 0, passing canonical 1–5 byte boundary encodings and rejecting an overlong encoding.

The gzip Sponge v2 NBT has root `Schematic`, `Version` Int 2, `DataVersion` Int 4189, typed dimensions/palette/block data, zero offset, and empty typed `BlockEntities`/`Entities` lists. Binary validation checked palette identity/IDs, complete canonical signed-byte-backed VarInt stream in x-fastest, z-next, y-next order, all voxels including air, volume, per-state counts, and 13 spot checks. Dimensions `[11,11,7]`; volume 847; non-air/air 184/663; palette entries 18; BlockData 847 bytes; compressed artifact 587 bytes; SHA-256 `87513d6ebc09d42eaf125b860c2196844d825a9cf8c84a4635362225c8ab846d`.

### Canonical state counts

| State | Count |
| --- | ---: |
| `minecraft:air` | 663 |
| `minecraft:chiseled_nether_bricks` | 2 |
| `minecraft:dirt` | 27 |
| `minecraft:grass_block[snowy=false]` | 27 |
| `minecraft:gray_concrete` | 38 |
| `minecraft:lantern[hanging=true,waterlogged=false]` | 2 |
| `minecraft:lever[face=floor,facing=north,powered=false]` | 1 |
| `minecraft:light_gray_concrete_powder` | 6 |
| `minecraft:nether_brick_fence[east=false,north=false,south=false,waterlogged=false,west=false]` | 6 |
| `minecraft:nether_brick_slab[type=bottom,waterlogged=false]` | 9 |
| `minecraft:nether_bricks` | 16 |
| `minecraft:redstone_wire[east=none,north=none,power=0,south=none,west=side]` | 1 |
| `minecraft:redstone_wire[east=side,north=none,power=0,south=none,west=none]` | 1 |
| `minecraft:redstone_wire[east=side,north=none,power=0,south=none,west=side]` | 6 |
| `minecraft:sticky_piston[extended=false,facing=up]` | 7 |
| `minecraft:white_concrete` | 22 |
| `minecraft:white_concrete_powder` | 8 |
| `minecraft:white_wall_banner[facing=north]` | 5 |

## Registry and production-reader result

[`node`](../validate_blueprint.mjs:1) [`schematics/validate_blueprint.mjs`](../validate_blueprint.mjs:65) on the JSON and schematic exited 0. All 18/18 legend states passed the Minecraft 1.21.4 registry check; the production [`readSchematic()`](../../src/utils/schematic/reader.js:173) path compared 847/847 voxels and full properties. Reader-derived counts matched, spot checks passed 13/13, count diffs 0, spot failures 0, parser mismatches 0, `fullVoxelAndStateComparison=PASS`.

## Determinism and artifact checks

Recompiled from the unchanged JSON to a temporary path with [`compile`](../compile_blueprint.py:207); the temporary output hash matched the permanent SHA-256 above. The owned temporary directory was removed after comparison. Both source JSON and output schematic passed nonempty checks.

## Reconstruction limitations

The printed track-footprint dimensions are limited to hairpin 24 × 12, turn 12 × 12, and starting grid 9 × 19. The gate mechanism retains the stated seven pistons, eight-position length, and two-block powder height, but the pit wording is ambiguous; its two-lane/below-road interpretation is inferred. The gate is saved unpowered/lowered (retracted), not in the alternate raised-powder vignette. Gate arch dimensions/rise, post form, banner number/locations/supports, and all unprinted geometry/pixel patterns are inferred. No printed dimensions establish a complete course: these are six reusable components only. Full landscape is explicitly customizable and excluded (including trees, river, horses, and riders); no complete landscaped course is claimed. The optional grandstand chest is default-empty. Oblique-image reconstruction is not a voxel-perfect visual claim; no fluids, entities, complex NBT, physics, gravity, or redstone behavior was tested.
