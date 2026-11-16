# Blueprint compilation, validation and pack audits

The source of truth for a build is its JSON blueprint in `schematics/blueprints/<packN>/`; its matching compiled schematic belongs in `schematics/schems/<packN>/`. The tools are in this `schematics/tooling/` directory. Repository-relative CLI arguments are resolved from the repository root, regardless of the shell's current working directory. The compiler restricts blueprint inputs to the repository; compilation outputs may use an absolute temporary path for deterministic checks.

## Blueprint metadata

Each blueprint must declare a positive integer `data_version` matching its target Minecraft `minecraft_version`. Do not rely on a hard-coded default: the compiler writes the declared DataVersion and verifies it again on reload. The Node validator reads the blueprint version by default, checks the installed `minecraft-data` registry's Minecraft version and DataVersion, and optionally accepts an explicit version argument that must match the blueprint.

## Compile and binary-validate

Run these commands from the repository root. From another working directory, invoke the tool itself by its absolute path; its input arguments still resolve relative to the repository root:

```sh
python3 schematics/tooling/compile_blueprint.py compile \
  schematics/blueprints/<packN>/<name>.json \
  schematics/schems/<packN>/<name>.schem
python3 schematics/tooling/compile_blueprint.py validate \
  schematics/blueprints/<packN>/<name>.json \
  schematics/schems/<packN>/<name>.schem
python3 schematics/tooling/compile_blueprint.py test-varints
```

Compilation creates deterministic gzip-compressed Sponge v2 NBT using the blueprint's DataVersion, typed tags, zero offset, complete state palette, empty entity lists, and canonical signed-byte VarInt data in X-fastest / Z-next / Y-next order. Compile reloads and independently verifies the output with `nbtlib`. Validation checks NBT tag types, dimensions, DataVersion, palette, full voxel order and states, expected counts, spot checks and volume. The VarInt suite tests 1–5 byte values and rejects overlong encodings.

Determinism means repeated compilation with the same toolchain produces identical bytes; it does not mean every historical asset used this serialization. The original wardrobe asset is preserved and deliberately fails byte regeneration for the [documented palette, tag-order, and gzip-header reasons](validation/pack1/integration_review.md). Do not overwrite it to make the audit green. Compression-library changes can also affect byte hashes across environments.

## Production reader and registry validation

```sh
node schematics/tooling/validate_blueprint.mjs \
  schematics/blueprints/<packN>/<name>.json \
  schematics/schems/<packN>/<name>.schem <MC_VERSION>
```

The final version argument is optional when `minecraft_version` is present in the JSON. Both source paths are resolved from the repository root and must resolve within it (including after symlink resolution). The validator imports `readSchematic` from the production `src/utils/schematic/reader.js`, parses through `prismarine-schematic`, checks all legend states against the installed `minecraft-data` registry, and compares every voxel—including air—plus properties, dimensions, counts and spot checks. It does not connect to a server. A nonzero exit or reader mismatch is a real recorded failure; do not change blueprint geometry or hide a parser discrepancy to force a pass.

Pack discovery is not restricted to pack1, but pack names must be a positive decimal number after “pack”. Version selection is metadata-driven, not a promise of arbitrary Minecraft-version support: the exact Java version and DataVersion must be available in the installed registry, and its states must be supported by the reader. The [tooling regression tests](../../test/schematic/tooling_paths.test.js) exercise Minecraft 1.20.4 / DataVersion 3700 as well as pack1's Minecraft 1.21.4 / DataVersion 4189, plus mismatched and unavailable versions. Binary compilation alone is not a registry compatibility check.

To verify deterministic output without overwriting the canonical schematic, compile to a new temporary file and compare it, for example with `cmp -s` or `sha256sum`. Keep the blueprint JSON as the source of truth.

## Audit a pack

```sh
python3 schematics/tooling/audit_batch.py --pack pack1
python3 schematics/tooling/audit_batch.py --pack pack1 \
  --minecraft-version <MC_VERSION> --data-version <DATA_VERSION>
```

The runner discovers all JSON blueprints in `schematics/blueprints/<packN>/`, checks same-stem schematics in `schematics/schems/<packN>/`, follows explicit IDs in that pack's `index.json`, recompiles only to temporary outputs, and runs the VarInt and schematic test suites. It writes current machine-readable results and logs to `schematics/tooling/validation/<packN>/` and updates only the marked generated-audit section of `schematics/schems/<packN>/batch_report.md`; text outside that generated section is preserved. It does not assume a set of folder numbers: an unknown/missing pack fails rather than receiving fabricated success, and actual missing artifacts or validation failures are retained in the report and return status.
