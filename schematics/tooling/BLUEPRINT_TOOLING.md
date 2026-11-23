# Blueprint compilation, validation and pack audits

## Artifact validation provenance

New compilations publish a `.schem.provenance.json` sidecar containing the exact artifact and blueprint SHA-256 hashes, names, target and `STRICT_VALIDATED` or `NONVALIDATED` status, plus a `.schem.provenance.sha256` checksum. Pack-compiler outputs additionally bind each sidecar to the exact schema-2 conversion report and entry. The individually recompiled bee variants use standalone sidecars with null pack-report references; the existing schema-1 conversion reports are mixed historical/current inventories, not claims of a strict pack recompilation. Keep these files together. The runtime checks bytes, names, paths and report hashes, and independently checks the Sponge v2 structure, dimensions, canonical indices, entire voxel stream, palette, referenced blueprint, declared authored conversion and pinned full-combination profiles before returning strict content status. It does not attest compiler execution, authorship or the trustworthiness of the blueprint: checksums and sidecars are not signatures and can be rewritten together. A rewritten strict sidecar can now pass that independent content check for modern profiles; this does not prove the artifact was originally compiled strictly. Existing NONVALIDATED and historical artifacts are not automatically relabeled. It does not independently certify blueprint counts or spot checks. Trusted code and profile data remain assumptions. NONVALIDATED metadata does not establish blueprint correspondence or legal combinations.

