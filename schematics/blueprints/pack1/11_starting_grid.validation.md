> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/11_starting_grid.json schematics/schems/pack1/11_starting_grid.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/11_starting_grid.json schematics/schems/pack1/11_starting_grid.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/11_starting_grid.json schematics/schems/pack1/11_starting_grid.schem 1.21.4
> ```

# Folder 11 starting grid compilation and validation

## Source and scope

This is a folder-11-only compilation record. The permanent source is [`11_starting_grid.json`](11_starting_grid.json:1); the binary is [`11_starting_grid.schem`](../../schems/pack1/11_starting_grid.schem). Dimensions are 9 × 3 × 19, volume 513. The JSON remains the sole geometry/state source and was preserved unchanged. Compilation used the existing [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md:1), [`compile_blueprint.py`](../../tooling/compile_blueprint.py:122), and [`validate_blueprint.mjs`](../../tooling/validate_blueprint.mjs:65); no tooling, source, dependencies, unrelated folder, or [`batch_report.md`](../../schems/pack1/batch_report.md) was changed. No live/server test was run.

## Binary compilation and validation

The compile command [`python3`](../../tooling/compile_blueprint.py:204) [`schematics/compile_blueprint.py`](../../tooling/compile_blueprint.py:204) [`compile`](../../tooling/compile_blueprint.py:207) [`schematics/blueprints/11_starting_grid.json`](11_starting_grid.json:1) [`schematics/11_starting_grid.schem`](../../schems/pack1/11_starting_grid.schem) exited 0; its built-in nbtlib reload and independent full validation passed. A separate [`validate`](../../tooling/compile_blueprint.py:210) invocation on the same source/output also exited 0. [`test-varints`](../../tooling/compile_blueprint.py:213) exited 0, passing canonical 1–5 byte boundary encodings and rejecting an overlong encoding.

The gzip Sponge v2 NBT has root `Schematic`, `Version` Int 2, `DataVersion` Int 4189, typed dimensions/palette/block data, zero offset, and empty typed `BlockEntities`/`Entities` lists. Binary validation checked palette identity/IDs, complete canonical signed-byte-backed VarInt stream in x-fastest, z-next, y-next order, all voxels including air, volume, per-state counts, and 8 spot checks. Dimensions `[9,3,19]`; volume 513; non-air/air 348/165; palette entries 6; BlockData 513 bytes; compressed artifact 312 bytes; SHA-256 `37becd6d5f84d877c949112f75e64cdb2f35ecee7abecb4ba978129efe4c3b5f`.

### Canonical state counts

| State | Count |
| --- | ---: |
| `minecraft:air` | 165 |
| `minecraft:dirt` | 171 |
| `minecraft:grass_block[snowy=false]` | 38 |
| `minecraft:gray_concrete` | 102 |
| `minecraft:nether_brick_fence[east=false,north=false,south=false,waterlogged=false,west=false]` | 6 |
| `minecraft:white_concrete` | 31 |

## Registry and production-reader result

[`node`](../../tooling/validate_blueprint.mjs:1) [`schematics/validate_blueprint.mjs`](../../tooling/validate_blueprint.mjs:65) on the JSON and schematic exited 0. All 6/6 legend states passed the Minecraft 1.21.4 registry check; the production [`readSchematic()`](../../../src/utils/schematic/reader.js:173) path compared 513/513 voxels and full properties. Reader-derived counts matched, spot checks passed 8/8, count diffs 0, spot failures 0, parser mismatches 0, `fullVoxelAndStateComparison=PASS`.

## Determinism and artifact checks

Recompiled from the unchanged JSON to a temporary path with [`compile`](../../tooling/compile_blueprint.py:207); the temporary output hash matched the permanent SHA-256 above. The owned temporary directory was removed after comparison. Both source JSON and output schematic passed nonempty checks.

## Reconstruction limitations

The printed track-footprint dimensions are limited to hairpin 24 × 12, turn 12 × 12, and starting grid 9 × 19. The starting-gate mechanism retains seven pistons, an eight-position length, and two-block powder height, but the pit wording is ambiguous; its two-lane/below-road interpretation is inferred. The gate artifact is unpowered/lowered. Arch dimensions, post forms, banner placements, grandstand/fence sizes, and pixel patterns are inferred where not dimensioned. Only six reusable components are represented; there is no fully dimensioned complete course. Full landscaping is explicitly customizable and excluded (including trees, river, horses, and riders). The grandstand chest is default-empty. The starting grid's 9 × 19 footprint is printed; its six white grid-mark pixels, six edge markers, material choices for posts, base depth, and exact placement/height are visually estimated. No fluids, entities, complex NBT, live tests, or physics tests were performed; binary/parser validation does not certify image-perfect geometry.
