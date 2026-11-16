# Folder 09 river steamboat compilation and validation

## Scope and source of truth

This validation covers the single distinct steamboat described for folder 09. The permanent source remains [`09_river_steamboat.json`](09_river_steamboat.json:1), and the compiled target is [`09_river_steamboat.schem`](../09_river_steamboat.schem). The blueprint's origin is its northwest bottom corner at `(0,0,0)`; x points east, y up and z south, with the bow at z=0. It defines explicit cells in [`layers[y][z][x]`](09_river_steamboat.json:25) order and retains its dimension, material, state, count and uncertainty audits. Pages 40–43 represent one vessel; chair/table and wheel details are integrated features, not separate builds.

No geometry or intended block states were changed. The permanent JSON source was preserved. No source/tooling/dependency files or other folders were changed, [`batch_report.md`](../batch_report.md) was not edited, and no live server was used. The compilation procedure followed [`BLUEPRINT_TOOLING.md`](../BLUEPRINT_TOOLING.md:5) and the existing [`compile_blueprint.py`](../compile_blueprint.py:204) tool.

## Compile, binary validation and VarInts

Commands were run from the project root. Each listed command exited **0**:

| Command | Result |
| --- | --- |
| `python3` [`schematics/compile_blueprint.py`](../compile_blueprint.py:204) `compile` [`schematics/blueprints/09_river_steamboat.json`](09_river_steamboat.json:1) [`schematics/09_river_steamboat.schem`](../09_river_steamboat.schem) | Compiled the target, reloaded it with `nbtlib`, and passed the tool's independent binary validation. Output: `dimensions=[13,16,22]`, `volume=4576`, `non_air=1193`, `air=3383`, `palette_entries=34`, `spot_checks=29`, `block_data_bytes=4576`, `bytes=1210`, SHA-256 `dc478807f2a11946f779b74f98280aeca64a27b1db1bf62c575b356dfd0af8e7`. |
| `python3` [`schematics/compile_blueprint.py`](../compile_blueprint.py:204) `validate` [`schematics/blueprints/09_river_steamboat.json`](09_river_steamboat.json:1) [`schematics/09_river_steamboat.schem`](../09_river_steamboat.schem) | **PASS**. The full voxel stream, per-state counts, palette, all 29 spot checks and NBT structure matched the blueprint. Same reported metrics and SHA-256 as compilation. |
| `python3` [`schematics/compile_blueprint.py`](../compile_blueprint.py:213) `test-varints` | **PASS**. Boundary round trips for 1–5 byte values passed, including canonical encoding checks; an overlong encoding was rejected. |

The binary validation confirmed gzip-compressed Sponge v2 NBT with root `Schematic`, `Version` as `Int` value 2 and `DataVersion` as `Int` value 4189; typed dimension/offset/palette/block-data fields; zero `Offset`; `PaletteMax=34`; the complete canonical 34-state palette with contiguous IDs; and empty `List[Compound]` `Entities` and `BlockEntities`. It decoded all 4,576 signed-byte-backed VarInts in x-fastest, z-next, y-next order and matched every voxel including air, the full blueprint count audit and every spot check. This used the existing binary validator's NBT reload, canonical VarInt checks and exact stream comparison; no format workaround was used.

| Verified metric | Value |
| --- | ---: |
| Dimensions (x × y × z) | 13 × 16 × 22 |
| Volume | 4,576 |
| Non-air / air | 1,193 / 3,383 |
| Distinct palette states / registry legend entries | 34 / 34 |
| Spot checks | 29 |
| BlockData bytes | 4,576 |
| Permanent schematic size | 1,210 bytes |
| Permanent schematic SHA-256 | `dc478807f2a11946f779b74f98280aeca64a27b1db1bf62c575b356dfd0af8e7` |

## Minecraft registry and production-reader validation

Ran the required existing [`validate_blueprint.mjs`](../validate_blueprint.mjs:65) using the installed Minecraft 1.21.4 registry and production [`readSchematic()`](../../src/utils/schematic/reader.js:173) reader. Command:

`node` [`schematics/validate_blueprint.mjs`](../validate_blueprint.mjs:1) [`schematics/blueprints/09_river_steamboat.json`](09_river_steamboat.json:1) [`schematics/09_river_steamboat.schem`](../09_river_steamboat.schem) — exit **0**.

**PASS:** all 34/34 legend states passed registry validation, all 4,576/4,576 voxels (including air) were compared with full canonical properties, parser-derived counts matched (`countDiffs=[]`), and all 29 spot checks passed (`spotCheckFailures=[]`). The result reported `parserMismatches=0` and `fullVoxelAndStateComparison=PASS`. No parser discrepancies or mismatch limits were encountered for this blueprint. No parser/dependency patch or state adjustment was needed.

## Determinism and artifact preservation

Recompiled the unchanged blueprint to a fresh temporary directory under `/tmp` using the same compiler command. Temporary compilation exited **0**; byte comparison (`cmp`) exited **0**. The permanent and temporary outputs were both **1,210 bytes** and both had SHA-256 `dc478807f2a11946f779b74f98280aeca64a27b1db1bf62c575b356dfd0af8e7`. The temporary copy was removed after comparison.

The source blueprint was **24,014 bytes** and the compiled schematic **1,210 bytes**; both passed nonempty-file checks. The original JSON was retained. Only the requested schematic and this validation note were created for this folder; the batch report was left untouched.

## Blueprint fidelity and limits

The overall wheel-inclusive envelope is 13 × 16 × 22. Printed 9 × 22 hull, two-block cabin height and 7 × 7 canopy specifications are recorded alongside inferred hull chamfers/walls, deck setbacks, cabin/window layout, chimney height, furniture, and 7 × 7 two-block-thick wheel placement. The blueprint documents the ordinary-versus-red Nether brick ambiguity, occlusion and compressed oblique-image uncertainty, and excludes water, terrain, people, smoke/entities, inventory payloads and functional propulsion. Artifact and registry validity do not certify exact visual fidelity or in-world physics. See the source [`dimension_audit`](09_river_steamboat.json:26), [`material_audit`](09_river_steamboat.json:64), [`state_audit`](09_river_steamboat.json:86) and [`occlusion_uncertainties`](09_river_steamboat.json:97); the explicit 34-state [`expected_counts`](09_river_steamboat.json:529) and 29 [`spot_checks`](09_river_steamboat.json:565) remain preserved in the source JSON.