The 88 unchanged pack1 assets remain `HISTORICAL_UNKNOWN` at their original paths and pinned hashes. They remain usable with warnings unless strict-only mode is enabled. The two recompiled bee variants are independently `STRICT_VALIDATED`; the unsuffixed bee original remains historical. Other files without metadata are `UNKNOWN`, and damaged provenance is `INVALID`; neither is buildable. Explicitly set `allow_nonvalidated_schematic_builds: true` in bot settings to permit new NONVALIDATED files, or `require_strict_schematic_validation: true` to exclude both NONVALIDATED and historical files. See [the build policy](../README.md#validation-status-and-compatibility-policy).

The production-reader comparison reports voxel agreement independently of `validationStatus` and `legalCombinationProof`. A voxel PASS and property-domain checks do not themselves prove legal state combinations.

The source of truth for a build is its JSON blueprint in `schematics/blueprints/<packN>/`; its matching compiled schematic belongs in `schematics/schems/<packN>/`. The tools are in this `schematics/tooling/` directory. Repository-relative CLI arguments are resolved from the repository root, regardless of the shell's current working directory. The compiler restricts blueprint inputs to the repository; compilation outputs may use an absolute temporary path for deterministic checks.

## Release coverage and validation

Every compile and binary validation, even without a target option, checks the blueprint's exact Java release and DataVersion against the generated history tree. The tree currently indexes 51 releases from 1.13 through 26.3: 50 exact, one shared, and zero partial-schema profiles. The compiler authenticates the pinned index digest, the release configuration, and both compressed registry and delta digests; it checks their identity and provenance fields. Updating the generated tree requires reviewing it and deliberately updating the index digest in the loader. This protects against changes to the tree relative to that pin, not compromise of the loader or source evidence. See [dataset coverage and provenance](block_history/README.md).

All 51 profiles from 1.13 through 26.3 have independently generated official full-report combination evidence. By default a partial profile, unknown schema, or unproven combination fails closed. `--allow-unverified` explicitly permits partial profiles and summary-derived unknown combinations **only after** complete property-key and value-domain checks. Missing IDs, unknown individual schemas, unsupported releases, DataVersion mismatches, invalid values, and missing mappings still fail. All opt-in outputs and reports are labeled **NONVALIDATED**, including cases whose particular states might be valid. Neither mode verifies feature flags, gameplay, item availability, placement, server compatibility, or block entities.

No pre-1.13 legacy, Bedrock, modded or snapshot registries are supplied. Sponge v2 is an output format, not a guarantee that a particular Minecraft version or tool can consume it. The installed `minecraft-data` may silently return an older registry for an exact version: it is not used by the compiler. Other runtime/reader validators still use it and have separate limitations.

## Compile and binary-validate

From the repository root (outputs below are examples and must not already exist):

```sh
# Strict example: blueprint must declare Java 1.13 / DataVersion 1519.
python3 schematics/tooling/compile_blueprint.py compile <blueprint.json> /tmp/example.schem --target-version 1.13
# Modern releases also have official full combination evidence; strict compilation needs no opt-in.
python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/03_big_red_barn.json /tmp/barn.schem --target-version 1.21.4
python3 schematics/tooling/compile_blueprint.py test-varints
```

Use `validate <blueprint> <schematic> [--target-version VERSION] [--allow-unverified]` to reload a repository-contained schematic and compare its typed NBT, DataVersion, full palette, dimensions and every voxel. The opt-in result is explicitly NONVALIDATED, not a legal-combination proof. The compiler writes deterministic gzip Sponge v2 with empty entities and canonical VarInts; it independently reloads a temporary file before atomically publishing without overwriting any existing output. Geometry stays unchanged. CLI blueprint and validation inputs must resolve within the repository; absolute output paths can be temporary.

## Versioned conversion

```sh
python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/03_big_red_barn.json /tmp/barn.schem --convert-to 26.1 --allow-unverified
# Produces /tmp/barn.mc26.1.nonvalidated.schem; base is untouched.
schematics/tooling/compile_pack.sh pack1 26.1 --allow-unverified
```

Conversion uses only the reviewed directed graph in [the authored catalog](block_history.v1.json); registry additions/removals do not establish semantic equivalence. Both source and target states are checked against their own authenticated profiles, including complete property sets and DataVersions. Explicit bounded edges retain unmapped properties, reject missing value mappings, and detect cycles. The reviewed chain/iron-chain rename remains available in both directions for its bounded releases. An unchanged name with an incompatible state fails unless an independently reviewed same-name rule applies. Optional `stateTransforms` entries specify `block`, fully bounded `source` and `target` release/DataVersion ranges, and the same explicit `properties` rename/value maps used by alternatives. Overlapping rules are rejected, rules apply once, and transformed states are revalidated. No same-name rules are currently authored. In particular boolean wall sides cannot safely imply low versus tall. Additional transformations require independently reviewed evidence and tests, not inferred defaults.

The catalog also reviews placed-block ID renames grass ↔ short grass (1.13–1.20.2 / DV 1519–3578 versus 1.20.3–26.3 / DV 3698–5023) and grass path ↔ dirt path (1.13–1.16.5 / DV 1519–2586 versus 1.17–26.3 / DV 2724–5023). Minecraft Wiki contributors document the [1.20.3 grass rename](https://minecraft.wiki/w/Java_Edition_1.20.3#Blocks) and [1.17 path rename](https://minecraft.wiki/w/Java_Edition_1.17#Blocks), CC BY-NC-SA 3.0. Their identity claims are corroborated by the identifier transitions in [pinned release profiles and sources](block_history/README.md); the official full reports for all 51 profiles show empty property sets for these IDs wherever present. Source and target ranges are bounded on each new edge, and conversion changes carry the catalog's evidence metadata. This is block-state identity only, not unchanged gameplay or placement equivalence.

The 1.13 sign and wall-sign profiles and 1.14 oak-sign and oak-wall-sign reports have matching property domains and observed combinations; no sign rules are included. Sign block entities (including text) are unsupported. The reused stone-slab name and unproven material alternatives are not mapped; an unchanged identifier alone cannot establish historical semantic identity.

The output base receives `.mc<version>.schem`, or `.mc<version>.nonvalidated.schem` with the opt-in. The opt-in direct-compile output must end in `.nonvalidated.schem`. For an indexed family, a correctly labeled NONVALIDATED derivative is selected when appropriate with explicit NONVALIDATED consent; at the same DataVersion it takes precedence over historical or strict variants. Without consent it cannot be selected, and strict-only mode excludes it. The pack command stages every output before publication and never overwrites files; its opt-in report is also labeled `.nonvalidated.json`. A crash during pack publication can leave a partial set, requiring inspection. Neither compiler nor conversion checks item existence: item requirements and placement capability belong in a separate, version-aware placement validator, not block-state serialization.

## Production reader and registry validation

```sh
node schematics/tooling/validate_blueprint.mjs \
  schematics/blueprints/<packN>/<name>.json \
  schematics/schems/<packN>/<name>.schem <MC_VERSION>
```

The final version argument is optional when `minecraft_version` is present in the JSON. Both source paths are resolved from the repository root and must resolve within it (including after symlink resolution). The reader comparison emits separate `voxelOutcome` and `provenanceOutcome` fields. Its default exit status reports the voxel/count/spot comparison only, even if provenance is INVALID or UNVERIFIED; automation requiring both must pass `--require-strict-provenance`, which exits nonzero unless both outcomes PASS. A strict provenance PASS is the content check described above, not an authorship signature. The conversion fails closed when more than one authored fallback path is reachable; catalog ordering is never a choice policy.

The validator imports `readSchematic` from the production `src/utils/schematic/reader.js`, parses through `prismarine-schematic`, checks all legend states against the installed `minecraft-data` registry, and compares every voxel—including air—plus properties, dimensions, counts and spot checks. It does not connect to a server. A nonzero exit or reader mismatch is a real recorded failure; do not change blueprint geometry or hide a parser discrepancy to force a pass.

Pack discovery is not restricted to pack1, but pack names must be a positive decimal number after “pack”. Version selection is metadata-driven, not a promise of arbitrary Minecraft-version support: the exact Java version and DataVersion must be available in the installed registry, and its states must be supported by the reader. The [tooling regression tests](../../test/schematic/tooling_paths.test.js) exercise Minecraft 1.20.4 / DataVersion 3700 as well as pack1's Minecraft 1.21.4 / DataVersion 4189, including mismatched metadata and invalid palette states. The reader check is separate from compiler profile validation and cannot prove placement support.

## Checked pack1 validation and regeneration

The following audit does not overwrite canonical `.schem` files, but **does overwrite generated validation reports and logs** and runs the full schematic suite. Preserve or review those artifacts before deliberately running it:

```sh
python3 schematics/tooling/audit_batch.py --pack pack1 \
  --minecraft-version 1.21.4 --data-version 4189
```

This older audit invokes strict compilation; it checks each source against the compiler's explicit registry target, validates canonical binaries through the production reader, compares voxels with the JSON source, regenerates temporary candidates for byte comparisons, and runs schematic tests. The preserved original wardrobe differs from its repaired blueprint in four door states, in addition to its historical serialization-only byte difference; the preserved bee original differs from its corrected blueprint at four face/brow cells; a source/canonical voxel mismatch is expected and must not be hidden. Binary equality is not a geometry requirement. Run `npm run test:schematic` separately when only the test suite is needed.

Preserve canonical pack binaries rather than regenerating them in place. The provenance audit found the 30 originals unchanged against HEAD, so there is no evidenced overwritten original requiring restoration. The 30 blueprints were instead compiled into 60 separate 1.21.4 and 26.1 variants; see the [versioned compilation report](validation/pack1/versioned_compilation_report.md). The variants reflect the repaired wardrobe source, and the two recompiled bee variants reflect the authorized symmetry correction. Both pack commands now refuse to run over their existing outputs or reports; use an isolated copy for experiments and inspect any partial publication after interruption.

The supplied screenshot shows Minecraft 26.1 rejecting `minecraft:chain`: the original pack targets Java 1.21.4 / DataVersion 4189, whereas 26.1 uses `minecraft:iron_chain`. Client configuration does not downgrade a server. Do not substitute 26.1 names into canonical 1.21.4 assets, and changing only `DataVersion` does not convert a block palette. No live 1.21.4 or 26.1 server placement test was performed; registry validation is not proof of placement compatibility.

To verify deterministic output without overwriting the canonical schematic, compile to a new temporary file and compare it, for example with `cmp -s` or `sha256sum`. Keep the blueprint JSON as the source of truth.

## Audit a pack

```sh
python3 schematics/tooling/audit_batch.py --pack pack1
python3 schematics/tooling/audit_batch.py --pack pack1 \
  --minecraft-version <MC_VERSION> --data-version <DATA_VERSION>
```

The runner discovers all JSON blueprints in `schematics/blueprints/<packN>/`, checks same-stem schematics in `schematics/schems/<packN>/`, follows explicit IDs in that pack's `index.json`, recompiles only to temporary outputs, and runs the VarInt and schematic test suites. It writes current machine-readable results and logs to `schematics/tooling/validation/<packN>/` and updates only the marked generated-audit section of `schematics/schems/<packN>/batch_report.md`; text outside that generated section is preserved. It does not assume a set of folder numbers: an unknown/missing pack fails rather than receiving fabricated success, and actual missing artifacts or validation failures are retained in the report and return status.
