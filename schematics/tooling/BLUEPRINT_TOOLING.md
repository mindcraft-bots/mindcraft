# Blueprint compilation, validation and pack audits

The Python compiler and schematic tests require `nbtlib`; the recorded pack1 batch used version 2.0.4. Install it in an isolated Python environment (for example, `python -m pip install nbtlib==2.0.4`) and use that environment's `python3` on the command path. Node tooling also needs the installed project dependencies.

## Artifact validation provenance

New compilations publish a `.schem.provenance.json` sidecar containing the exact artifact and blueprint SHA-256 hashes, names, target and `STRICT_VALIDATED` or `NONVALIDATED` status, plus a `.schem.provenance.sha256` checksum. Pack-compiler outputs additionally bind each sidecar to the exact schema-2 conversion report and entry. Keep these files together. The runtime checks bytes, names, paths and report hashes, and independently checks the Sponge v2 structure, dimensions, canonical indices, entire voxel stream, palette, referenced blueprint, declared authored conversion and pinned full-combination profiles before returning strict content status. It does not attest compiler execution, authorship or the trustworthiness of the blueprint: checksums and sidecars are not signatures and can be rewritten together. A rewritten strict sidecar can now pass that independent content check for modern profiles; this does not prove the artifact was originally compiled strictly. Existing NONVALIDATED and historical artifacts are not automatically relabeled. It does not independently certify blueprint counts or spot checks. Trusted code and profile data remain assumptions. NONVALIDATED metadata does not establish blueprint correspondence or legal combinations.

