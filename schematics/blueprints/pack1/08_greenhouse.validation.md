> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/08_greenhouse.json schematics/schems/pack1/08_greenhouse.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/08_greenhouse.json schematics/schems/pack1/08_greenhouse.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/08_greenhouse.json schematics/schems/pack1/08_greenhouse.schem 1.21.4
> ```

# Folder 08 greenhouse compilation and validation

## Current production-reader result — 2026-11-15 repair

**PASS:** all 4,560 voxels, exact block states/counts and all 25 spot checks now match. The original 76 mismatched voxels were caused by the shared dependency encoding one-based integer values as literal offsets instead of registry value indices. The [narrow dependency patch](../../../patches/prismarine-schematic+1.3.0.patch) repairs the reader without altering this blueprint or schematic; both hashes match the [preserved baseline](../../tooling/validation/reader_baseline.json). See the [current batch diagnosis and placement limitations](../../schems/pack1/batch_report.md) and [fresh production-reader log](../../tooling/validation/build_logs/pack1/08_greenhouse.reader.log). This does not certify live placement or remove reconstruction/physics limitations. The initial narrative below is retained as historical evidence, including its now-resolved reader-failure statements.

## Original reconstruction validation — before reader repair

## Scope and source of truth

This report covers exactly one furnished greenhouse build, including its optional interior furnishings; the furnishing vignettes were not treated as separate builds. The permanent source blueprint remains [`08_greenhouse.json`](08_greenhouse.json:1), and the compiled target is [`08_greenhouse.schem`](../../schems/pack1/08_greenhouse.schem). No blueprint geometry, block states, source code, dependencies, or unrelated files were changed. State property strings remain canonical and property-sorted. No other image folders were inspected.

## Artifact and binary validation

The reusable procedures in [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md:5) were followed using [`compile_blueprint.py`](../../tooling/compile_blueprint.py:204):

| Command | Exit | Result |
| --- | ---: | --- |
| `python3` [`schematics/compile_blueprint.py`](../../tooling/compile_blueprint.py:204) `compile` [`schematics/blueprints/08_greenhouse.json`](08_greenhouse.json:1) [`schematics/08_greenhouse.schem`](../../schems/pack1/08_greenhouse.schem) | 0 | Compiled, reloaded and independently validated the target. |
| `python3` [`schematics/compile_blueprint.py`](../../tooling/compile_blueprint.py:204) `validate` [`schematics/blueprints/08_greenhouse.json`](08_greenhouse.json:1) [`schematics/08_greenhouse.schem`](../../schems/pack1/08_greenhouse.schem) | 0 | Independent binary/NBT validation passed. |
| `python3` [`schematics/compile_blueprint.py`](../../tooling/compile_blueprint.py:213) `test-varints` | 0 | Canonical 1–5 byte boundary round trips passed; overlong VarInt rejected. |

The result is a nonempty gzip-compressed Sponge v2 schematic with root `Schematic`, `Version=2`, `DataVersion=4189`, typed NBT fields, dimensions `15 × 16 × 19`, zero offset, complete 38-entry state palette with canonical sorted state strings, and empty typed `BlockEntities` and `Entities` lists. Its full 4,560-voxel BlockData stream decodes in x-fastest, z-next, y-next order; every voxel, palette mapping, count, and all 25 blueprint spot checks passed. The binary validator also checked the full NBT/tag structure and canonical VarInt encodings.

| Metric | Verified value |
| --- | ---: |
| Dimensions (x × y × z) | 15 × 16 × 19 |
| Volume | 4,560 |
| Non-air / air | 1,119 / 3,441 |
| Palette entries / spot checks | 38 / 25 |
| Uncompressed BlockData bytes | 4,560 |
| Compressed schematic bytes | 1,263 |
| SHA-256 | `6512a7eade46c93b4c271813c829313696bb6f1bff28844af9704711894e63d1` |

## Registry and production-reader validation

Ran the required registry and production-reader validator, [`validate_blueprint.mjs`](../../tooling/validate_blueprint.mjs:1), which calls [`readSchematic()`](../../../src/utils/schematic/reader.js:173) and uses the installed Minecraft 1.21.4 registry:

`node` [`schematics/validate_blueprint.mjs`](../../tooling/validate_blueprint.mjs:1) [`schematics/blueprints/08_greenhouse.json`](08_greenhouse.json:1) [`schematics/08_greenhouse.schem`](../../schems/pack1/08_greenhouse.schem) — **exit 2**, reporting `fullVoxelAndStateComparison: FAIL`.

All **38/38 legend states passed registry validation**. The production parser did parse and compare the entire volume (**4,560/4,560 voxels**), and all **25** spot checks were evaluated (**24 passed, 1 leaf-state mismatch**). It reported **76 full-state voxel mismatches**, exclusively the 76 persistent oak-leaf cells: this parser decodes the integer `distance` property one greater than the intended value. Representative differences include `(x=4,y=4,z=3)`: expected `oak_leaves[distance=1,persistent=true,waterlogged=false]`, got `distance=2`; `(3,4,2)`: expected `distance=3`, got `distance=4`; and the leaf spot check `(3,5,4)`: expected `distance=1`, got a parser-formatted state with `distance=2`.

The parser-derived state counts confirm the systematic shift:

| Canonical leaf state | Expected | Reader result |
| --- | ---: | ---: |
| `minecraft:oak_leaves[distance=1,persistent=true,waterlogged=false]` | 18 | 0 |
| `minecraft:oak_leaves[distance=2,persistent=true,waterlogged=false]` | 34 | 18 |
| `minecraft:oak_leaves[distance=3,persistent=true,waterlogged=false]` | 24 | 34 |
| `minecraft:oak_leaves[distance=4,persistent=true,waterlogged=false]` | 0 | 24 |

Thus geometry, dimensions, and voxel occupancy were read across the full volume, but full state equality fails for precisely these 76 leaf states; aggregate state counts differ in these four rows. The binary validator independently confirms the intended canonical palette and voxel stream. No leaves were altered to mask the parser limitation, and no parser or dependency was patched. This limitation is also called out in the blueprint's [`state_audit`](08_greenhouse.json:128) and [`occlusion_uncertainties`](08_greenhouse.json:137).

## Determinism and artifact preservation

Recompiled the unchanged blueprint to a temporary output under `/tmp`; the temporary compile exited 0. Exact byte comparison exited 0. Both the target and temporary schematic were 1,263 bytes and had SHA-256 `6512a7eade46c93b4c271813c829313696bb6f1bff28844af9704711894e63d1`. The blueprint and target both passed nonempty-file checks. The temporary comparison copy is outside the repository; the permanent blueprint and target were retained.

## Blueprint material, dimensions, and fidelity limits

The blueprint records the printed perimeter as 11 × 17, ten 9-block columns, and a 6-block entrance arch. It implements the perimeter at `x=2..12,z=1..17,y=0`, columns at `x=2/12` and `z=1,5,9,13,17`, and the south arch at `z=17`. The final 15 × 16 × 19 attachment-inclusive envelope is inferred rather than a printed overall size; it includes roof overhang/attachments and retains an empty `z=0` margin. The six-level roof rise, two-block side overhang, pillar pitch, front opening proportions, half-level roof details, and several façade details are diagram-derived. See the blueprint's [`dimension_audit`](08_greenhouse.json:26).

Material labels specify the stone-brick mix, mud bricks and related stairs/slabs, polished-blackstone accents, glass blocks, froglight colors, birch/dirt floor, and named interior furnishings. Weathering distribution, detailed block arrangement, tree/leaf silhouettes and species, vine positions, lighting arrangement, planter layout, workbench offsets, and some orientations are inferred; the blueprint's [`material_audit`](08_greenhouse.json:64), [`state_audit`](08_greenhouse.json:128), and [`occlusion_uncertainties`](08_greenhouse.json:137) list these limits. Oblique compressed source views do not certify hidden geometry or exact block-level fidelity. The cutaway is interpreted as a visibility aid, with glass walls and roof restored. Furnishing vignettes remain integrated once into this single greenhouse. No terrain, surrounding scenery, fluids, entities, block-entity payloads, or live-world behavior are included or certified. **No live tests were run.**

The blueprint's full expected state counts and spot-check list remain in [`08_greenhouse.json`](08_greenhouse.json:525); the original blueprint was preserved unchanged. No batch report was edited.
