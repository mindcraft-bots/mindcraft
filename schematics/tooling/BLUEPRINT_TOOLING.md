# Blueprint compilation, validation and pack audits

The source of truth for a build is its JSON blueprint in `schematics/blueprints/<packN>/`; its matching compiled schematic belongs in `schematics/schems/<packN>/`. The tools are in this `schematics/tooling/` directory. Repository-relative CLI arguments are resolved from the repository root, regardless of the shell's current working directory. The compiler restricts blueprint inputs to the repository; compilation outputs may use an absolute temporary path for deterministic checks.

## Blueprint metadata

Each blueprint must declare both `minecraft_version` and a positive integer `data_version`. For Minecraft Java 1.21.4 the required pair is `minecraft_version: "1.21.4"` and `data_version: 4189`. A plain binary compile preserves metadata but is not a version/registry check. Always pass `--target-version 1.21.4` when compiling or validating a 1.21.4 asset: the compiler then requires an exact stated-version match and uses the installed `minecraft-data` registry to verify the matching DataVersion plus every palette block and its complete legal property set. Other versions remain available through the explicit target option when their registry is installed; without the option the compiler retains its metadata-driven generic behavior.

For conversion rather than strict matching, use `--convert-to` as described below. Both the declared source release/DataVersion and target release must be available and consistent in the installed registry.

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

## Versioned conversion

```sh
python3 schematics/tooling/compile_blueprint.py compile \
  schematics/blueprints/pack1/02_bee_hot_air_balloon.json \
  schematics/schems/pack1/02_bee_hot_air_balloon.schem --convert-to 26.1
python3 schematics/tooling/compile_blueprint.py validate \
  schematics/blueprints/pack1/02_bee_hot_air_balloon.json \
  schematics/schems/pack1/02_bee_hot_air_balloon.mc26.1.schem --convert-to 26.1
schematics/tooling/compile_pack.sh pack1 26.1
```

The compile output argument is an **unsuffixed base**: conversion creates `<stem>.mc<version>.schem` exclusively, never overwriting an existing variant or the base. The pack command requires existing blueprint and schematic pack directories, stages and validates every blueprint before publication, and refuses an existing variant or `conversion.mc<version>.json` report. It publishes each file atomically without replacement, with the deterministic JSON report last; a process crash can leave a partially published pack, so inspect and remove only the newly generated files before retrying. No canonical asset or index is rewritten.

The version-1 history in `block_history.v1.json` records identifier introductions and directed alternatives with inclusive target DataVersion/release boundaries. Property rules rename explicitly named keys and map explicitly listed values; unmentioned properties are retained, and a missing mapped value is an error. Target registry validation requires complete legal states after transformation, and transformed blocks must have target items. The source and target releases, history boundaries, source states, target states, and applicable graph cycles are checked; absent mappings fail. The authored chain/iron-chain alternatives reflect the installed registry transition at 1.21.9 (4554), including 26.1 (4786); axis and waterlogged are retained. An unchanged block with a source same-name item must retain that item in the target. Blocks without same-name source items are not certified as placeable; conversion is not a live-build test.

The existing schema-version-2 pack index maps each numeric tuple to an unsuffixed logical base and is left unchanged. With an engine version, numeric and base-name selectors choose the highest known sibling release DataVersion not newer than the engine; an explicitly suffixed filename requests that exact variant subject to compatibility. Without version options the resolver retains the canonical base behavior. The engine-aware listing identifies every candidate, its version eligibility and the selected file. Selection is not full palette validation or a placeability guarantee; the production reader and builder still perform their own checks. The report records each source, variant, target DataVersion, converted states, and binary hash; the runtime does not verify that report or use it as a provenance manifest.

The history is deliberately curated, not a universal Minecraft data fixer. The shipped catalog explicitly covers the chain/iron-chain transition; unchanged states must still pass source and target registry checks. The framework supports reviewed directed alternatives and property rules, but it does not infer equivalent blocks, offer arbitrary approximations, or provide a general lossy-substitution opt-in. Add only independently reviewed rules and test boundaries, complete states and cycles. Snapshots, modded registries, unknown versions and uncovered transformations are not promised. The runtime reader retains its separate narrow legacy chain migration; the compiler catalog does not replace that reader path.

