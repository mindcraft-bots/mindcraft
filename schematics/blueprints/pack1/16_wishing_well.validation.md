> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/16_wishing_well.json schematics/schems/pack1/16_wishing_well.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/16_wishing_well.json schematics/schems/pack1/16_wishing_well.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/16_wishing_well.json schematics/schems/pack1/16_wishing_well.schem 1.21.4
> ```

# Folder 16 — Wishing Well validation

## Current production-reader result — 2026-11-15 repair

**PASS:** all 600 voxels, exact block states/counts and all 30 spot checks now match. The original 28 mismatched voxels were caused by the shared dependency encoding one-based integer values as literal offsets instead of registry value indices. The [narrow dependency patch](../../../patches/prismarine-schematic+1.3.0.patch) repairs the reader without altering this blueprint or schematic; both hashes match the [preserved baseline](../../tooling/validation/reader_baseline.json). See the [current batch diagnosis and placement limitations](../../schems/pack1/batch_report.md) and [fresh production-reader log](../../tooling/validation/build_logs/pack1/16_wishing_well.reader.log). This does not certify live placement or remove reconstruction/physics limitations. The initial narrative below is retained as historical evidence, including its now-resolved reader-failure statements.

## Original reconstruction validation — before reader repair

## Artifacts and blueprint scope

- Source blueprint: [16_wishing_well.json](16_wishing_well.json:1), 14,847 bytes, SHA-256 `8e70bc29bcea96084f791c55ffb3b09f2a0c50fa2985f4a3f79823f18a413adf`.
- Compiled artifact: [16_wishing_well.schem](../../schems/pack1/16_wishing_well.schem:1), 728 bytes, SHA-256 `0914ae10fea6e97183036c9cbb125dd5cf31dbb5e2ef997013b8821c0e531ae8`.
- Blueprint dimensions: 5 × 15 × 8 = 600 voxels; 355 non-air and 245 air; 21 canonical legend states; 30 spot checks.
- Only `expected_counts` was corrected before compilation: the supplied field used one-character legend keys, while the existing compiler contract requires canonical block-state strings. Counts were re-keyed from the blueprint's unchanged `layers` and `legend`, including complete properties. No dimensions, layers, legend states, spot checks, or inferred geometry were changed. The initially attempted compile rejected the character-keyed counts; the corrected canonical counts now validate against all 600 blueprint voxels.

## Commands and binary validation

Commands were run from the project root, following [BLUEPRINT_TOOLING.md](../../tooling/BLUEPRINT_TOOLING.md:5):

- [python3 schematics/compile_blueprint.py compile schematics/blueprints/16_wishing_well.json schematics/16_wishing_well.schem](../../tooling/BLUEPRINT_TOOLING.md:10) — **PASS**. Output: dimensions `[5,15,8]`, volume 600, palette 21, BlockData 600 bytes, air 245, non-air 355, 30 spot checks, compressed size 728 bytes.
- [python3 schematics/compile_blueprint.py validate schematics/blueprints/16_wishing_well.json schematics/16_wishing_well.schem](../../tooling/BLUEPRINT_TOOLING.md:17) — **PASS**, separately reloaded and checked the permanent output.
- [python3 schematics/compile_blueprint.py test-varints](../../tooling/BLUEPRINT_TOOLING.md:19) — **PASS**. Canonical 1–5 byte boundary values round-tripped; known encodings passed; overlong encoding rejected.

The independent binary validator reports **PASS** for gzip-compressed Sponge v2 NBT, root `Schematic`, typed tags, `Version=2`, `DataVersion=4189`, dimensions `[5,15,8]`, zero offset, canonical contiguous palette of 21 states, `PaletteMax=21`, correctly serialized signed-byte `BlockData`, canonical VarInts for the complete 600-voxel x-fastest/z-next/y-next stream, exact full voxel comparison, state counts, and all 30 binary spot checks. `BlockEntities` and `Entities` are correctly typed empty `List[Compound]` tags. The gzip stream decompresses to 1,893 bytes.

## Registry and production-reader validation

Ran [node schematics/validate_blueprint.mjs schematics/blueprints/16_wishing_well.json schematics/16_wishing_well.schem](../../tooling/validate_blueprint.mjs:26). Vanilla Minecraft 1.21.4 registry validation **PASS** for all 21 legend states, including complete canonical property keys and legal values. The production reader (`readSchematic` → `prismarine-schematic`) parsed the dimensions and compared all 600 voxels, including air. Reader state comparison **FAIL** (expected parser discrepancy); 572 voxel states match and 28 mismatch. `parserDerivedAir=245`; parser-derived complete state counts do not match. Of 30 reader spot checks, 29 pass and one fails at `(x=0,y=12,z=4)`.

Exact reader count differences:

| Canonical state | Expected | Reader |
| --- | ---: | ---: |
| `minecraft:azalea_leaves[distance=7,persistent=true,waterlogged=false]` | 9 | 0 |
| `minecraft:flowering_azalea_leaves[distance=7,persistent=true,waterlogged=false]` | 19 | 0 |
| `minecraft:flowering_azalea_leaves[distance=1,persistent=true,waterlogged=false]` | 0 | 9 |
| `minecraft:wet_sponge` | 0 | 19 |

Exact mismatch coordinates, in `(x,y,z)` order:

- Expected flowering azalea leaves at `distance=7`, got wet sponge: `(0,8,0)`, `(0,8,3)`, `(1,8,4)`, `(2,8,4)`, `(4,8,4)`, `(0,8,5)`, `(1,8,5)`, `(0,9,1)`, `(0,9,4)`, `(1,9,4)`, `(4,9,4)`, `(0,9,5)`, `(0,10,3)`, `(0,10,4)`, `(2,10,4)`, `(1,11,4)`, `(2,11,4)`, `(0,12,4)`, `(1,12,4)`.
- Expected azalea leaves at `distance=7`, got flowering azalea leaves at `distance=1`: `(0,8,1)`, `(4,8,3)`, `(0,8,4)`, `(0,9,3)`, `(2,9,4)`, `(1,9,5)`, `(1,10,4)`, `(0,10,5)`, `(0,11,4)`.
- Failed spot `(0,12,4)`: expected `minecraft:flowering_azalea_leaves[distance=7,persistent=true,waterlogged=false]`, actual `minecraft:wet_sponge`.

The reader's complete observed counts were: air 245; stone 40; dirt 132; stone bricks 58; mossy stone bricks 8; mossy cobblestone 4; chest 1; hopper 1; comparator 1; redstone wire 1; unlit redstone torch 1; lit redstone torch 1; dispenser 1; grass block 31; flowering azalea leaves at distance 1: 9; wet sponge 19; stone brick wall 4; warped fence 8; soul lantern 1; warped slab 24; warped planks 10. All reader counts sum to 600. The canonical schematic palette and binary full-state validation preserve the intended `distance=7` leaf states; no blueprint state was changed to mask the reader defect.

## Deterministic rebuild

Recompiled with the same compiler and blueprint to `/tmp/16_wishing_well.recompiled.schem`, compared SHA-256 and bytes with `cmp`, then removed the temporary output. **PASS**: both hashes were `0914ae10fea6e97183036c9cbb125dd5cf31dbb5e2ef997013b8821c0e531ae8`; byte-for-byte comparison passed. No temporary output was retained in the repository.

## Reconstruction limits

Per the blueprint's [audits and inference limits](16_wishing_well.json:21), the printed excavation is the only fully dimensioned structural element: 3 × 6, six blocks deep. The 3 × 3 shaft/rim, 5 × 5 roof, border/floor, wiring, post heights and foliage placement are inferred from perspective illustrations. Leaf positions/counts and `distance=7` are inferred; hidden voxels are not uniquely recoverable. The schematic has no fluids, entities, inventories or complex block-entity NBT. No server placement, physics, redstone-function, or exact rendered-image test was performed or is claimed.

## Scope and status

The permanent JSON and schematic remain present. No source, dependencies, unrelated folders, or [batch_report.md](../../schems/pack1/batch_report.md:1) were changed. The registry and binary checks pass; production-reader full-state comparison is explicitly recorded as failed for the parser mismatches above. This validation does not certify gameplay behavior or exact image fidelity.