Other files without metadata are `UNKNOWN`, and damaged provenance is `INVALID`; neither is buildable. Explicitly set `allow_nonvalidated_schematic_builds: true` in bot settings to permit new NONVALIDATED files, or `require_strict_schematic_validation: true` to exclude both NONVALIDATED and historical files. See [the build policy](../README.md#validation-status-and-compatibility-policy).

Pack-specific provenance and historical archive evidence are described in the [pack1 validation index](validation/pack1/README.md); these details do not impose an archive on another pack.

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
python3 schematics/tooling/compile_blueprint.py compile <blueprint.json> /tmp/example.mc1.13.schem --target-version 1.13
# Modern releases also have official full combination evidence; strict compilation needs no opt-in.
python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/03_big_red_barn.json /tmp/barn.mc1.21.4.schem --target-version 1.21.4
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
  schematics/schems/<packN>/<name>.mc<MC_VERSION>.schem <MC_VERSION>
```

The final version argument is optional when `minecraft_version` is present in the JSON. Both source paths are resolved from the repository root and must resolve within it (including after symlink resolution). The reader comparison emits separate `voxelOutcome` and `provenanceOutcome` fields. Its default exit status reports the voxel/count/spot comparison only, even if provenance is INVALID or UNVERIFIED; automation requiring both must pass `--require-strict-provenance`, which exits nonzero unless both outcomes PASS. A strict provenance PASS is the content check described above, not an authorship signature. The conversion fails closed when more than one authored fallback path is reachable; catalog ordering is never a choice policy.

The validator imports `readSchematic` from the production `src/utils/schematic/reader.js`, parses through `prismarine-schematic`, checks all legend states against the installed `minecraft-data` registry, and compares every voxel—including air—plus properties, dimensions, counts and spot checks. It does not connect to a server. A nonzero exit or reader mismatch is a real recorded failure; do not change blueprint geometry or hide a parser discrepancy to force a pass.

Pack discovery is not restricted to pack1, but pack names must be a positive decimal number after “pack”. Version selection is metadata-driven, not a promise of arbitrary Minecraft-version support: the exact Java version and DataVersion must be available in the installed registry, and its states must be supported by the reader. The [tooling regression tests](../../test/schematic/tooling_paths.test.js) exercise Minecraft 1.20.4 / DataVersion 3700 as well as pack1's Minecraft 1.21.4 / DataVersion 4189, including mismatched metadata and invalid palette states. The reader check is separate from compiler profile validation and cannot prove placement support.

## Pack validation and regeneration

### Isolated pack builds and opt-in local container reuse

List packs with `make schematics-list` or `task schematics:list`. Build a
specific pack with either `make schematics-build PACK=pack1 VERSION=1.21.4`
or `PACK=pack1 VERSION=1.21.4 task schematics:build`. Both accept
`ALLOW_UNVERIFIED=1` for the compiler's explicit NONVALIDATED policy; unset or
0 means strict. The underlying `python3 schematics/tooling/build_pack.py --help`
describes the equivalent CLI. Host builds need Python with nbtlib and Node on
PATH as above; the container backend supplies its own compiler dependencies.

The default `host` backend always rebuilds: installed runtimes and transitive
dependencies are not hermetically fingerprinted. Its input key is diagnostic
and its manifests are never reusable. If the container runtime is unavailable,
use the default host backend explicitly; an opted-in container failure is an
error, not a silent host fallback.

For opt-in reuse, first provision the dedicated image separately. The recipe
pins the reviewed Node base manifest and direct Python/numpy/nbtlib versions;
the nbtlib wheel is SHA-256 verified. The final locally inspected image/config
ID identifies all resulting layers, including transitive Debian packages and
native libraries. It is not a promised registry digest. Provisioning needs
network access for the pinned packages and requires the pinned base image to
be present locally; obtain that base explicitly from a trusted source if needed.
The Dockerfile is passed on standard input: no repository, credentials, or
other build context is sent to Docker. Image build cache/layers remain in the
daemon until explicitly removed by their owner.

```sh
IMAGE=$(docker --host unix:///var/run/docker.sock --config /nonexistent build --pull=false -q - < schematics/tooling/compiler-image/Dockerfile)
docker --host unix:///var/run/docker.sock --config /nonexistent image inspect "$IMAGE" --format '{{.Id}}'
make schematics-build PACK=pack1 VERSION=1.21.4 BACKEND=container IMAGE="$IMAGE"
PACK=pack1 VERSION=1.21.4 BACKEND=container IMAGE="$IMAGE" task schematics:build
```

Use the full inspected `sha256:` image ID, not a mutable tag; the build never
pulls or provisions images. Linux, a trusted local root Docker daemon reachable
directly at the default Unix socket, a non-root invoking user, native matching
image architecture, and identifiable CPU/kernel are required. Docker context,
host and TLS overrides, remote or unidentifiable socket peers, and CPUs
advertising a hypervisor are rejected. Some valid local configurations, such
as rootless or forwarded Docker sockets, therefore cannot use this backend.
Docker access itself grants powerful privileges: use only a daemon and image
you trust. Each cold build runs one container, by immutable image ID, with no
network, a sanitized environment, dropped capabilities, non-root UID, read-only
root/input mounts and an isolated writable output mount. A failed run is not cached.

The container key covers exact selected source names and bytes, compiler,
history and generated registry inputs, wrapper/schema, build policy, image ID,
and daemon, CPU, kernel and execution policy scope. A warm hit rechecks the
complete receipt and file/directory inventory, digests, report and provenance,
and rejects links, malformed data, missing or extra files. It checks source and
runtime identities before and after verification. Cache snapshots are made
read-only; edit the original blueprints, not a snapshot. Reverting an edit may
reuse an earlier verified snapshot. These are **pack compilation results only**:
CI, tests, audits and live worlds are never cached.

For an optional real Docker integration and benchmark, run
`python3 -B test/schematic/pack_cache_docker_integration.py --image "$IMAGE"`.
It compiles pack1 in disposable copies, compares independent output bytes,
tests invalidation and checks Docker events for zero warm container creations.
It removes its private copies afterward; it does not replace published files.

Results are retained under the ignored `.schematic-builds/<pack>/` directory,
owned by the invoking user. Each new directory contains a private snapshot of
source and compiler/history inputs, compiler output with provenance and report,
a digest inventory, and a compiler log. Provenance paths are relative to that
snapshot root; it is not a publication into the selectable schematics tree.
The wrapper checks source names and bytes and relevant tool/history bytes both
before and after compilation, checks the snapshot and generated sidecars, and
fails on changes. It serializes builds per pack and atomically publishes a new
directory without replacement; Linux with `flock` and `renameat2` is required.
The compiler continues to enforce its own version and no-overwrite policy.
Use a trusted local user, workspace, daemon and kernel: this is not protection
against hostile same-user receipt forgery, concurrent filesystem renames, edits
reverted between checks, malicious daemon/kernel behavior, or an untrusted image.
Host mode additionally cannot protect against mutable runtime files.
Failed private staging directories are removed; successful builds and lock files
are never automatically pruned. Inspect and remove only your own retained
builds explicitly when no build is running (make the selected read-only build
directory writable first); never run a global Docker prune. Existing published schematics,
audits, and historical evidence are not modified. A crash can leave a staging
directory for manual inspection. Build logs can contain sensitive information.

The batch audit requires an explicit pack, source-release target and a fresh output directory under `tmp/`; it never overwrites historical reports or logs. Pack1 is an example, not a default:

```sh
python3 schematics/tooling/audit_batch.py --pack pack1 --minecraft-version 1.21.4 --data-version 4189 --output-dir tmp/pack1-audit-new
```

It creates missing parent directories beneath the project temporary directory, refuses symlink components and existing output directories, and leaves existing data untouched. Use a trusted workspace without concurrent directory renames; this is not protection against hostile concurrent filesystem changes. It checks each target-versioned binary against its blueprint through the strict compiler and production reader, regenerates temporary candidates for byte equality, and runs the VarInt and schematic suites. Missing inputs or failed checks fail the audit. A target different from blueprint metadata fails rather than silently skipping checks: the production validator does not accept converted-source comparisons. Historical outputs remain snapshots and are not overwritten. Pack1-specific converted full-volume coverage and archive details are in the [pack1 validation index](validation/pack1/README.md).

Client configuration does not downgrade a server, and changing only `DataVersion` does not convert a block palette. Registry validation is not proof of live-server placement compatibility.

To verify deterministic output without overwriting the canonical schematic, compile to a new temporary file and compare it, for example with `cmp -s` or `sha256sum`. Keep the blueprint JSON as the source of truth.

## Audit a pack

Use the explicit target and a new output directory as above. For a future pack2 with Java 1.21.4 sources, an illustrative command is `python3 schematics/tooling/audit_batch.py --pack pack2 --minecraft-version 1.21.4 --data-version 4189 --output-dir tmp/pack2-audit-new`; it requires that pack's actual inputs and a fresh output directory. The index supplies logical group/id aliases without requiring same-stem physical originals. Output and logs are isolated from the checked-in historical artifacts; the command refuses an existing output directory. The runner checks the actual versioned files, fails for absent or invalid artifacts, and does not publish generated schematics. See the [symmetry guide](SYMMETRY.md) and [mechanics guide](PACK_MECHANICS.md) for their independent pack selection, configuration and version limits.