## Production reader and registry validation

```sh
node schematics/tooling/validate_blueprint.mjs \
  schematics/blueprints/<packN>/<name>.json \
  schematics/schems/<packN>/<name>.schem <MC_VERSION>
```

The final version argument is optional when `minecraft_version` is present in the JSON. Both source paths are resolved from the repository root and must resolve within it (including after symlink resolution). The validator imports `readSchematic` from the production `src/utils/schematic/reader.js`, parses through `prismarine-schematic`, checks all legend states against the installed `minecraft-data` registry, and compares every voxel—including air—plus properties, dimensions, counts and spot checks. It does not connect to a server. A nonzero exit or reader mismatch is a real recorded failure; do not change blueprint geometry or hide a parser discrepancy to force a pass.

Pack discovery is not restricted to pack1, but pack names must be a positive decimal number after “pack”. Version selection is metadata-driven, not a promise of arbitrary Minecraft-version support: the exact Java version and DataVersion must be available in the installed registry, and its states must be supported by the reader. The [tooling regression tests](../../test/schematic/tooling_paths.test.js) exercise Minecraft 1.20.4 / DataVersion 3700 as well as pack1's Minecraft 1.21.4 / DataVersion 4189, including mismatched metadata and invalid palette states. Binary compilation without `--target-version` alone is not a registry compatibility check.

## Checked pack1 validation and regeneration

The following audit does not overwrite canonical `.schem` files, but **does overwrite generated validation reports and logs** and runs the full schematic suite. Preserve or review those artifacts before deliberately running it:

```sh
python3 schematics/tooling/audit_batch.py --pack pack1 \
  --minecraft-version 1.21.4 --data-version 4189
```

This checks each source against the compiler's explicit registry target, validates canonical binaries through the production reader, compares voxels with the JSON source, regenerates temporary candidates for byte comparisons, and runs schematic tests. The preserved original wardrobe now differs from the repaired blueprint in four door states, in addition to its historical serialization-only byte difference; a source/canonical voxel mismatch is expected and must not be hidden. Binary equality is not a geometry requirement. Run `npm run test:schematic` separately when only the test suite is needed.

Preserve canonical pack binaries rather than regenerating them in place. The provenance audit found the 30 originals unchanged against HEAD, so there is no evidenced overwritten original requiring restoration. The 30 blueprints were instead compiled into 60 separate 1.21.4 and 26.1 variants; see the [versioned compilation report](validation/pack1/versioned_compilation_report.md). The variants reflect the repaired wardrobe source. Both pack commands now refuse to run over their existing outputs or reports; use an isolated copy for experiments and inspect any partial publication after interruption.

The supplied screenshot shows Minecraft 26.1 rejecting `minecraft:chain`: the original pack targets Java 1.21.4 / DataVersion 4189, whereas 26.1 uses `minecraft:iron_chain`. Client configuration does not downgrade a server. Do not substitute 26.1 names into canonical 1.21.4 assets, and changing only `DataVersion` does not convert a block palette. No live 1.21.4 or 26.1 server placement test was performed; registry validation is not proof of placement compatibility.

To verify deterministic output without overwriting the canonical schematic, compile to a new temporary file and compare it, for example with `cmp -s` or `sha256sum`. Keep the blueprint JSON as the source of truth.

## Audit a pack

```sh
python3 schematics/tooling/audit_batch.py --pack pack1
python3 schematics/tooling/audit_batch.py --pack pack1 \
  --minecraft-version <MC_VERSION> --data-version <DATA_VERSION>
```

The runner discovers all JSON blueprints in `schematics/blueprints/<packN>/`, checks same-stem schematics in `schematics/schems/<packN>/`, follows explicit IDs in that pack's `index.json`, recompiles only to temporary outputs, and runs the VarInt and schematic test suites. It writes current machine-readable results and logs to `schematics/tooling/validation/<packN>/` and updates only the marked generated-audit section of `schematics/schems/<packN>/batch_report.md`; text outside that generated section is preserved. It does not assume a set of folder numbers: an unknown/missing pack fails rather than receiving fabricated success, and actual missing artifacts or validation failures are retained in the report and return status.
