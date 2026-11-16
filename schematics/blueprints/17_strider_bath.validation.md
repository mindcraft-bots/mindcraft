# Folder 17 strider bath validation

## Artifacts and scope

- Permanent source: [`17_strider_bath.json`](17_strider_bath.json) — 9,555 bytes; SHA-256 `347c50d6765551e113783e98261e86cd3214f805fbf2cce0f2a3420234ea31a5`.
- Compiled output: [`17_strider_bath.schem`](../17_strider_bath.schem) — 441 bytes; SHA-256 `88914b5c54376a58e38891e655c3c6f6af4e2d751564861355a32ea984f027da`.
- Source geometry was not inferred or modified in this task. The permanent JSON was retained. Scope was limited to this folder-17 schematic and this report.

## Compile and binary validation

From the repository root, ran `python3` with the [`compile_blueprint.py`](../compile_blueprint.py) `compile` subcommand, [`17_strider_bath.json`](17_strider_bath.json) as input, and [`17_strider_bath.schem`](../17_strider_bath.schem) as output. **Exit 0.** It emitted a gzip-compressed Sponge v2 schematic with `Version=2`, `DataVersion=4189`, dimensions **9 × 8 × 11**, zero offset, and empty `Entities` and `BlockEntities` lists. Binary validation confirmed the complete typed NBT schema: `Version`/`DataVersion`/`PaletteMax` are Int, dimensions are Short, `Offset` is IntArray, `Palette` is Compound of Int tags, `BlockData` is ByteArray, and both entity fields are List[Compound].

Compiler's automatic post-compile reload/validation passed. Separately ran `python3` with [`compile_blueprint.py`](../compile_blueprint.py) `validate` on the same source and output: **exit 0**. The independent NBT check confirmed the complete canonical palette and full x-fastest / z-next / y-next VarInt stream, with all **792** voxel states in order; **232 non-air**, **560 air**, **10 palette states**, and all **17** spot checks passed. Ran `python3` with [`compile_blueprint.py`](../compile_blueprint.py) `test-varints`: **exit 0**, exercising one- through five-byte values and rejecting overlong encoding.

## Vanilla registry and production-reader validation

Ran [`validate_blueprint.mjs`](../validate_blueprint.mjs) with this JSON and schematic: **exit 0**. The installed `minecraft-data` Minecraft 1.21.4 registry accepted all **10** legend states, including complete canonical property sets. The project's production `readSchematic` reader compared all **792 / 792** voxels, including air, and full block states. Dimensions matched; parser-derived counts matched expected counts; all **17** spot checks passed; count differences **0**; full-state mismatches **0**; full voxel/state comparison **PASS**.

No integer-property parser mismatch occurred for this blueprint. The documented parser limitation for integer-valued properties with nonzero minimum remains an upstream parser limitation in general; no workaround, dependency/source change, or geometry alteration was applied.

## Determinism and artifact checks

Recompiled the unchanged JSON with the same compiler to a temporary path under `/tmp` and compared bytes with the permanent schematic. **Byte-identical.** Temporary and permanent outputs both had SHA-256 `88914b5c54376a58e38891e655c3c6f6af4e2d751564861355a32ea984f027da`. Both permanent source JSON and schematic passed nonempty-file checks.

## Interpretation limits

This verifies blueprint structure, registry-valid states, NBT serialization, and reader agreement only. It makes no live-server, motion, function, or fidelity claim. The dimensions/geometry are those of the already-authored inferred blueprint; validation did not alter or independently establish them. Lava and all entities were deliberately omitted, and no fluids or complex block NBT are represented.
