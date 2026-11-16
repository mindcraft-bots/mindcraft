> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/15_potion_factory.json schematics/schems/pack1/15_potion_factory.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/15_potion_factory.json schematics/schems/pack1/15_potion_factory.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/15_potion_factory.json schematics/schems/pack1/15_potion_factory.schem 1.21.4
> ```

# Folder 15 — Potion Factory binary validation

## Current production-reader result — 2026-11-15 repair

**PASS:** all 3,705 voxels, exact block states/counts and all 38 spot checks now match. The original 8 mismatched voxels were caused by the shared dependency encoding one-based integer values as literal offsets instead of registry value indices. The [narrow dependency patch](../../../patches/prismarine-schematic+1.3.0.patch) repairs the reader without altering this blueprint or schematic; both hashes match the [preserved baseline](../../tooling/validation/reader_baseline.json). See the [current batch diagnosis and placement limitations](../../schems/pack1/batch_report.md) and [fresh production-reader log](../../tooling/validation/build_logs/pack1/15_potion_factory.reader.log). This does not certify live placement or remove reconstruction/physics limitations. The initial narrative below is retained as historical evidence, including its now-resolved reader-failure statements.

## Original reconstruction validation — before reader repair

## Scope and source

This record covers only folder 15. The unchanged explicit blueprint is [`15_potion_factory.json`](15_potion_factory.json), and the compiled artifact is [`15_potion_factory.schem`](../../schems/pack1/15_potion_factory.schem). The reusable procedure is documented in [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md); compilation used [`compile_blueprint.py`](../../tooling/compile_blueprint.py), and registry/production-reader verification used [`validate_blueprint.mjs`](../../tooling/validate_blueprint.mjs). No source, compiler, validator, dependency, or other-folder files were changed. `schematics/batch_report.md` was intentionally not updated.

## Geometry and artifact summary

| Check | Result |
| --- | --- |
| Dimensions (X × Y × Z) | 19 × 13 × 15 |
| Volume | 3,705 voxels |
| Non-air / air | 944 / 2,761 |
| Blueprint legend states / spot checks | 44 / 38 |
| Sponge schematic version / DataVersion | 2 / 4189 |
| Binary size | 1,255 bytes (nonempty) |
| Blueprint JSON size | 25,452 bytes (nonempty) |
| Schematic SHA-256 | `6e4a12b15d94ed02100aa82d2c60b565f32e767211917d872e7b672a2cc05acb` |
| Blueprint SHA-256 | `1881bfe51e27535123b22d394c720f48f24d412a9f59dd4d8f4a6360a73bcea0` |

The frame/posts/chimney and inferred floor, roof, and interior geometry remain exactly as encoded in the supplied blueprint. No geometry or intended state/property values were edited.

## Commands and outcomes

All commands below were run from the project root `github.com/mindcraft-bots/mindcraft`.

1. **Compile — PASS.** The compiler emitted gzip-compressed Sponge v2 NBT and immediately reloaded/validated it with `nbtlib`.

   ```sh
   python3 schematics/compile_blueprint.py compile \
     schematics/blueprints/15_potion_factory.json schematics/15_potion_factory.schem
   ```

2. **Independent binary validation — PASS.** Verified complete typed NBT (root `Schematic`; Int Version/DataVersion/PaletteMax; Short dimensions; IntArray offset; Compound palette; ByteArray block data; `List[Compound]` block/entity lists), dimensions `[19,13,15]`, zero offset, empty block entities/entities, exact 44-state canonical palette, all 3,705 palette indexes and voxels in x-fastest/z-next/y-next order (including air), counts, and all 38 binary spot checks.

   ```sh
   python3 schematics/compile_blueprint.py validate \
     schematics/blueprints/15_potion_factory.json schematics/15_potion_factory.schem
   ```

3. **Canonical VarInt tests — PASS.** One- through five-byte boundaries, including signed 32-bit maximum, round-tripped; known encodings passed and overlong encodings were rejected. Complete serialized BlockData was also checked for canonical encodings by binary validation.

   ```sh
   python3 schematics/compile_blueprint.py test-varints
   ```

4. **Registry and production-reader — PARTIAL / STATE COMPARISON FAIL.** The production `readSchematic` path via `prismarine-schematic` parsed all 3,705 voxels; all 44 blueprint legend states validated against the installed Minecraft 1.21.4 `minecraft-data` registry. Dimensions and air count agree. Exact full-state voxel comparison fails at 8 positions as listed below; the validator's nonzero exit status (2) was retained and not masked.

   ```sh
   node schematics/validate_blueprint.mjs \
     schematics/blueprints/15_potion_factory.json schematics/15_potion_factory.schem
   ```

5. **Deterministic rebuild — PASS.** Recompiled the same blueprint to a temporary path under `/tmp`; `cmp` confirmed byte-for-byte equality with the committed-target artifact. Both files had SHA-256 `6e4a12b15d94ed02100aa82d2c60b565f32e767211917d872e7b672a2cc05acb` and size 1,255 bytes. The temporary duplicate was removed after comparison.

## Exact production-reader mismatch report

The reader's count comparison differs only for these two states:

| Canonical state | Blueprint expected | Reader actual | Difference |
| --- | ---: | ---: | --- |
| `minecraft:flowering_azalea_leaves[distance=7,persistent=true,waterlogged=false]` | 8 | 0 | −8 |
| `minecraft:wet_sponge` | 0 | 8 | +8 |

All eight voxel mismatches are `flowering_azalea_leaves[distance=7,persistent=true,waterlogged=false]` in the blueprint versus `wet_sponge` in the reader output:

| x | y | z | Expected | Actual |
| ---: | ---: | ---: | --- | --- |
| 4 | 3 | 5 | `minecraft:flowering_azalea_leaves[distance=7,persistent=true,waterlogged=false]` | `minecraft:wet_sponge` |
| 12 | 3 | 9 | `minecraft:flowering_azalea_leaves[distance=7,persistent=true,waterlogged=false]` | `minecraft:wet_sponge` |
| 14 | 3 | 9 | `minecraft:flowering_azalea_leaves[distance=7,persistent=true,waterlogged=false]` | `minecraft:wet_sponge` |
| 4 | 4 | 5 | `minecraft:flowering_azalea_leaves[distance=7,persistent=true,waterlogged=false]` | `minecraft:wet_sponge` |
| 4 | 4 | 6 | `minecraft:flowering_azalea_leaves[distance=7,persistent=true,waterlogged=false]` | `minecraft:wet_sponge` |
| 12 | 4 | 9 | `minecraft:flowering_azalea_leaves[distance=7,persistent=true,waterlogged=false]` | `minecraft:wet_sponge` |
| 13 | 4 | 9 | `minecraft:flowering_azalea_leaves[distance=7,persistent=true,waterlogged=false]` | `minecraft:wet_sponge` |
| 14 | 4 | 9 | `minecraft:flowering_azalea_leaves[distance=7,persistent=true,waterlogged=false]` | `minecraft:wet_sponge` |

Of the 38 reader spot checks, 37 passed and one failed at `(x=13,y=4,z=9)` with the same leaves-to-wet-sponge discrepancy. The parser-reported form at that spot is `wet_sponge[{}]`. No mismatch was hidden or corrected by changing the blueprint. This is recorded as an installed parser conversion discrepancy; no change to parser code or dependencies was in scope.

## Limits

This is offline file/registry/parser validation only. No live Minecraft server, placement, visual match in-game, or build execution was tested or claimed. The artifact contains no entities, block entities, fluids, or complex block NBT. Binary fidelity to the blueprint is verified; production-reader state fidelity is not fully verified until the eight reported parser mismatches are resolved upstream.
