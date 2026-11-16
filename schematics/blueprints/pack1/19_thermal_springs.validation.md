> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/19_thermal_springs.json schematics/schems/pack1/19_thermal_springs.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/19_thermal_springs.json schematics/schems/pack1/19_thermal_springs.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/19_thermal_springs.json schematics/schems/pack1/19_thermal_springs.schem 1.21.4
> ```

# Folder 19 — thermal springs verification

## Current production-reader result — 2026-11-15 repair

**PASS:** all 4,048 voxels, exact block states/counts and all 20 spot checks now match. The original 23 mismatched voxels were caused by the shared dependency encoding one-based integer values as literal offsets instead of registry value indices. The [narrow dependency patch](../../../patches/prismarine-schematic+1.3.0.patch) repairs the reader without altering this blueprint or schematic; both hashes match the [preserved baseline](../../tooling/validation/reader_baseline.json). See the [current batch diagnosis and placement limitations](../../schems/pack1/batch_report.md) and [fresh production-reader log](../../tooling/validation/build_logs/pack1/19_thermal_springs.reader.log). This does not certify live placement or remove reconstruction/physics limitations. The initial narrative below is retained as historical evidence, including its now-resolved reader-failure statements.

## Original reconstruction validation — before reader repair

Source of truth: [19_thermal_springs.json](19_thermal_springs.json). Compiled artifact: [19_thermal_springs.schem](../../schems/pack1/19_thermal_springs.schem). Procedure follows [BLUEPRINT_TOOLING.md](../../tooling/BLUEPRINT_TOOLING.md); no source geometry, state value, tool, dependency, or other folder artifact was changed.

## Blueprint and artifact facts

| Check | Result |
|---|---|
| Geometry | 23 × 8 × 22; volume 4,048; layers are `layers[y][z][x]` |
| Blueprint counts | 1,170 non-air; 2,878 air |
| Legend / palette | 23 explicit states; complete palette has 23 entries |
| Spot checks | 20 defined; all 20 pass binary validation |
| Artifact size | 1,025 bytes |
| SHA-256 | `985ddd73114c424fdd548de97eee21008cdd9c5d9c7e78a901906bef14acb05e` |
| BlockData | 4,048 bytes / 4,048 decoded canonical VarInts |

NBT was decompressed and independently parsed with `nbtlib`: root `Schematic`; Sponge `Version=2`; `DataVersion=4189`; `Width=23`, `Height=8`, `Length=22`; `Offset=[0,0,0]`; `PaletteMax=23`; 23 palette entries; empty `BlockEntities` and `Entities`. Checked tag types: `Version`/`DataVersion`/`PaletteMax` are `Int`, dimensions `Short`, `Offset` `IntArray`, `Palette` `Compound`, `BlockData` `ByteArray`, and both entity tags `List[Compound]`.

## Commands and binary verification

Commands were run from the project root. Each listed command exited `0`.

- [`python3 schematics/compile_blueprint.py compile schematics/blueprints/19_thermal_springs.json schematics/19_thermal_springs.schem`](../../tooling/compile_blueprint.py:1) — wrote the artifact and the compile command's own independent NBT/full-voxel validation passed; 1,025 bytes, SHA-256 above.
- [`python3 schematics/compile_blueprint.py validate schematics/blueprints/19_thermal_springs.json schematics/19_thermal_springs.schem`](../../tooling/compile_blueprint.py:1) — independent reload validation passed: 23 × 8 × 22, 1,170 non-air, 2,878 air, 23 palette entries, 20/20 spots.
- [`python3 schematics/compile_blueprint.py compile schematics/blueprints/19_thermal_springs.json /tmp/tmp.Zje2HWIChr/19_thermal_springs.schem`](../../tooling/compile_blueprint.py:1) — deterministic second compile to a temporary directory; exit `0`. `cmp -s` against the permanent artifact exited `0` (byte-identical); both SHA-256 values were `985ddd73114c424fdd548de97eee21008cdd9c5d9c7e78a901906bef14acb05e`. The temporary directory was removed automatically by the command's exit trap.
- [`python3 schematics/compile_blueprint.py test-varints`](../../tooling/compile_blueprint.py:1) — exit `0`; canonical VarInt round trips across 1–5 byte boundaries passed and overlong encoding was rejected.

The binary validator confirmed every voxel, including air, canonical state palette, counts and all spot checks in x-fastest, z-next, y-next order. Geometry and explicit values are preserved.

## Registry and production-reader validation

[`node schematics/validate_blueprint.mjs schematics/blueprints/19_thermal_springs.json schematics/19_thermal_springs.schem`](../../tooling/validate_blueprint.mjs:1) exited **2**: expected fidelity failure from the installed production `readSchematic` → `prismarine-schematic` reader, not a compile/registry/NBT failure. All 23 legend entries passed complete-property-set and value validation against `minecraft-data` Minecraft 1.21.4. The production reader returned the correct dimensions and compared all 4,048/4,048 voxels including air. Air remained 2,878 and expected non-air remained 1,170. However, the complete canonical block-state comparison had **23 mismatched voxels**, parser-derived counts did not match, and **18/20** reader spot checks passed (**2 failed**):

| Intended state and locations `(x,y,z)` | Reader result | Count |
|---|---|---:|
| `minecraft:flowering_azalea_leaves[distance=7,persistent=true,waterlogged=false]` at `(0,1,7)`, `(1,1,7)`, `(0,1,8)`, `(20,1,8)`, `(21,1,8)`, `(22,1,8)`, `(20,1,9)`, `(21,1,9)`, `(22,1,9)` | `minecraft:wet_sponge` | 9 |
| `minecraft:snow[layers=1]` at `(0,2,7)`, `(1,2,7)`, `(0,2,8)`, `(20,2,8)`, `(21,2,8)`, `(22,2,8)`, `(20,2,9)`, `(21,2,9)`, `(22,2,9)`, `(2,3,3)`, `(20,3,3)`, `(21,3,11)`, `(18,4,5)`, `(6,5,3)` | `minecraft:snow[layers=2]` | 14 |

Exact count differences: intended flowering leaves 9 → reader 0, `wet_sponge` 0 → 9; intended snow `layers=1` 14 → 0, reader snow `layers=2` 0 → 14. The two failed reader spot checks are `(20,1,8)` (leaves returned as wet sponge) and `(20,2,8)` (snow layer 1 returned as layer 2). These are reported without changing the blueprint's intended `distance=7`, `persistent=true`, or `layers=1` values and without altering dependencies. Binary/NBT validation retains the intended canonical states.

## Fidelity limits

The printed reference dimensions specify the 23 × 22 landscape footprint, not the full height or internal pool plans. The 8-block height, five basin outlines/locations and rises, retaining fill, outlet alignments, snow placement, and furniture placement are source-informed inferences; hidden geometry cannot be verified from the printed material. Water is intentionally omitted, so this is a dry block-only reconstruction, not a functioning hot spring; no fluid, particles, or flow are represented. The separate chalet is not inserted into this landscape. Cobbled-deepslate/cobblestone variants and unseen surfaces remain interpretive choices. Local serialization checks do not establish visual identity or prove live placement/physics; no live server was used or claimed.
