> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/18_easter_island_head.json schematics/schems/pack1/18_easter_island_head.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/18_easter_island_head.json schematics/schems/pack1/18_easter_island_head.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/18_easter_island_head.json schematics/schems/pack1/18_easter_island_head.schem 1.21.4
> ```

# Folder 18 validation: Easter Island head

## Inputs and output

- Preserved source blueprint: [18_easter_island_head.json](18_easter_island_head.json). Its geometry and state values were not edited; no alphabetic property-order normalization was needed.
- Compiled output: [18_easter_island_head.schem](../../schems/pack1/18_easter_island_head.schem).
- Tooling instructions: [BLUEPRINT_TOOLING.md](../../tooling/BLUEPRINT_TOOLING.md). No compiler, validator, dependency, or unrelated source was changed.
- Format: gzip-compressed Sponge v2 NBT, DataVersion 4189, dimensions 5 × 9 × 4, zero offset, 180 total voxels, 86 non-air and 94 air, six palette entries, 180 block-data bytes.
- Final file size: 324 bytes. SHA-256: `dbdd6a398f94c463c5b878b88bca3783a8c43c1b06e7e5d755c7ae42ff28067d`.

## Validation results

- Compile: [`python3 schematics/compile_blueprint.py compile schematics/blueprints/18_easter_island_head.json schematics/18_easter_island_head.schem`](../../tooling/compile_blueprint.py) — PASS. This also reloads and verifies the NBT with nbtlib.
- Independent binary validation: [`python3 schematics/compile_blueprint.py validate schematics/blueprints/18_easter_island_head.json schematics/18_easter_island_head.schem`](../../tooling/compile_blueprint.py) — PASS. Confirmed tag types, DataVersion, dimensions, zero offset, complete six-state palette, canonical signed-byte VarInt stream and ordering, full voxel decode, volume and all expected state counts.
- VarInt boundary test: [`python3 schematics/compile_blueprint.py test-varints`](../../tooling/compile_blueprint.py) — PASS; 1-, 2-, 3-, 4-, and 5-byte boundaries accepted and overlong encoding rejected.
- Application validation: [`node schematics/validate_blueprint.mjs schematics/blueprints/18_easter_island_head.json schematics/18_easter_island_head.schem`](../../tooling/validate_blueprint.mjs) — PASS against the installed Minecraft 1.21.4 full-state registry and production schematic reader. All 180/180 voxels (air included) compared; 0 mismatches. Six legend entries registry-validated; all seven spot checks passed; derived counts matched (94 air, 86 non-air).
- Determinism: ran the compile command above a second time with its output directed inside a fresh `mktemp -d` directory; the two [`sha256sum`](../../schems/pack1/18_easter_island_head.schem) values matched the output hash above, and [`cmp`](../../schems/pack1/18_easter_island_head.schem) reported byte-identical output. The temporary directory was removed.

## Exact voxel/state counts

| Full block state | Voxels |
| --- | ---: |
| minecraft:air | 94 |
| minecraft:cobblestone | 55 |
| minecraft:cobblestone_slab[type=bottom,waterlogged=false] | 4 |
| minecraft:mossy_cobblestone | 22 |
| minecraft:mossy_cobblestone_slab[type=bottom,waterlogged=false] | 2 |
| minecraft:mossy_cobblestone_stairs[facing=north,half=bottom,shape=straight,waterlogged=false] | 3 |
| **Total** | **180** |

Seven configured spot checks were tested in both validators, with zero failures. These include the plinth corner, rear cap, front plane, nose endpoints, stair brow, and air beyond the silhouette.

## Blueprint audit and limits

The authored printed-callout audit records a 5 × 2 × 2 plinth, a 3 × 2 × 6.5 rear head realized with full blocks and bottom slabs, a 3 × 1 × 6 front plane, and a three-block nose stem with a three-wide stair brow. The material audit assigns cobblestone to plinth/body, mossy cobblestone to weathering/nose, slabs to the rear cap, and mossy stairs to the brow. The distinct-build audit treats repeated perspective views as one monument and excludes terrain and incidental vegetation.

The source explicitly records that there is no complete orthographic assembled drawing: rear/base alignment, frontal offsets, and nose attachment heights are inferred. Mossy weathering is deterministic rather than a claimed block-for-block reconstruction from compressed imagery; the slab cap is bottom-half; a possible side notch is unresolved; and vines/landscape are omitted. These are source blueprint uncertainties, not binary or reader-validation failures. No entities, fluids, or block-entity NBT are included. Validation does not establish an in-world/live-server result.

The tooling documentation notes an upstream parser state-ID conversion limitation for some integer-valued properties with nonzero minima (example: pink candle count). No such state occurs in this blueprint, and this run's full reader state comparison passed; the general parser limitation is not hidden or worked around.
