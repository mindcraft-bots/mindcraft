# Folder 17 carousel validation

## Artifacts and scope

- Permanent source: [`17_carousel.json`](17_carousel.json) — 29,351 bytes; SHA-256 `c3227059fdb670b236ad91b9245d675fa675bba05d5c56a41bc0980524e501b8`.
- Compiled output: [`17_carousel.schem`](../17_carousel.schem) — 1,250 bytes; SHA-256 `028eed1433bda710e3e0723fa96cc227d5f4f3296267fa617e7cbae9570a7df2`.
- Source geometry was not inferred or modified in this task. The permanent JSON was retained. Scope was limited to this folder-17 schematic and this report.

## Compile and binary validation

From the repository root, ran `python3` with the [`compile_blueprint.py`](../compile_blueprint.py) `compile` subcommand, [`17_carousel.json`](17_carousel.json) as input, and [`17_carousel.schem`](../17_carousel.schem) as output. **Exit 0.** It emitted a gzip-compressed Sponge v2 schematic with `Version=2`, `DataVersion=4189`, dimensions **17 × 17 × 17**, zero offset, and empty `Entities` and `BlockEntities` lists. Binary validation confirmed the complete typed NBT schema: `Version`/`DataVersion`/`PaletteMax` are Int, dimensions are Short, `Offset` is IntArray, `Palette` is Compound of Int tags, `BlockData` is ByteArray, and both entity fields are List[Compound].

Compiler's automatic post-compile reload/validation passed. Separately ran `python3` with [`compile_blueprint.py`](../compile_blueprint.py) `validate` on the same source and output: **exit 0**. The independent NBT check confirmed the complete canonical palette and full x-fastest / z-next / y-next VarInt stream, with all **4,913** voxel states in order; **1,283 non-air**, **3,630 air**, **41 palette states**, and all **28** spot checks passed. Ran `python3` with [`compile_blueprint.py`](../compile_blueprint.py) `test-varints`: **exit 0**, exercising one- through five-byte values and rejecting overlong encoding.

## Vanilla registry and production-reader validation

Ran [`validate_blueprint.mjs`](../validate_blueprint.mjs) with this JSON and schematic: **exit 0**. The installed `minecraft-data` Minecraft 1.21.4 registry accepted all **41** legend states, including complete canonical property sets. The project's production `readSchematic` reader compared all **4,913 / 4,913** voxels, including air, and full block states. Dimensions matched; parser-derived counts matched expected counts; all **28** spot checks passed; count differences **0**; full-state mismatches **0**; full voxel/state comparison **PASS**.

No integer-property parser mismatch occurred for this blueprint. The documented parser limitation for integer-valued properties with nonzero minimum remains an upstream parser limitation in general; no workaround, dependency/source change, or geometry alteration was applied.

## Determinism and artifact checks

Recompiled the unchanged JSON with the same compiler to a temporary path under `/tmp` and compared bytes with the permanent schematic. **Byte-identical.** Temporary and permanent outputs both had SHA-256 `028eed1433bda710e3e0723fa96cc227d5f4f3296267fa617e7cbae9570a7df2`. Both permanent source JSON and schematic passed nonempty-file checks.

## Interpretation limits

This verifies blueprint structure, registry-valid states, NBT serialization, and reader agreement only. It makes no live-server, motion, function, or fidelity claim. The representation uses the already-authored inferred heights/chamfers/track/hidden support, with the printed 17 × 17 base, 5 × 5 core, and 13 × 13 roof honored; this validation did not alter or independently establish those geometry choices. No entities, fluids, or complex block NBT are represented.
