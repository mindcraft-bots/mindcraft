# Blueprint compilation and validation tools

These reusable tools consume the generic blueprint fields `width_x`, `height_y`, `length_z`, `legend`, `layers` (`layers[y][z][x]`), `expected_counts`, and `spot_checks`. They do not select a folder or change blueprint geometry.

## Compile and binary-validate

From the project root:

```sh
python3 schematics/compile_blueprint.py compile \
  schematics/blueprints/<name>.json schematics/<name>.schem
```

Compilation creates gzip-compressed Sponge v2 NBT (DataVersion 4189), with typed tags, zero offset, complete state palette, empty entity lists, deterministic gzip metadata, and signed-byte VarInt data in x-fastest / z-next / y-next order. The compile command reloads and independently checks the output using `nbtlib` before returning success. Run just the binary validation again with:

```sh
python3 schematics/compile_blueprint.py validate \
  schematics/blueprints/<name>.json schematics/<name>.schem
python3 schematics/compile_blueprint.py test-varints
```

The validator rejects malformed/non-canonical VarInts, checks the complete byte stream, every voxel, counts, spot checks, NBT tag types, dimensions, palette, and volume. VarInt boundary coverage includes 1–5 byte values and rejects overlong encodings.

## Real application reader and registry validation

```sh
node schematics/validate_blueprint.mjs \
  schematics/blueprints/<name>.json schematics/<name>.schem
```

This imports the production `readSchematic` function from `src/utils/schematic/reader.js`, parses through `prismarine-schematic`, validates every blueprint legend state against the installed `minecraft-data` Minecraft 1.21.4 registry, and compares all voxels—including air—and their full canonical property sets, dimensions, counts, and spot checks. It does not connect to a server.

The installed `prismarine-schematic` 1.3.0 parser has a known state-ID conversion issue for integer-valued block properties with a nonzero minimum: `pink_candle[candles=1,...]` is returned as `candles=2`. The validator intentionally reports this as a failure instead of hiding it or changing blueprint geometry. The raw NBT compiler/binary validator remains independent and verifies that the schematic palette contains the canonical, registry-valid `candles=1` state. The parser discrepancy requires an upstream parser correction before the real-reader state comparison can pass for these folder02 schematics.

For reproducibility, compile the same JSON to a second output path and compare SHA-256 hashes (for example, `sha256sum schematics/<name>.schem /tmp/<name>.schem`). Preserve the blueprint JSON as the source of truth; never infer replacement geometry in these tools.
