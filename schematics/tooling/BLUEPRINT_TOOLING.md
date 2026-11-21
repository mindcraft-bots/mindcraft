# Blueprint compilation, validation and pack audits

The source of truth for a build is its JSON blueprint in `schematics/blueprints/<packN>/`; its matching compiled schematic belongs in `schematics/schems/<packN>/`. The tools are in this `schematics/tooling/` directory. Repository-relative CLI arguments are resolved from the repository root, regardless of the shell's current working directory. The compiler restricts blueprint inputs to the repository; compilation outputs may use an absolute temporary path for deterministic checks.

## Blueprint metadata

Each blueprint must declare both `minecraft_version` and a positive integer `data_version`. For Minecraft Java 1.21.4 the required pair is `minecraft_version: "1.21.4"` and `data_version: 4189`. A plain binary compile preserves metadata but is not a version/registry check. Always pass `--target-version 1.21.4` when compiling or validating a 1.21.4 asset: the compiler then requires an exact stated-version match and uses the installed `minecraft-data` registry to verify the matching DataVersion plus every palette block and its complete legal property set. Other versions remain available through the explicit target option when their registry is installed; without the option the compiler retains its metadata-driven generic behavior.

## Compile and binary-validate

Run these commands from the repository root. From another working directory, invoke the tool itself by its absolute path; its input arguments still resolve relative to the repository root:

```sh
python3 schematics/tooling/compile_blueprint.py compile \
  schematics/blueprints/<packN>/<name>.json \
  schematics/schems/<packN>/<name>.schem \
  --target-version 1.21.4
python3 schematics/tooling/compile_blueprint.py validate \
  schematics/blueprints/<packN>/<name>.json \
  schematics/schems/<packN>/<name>.schem \
  --target-version 1.21.4
python3 schematics/tooling/compile_blueprint.py test-varints
```

Compilation creates deterministic gzip-compressed Sponge v2 NBT using the blueprint's DataVersion, typed tags, zero offset, complete state palette, empty entity lists, and canonical signed-byte VarInt data in X-fastest / Z-next / Y-next order. With the target option, version metadata and all palette states are checked against `minecraft-data` before writing; the output is reloaded and independently verified with `nbtlib`. Validation checks NBT tag types, dimensions, DataVersion, palette, full voxel order and states, expected counts, spot checks and volume. The VarInt suite tests 1–5 byte values and rejects overlong encodings.

Determinism means repeated compilation with the same toolchain produces identical bytes; it does not mean every historical asset used this serialization. The original wardrobe asset is preserved and deliberately fails byte regeneration for the [documented palette, tag-order, and gzip-header reasons](validation/pack1/integration_review.md). Do not overwrite it to make the audit green. Compression-library changes can also affect byte hashes across environments.

## Production reader and registry validation

```sh
node schematics/tooling/validate_blueprint.mjs \
  schematics/blueprints/<packN>/<name>.json \
  schematics/schems/<packN>/<name>.schem <MC_VERSION>
```

The final version argument is optional when `minecraft_version` is present in the JSON. Both source paths are resolved from the repository root and must resolve within it (including after symlink resolution). The validator imports `readSchematic` from the production `src/utils/schematic/reader.js`, parses through `prismarine-schematic`, checks all legend states against the installed `minecraft-data` registry, and compares every voxel—including air—plus properties, dimensions, counts and spot checks. It does not connect to a server. A nonzero exit or reader mismatch is a real recorded failure; do not change blueprint geometry or hide a parser discrepancy to force a pass.

Pack discovery is not restricted to pack1, but pack names must be a positive decimal number after “pack”. Version selection is metadata-driven, not a promise of arbitrary Minecraft-version support: the exact Java version and DataVersion must be available in the installed registry, and its states must be supported by the reader. The [tooling regression tests](../../test/schematic/tooling_paths.test.js) exercise Minecraft 1.20.4 / DataVersion 3700 as well as pack1's Minecraft 1.21.4 / DataVersion 4189, including mismatched metadata and invalid palette states. Binary compilation without `--target-version` alone is not a registry compatibility check.

## Checked pack1 validation and regeneration

From the repository root, verify all existing pack1 outputs without changing the canonical `.schem` files:

```sh
python3 schematics/tooling/audit_batch.py --pack pack1 \
  --minecraft-version 1.21.4 --data-version 4189
```

This checks each source against the compiler's explicit registry target, validates each binary through the production reader and 1.21.4 registry, compares every voxel and property with the JSON source, regenerates temporary candidates for byte comparisons, runs the schematic tests, and reports all discovered artifacts. It retains the known wardrobe serialization-only byte difference while checking voxel equivalence; binary equality is not a geometry requirement. Run `npm run test:schematic` separately when only the test suite is needed.

Only when deliberately regenerating the canonical pack binaries, use this checked loop and then repeat the audit above:

```sh
for blueprint in schematics/blueprints/pack1/*.json; do
  name=$(basename "$blueprint" .json)
  python3 schematics/tooling/compile_blueprint.py compile \
    "$blueprint" "schematics/schems/pack1/$name.schem" \
    --target-version 1.21.4 || exit 1
done
```

This targets exactly the 30 JSON blueprints in pack1; the checked-in manifest is not rewritten. The JSON blueprint remains the source of truth for geometry and state. Do not regenerate merely to normalize bytes, especially for the documented wardrobe binary.

The screenshot `tmp/ScreenShots/2026-11-22_00.37.03.png` shows the client connected to Minecraft 26.1 rejecting `minecraft:chain`. That is a server/client version discrepancy, not evidence that these binaries are corrupt: the pack blueprints and all 30 checked-in files target Java 1.21.4 / DataVersion 4189, where the canonical palette uses `minecraft:chain`; 26.1 uses `minecraft:iron_chain`. Client configuration does not downgrade a server. Do not substitute 26.1 names into canonical 1.21.4 assets, and changing only `DataVersion` does not convert a block palette. These checks prove format, registry compatibility, and source geometry only; no live 1.21.4 server placement test was available or performed.

To verify deterministic output without overwriting the canonical schematic, compile to a new temporary file and compare it, for example with `cmp -s` or `sha256sum`. Keep the blueprint JSON as the source of truth.

## Audit a pack

```sh
python3 schematics/tooling/audit_batch.py --pack pack1
python3 schematics/tooling/audit_batch.py --pack pack1 \
  --minecraft-version <MC_VERSION> --data-version <DATA_VERSION>
```

The runner discovers all JSON blueprints in `schematics/blueprints/<packN>/`, checks same-stem schematics in `schematics/schems/<packN>/`, follows explicit IDs in that pack's `index.json`, recompiles only to temporary outputs, and runs the VarInt and schematic test suites. It writes current machine-readable results and logs to `schematics/tooling/validation/<packN>/` and updates only the marked generated-audit section of `schematics/schems/<packN>/batch_report.md`; text outside that generated section is preserved. It does not assume a set of folder numbers: an unknown/missing pack fails rather than receiving fabricated success, and actual missing artifacts or validation failures are retained in the report and return status.
