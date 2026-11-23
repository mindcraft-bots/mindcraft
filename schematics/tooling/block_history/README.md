# Java release block-history dataset, schema 1

This is a generated factual dataset. The blueprint compiler consumes the pinned profiles; the runtime does not. See [compiler coverage and usage](../BLUEPRINT_TOOLING.md). The output is factual registry/state metadata, not a conversion catalog. It contains no authored substitutions, semantic rename assertions, or loss policies. Differences are observations between the identified source reports, not proof of historical introduction, semantic equivalence, enabled features, placeability, item availability, physics, block entities, or runtime compatibility.

## Coverage snapshot

The pinned Mojang manifest snapshot was acquired 2026-11-23 and lists 51 numeric Java releases from 1.13 to 26.3. All 51 have individually addressable profiles and registry identifiers; none are marked unavailable. Coverage labels are **source/normalization labels**, not certification of gameplay or a feature configuration:

* `exact`: 50 releases. Every release other than 1.13.2 has its own independently generated full official report supplying schemas and combinations.
* `shared`: 1.13.2 has its own DataVersion and server jar; its independently generated full report is byte-identical to 1.13.1's pinned report. It does not inherit the other release's version identity.
* `partial`: supported by the format when a registry has missing schemas; there are currently zero partial profiles. A missing schema is **unknown**, not empty or absent.
* `unavailable`: supported by the format for a release whose evidence is missing. No registry or delta is produced, no prior release is reused, and the following delta is marked `after_gap`. There are currently zero unavailable releases.

All profiles set feature flags to unknown. Registries can include experimental or disabled blocks. No world-specific enablement is asserted. All 51 releases from 1.13 through 26.3 have independently generated full-report combination coverage. Summary property domains/defaults are not proof of legal combinations. See [provenance](PROVENANCE.md) for individual report counts, DataVersions, hashes and limitations. No pre-1.13 legacy, snapshot, Bedrock or modded data is provided. No support for a particular client, server, file format or compiler is implied.

## Loader contract

1. Open `generated/index.json`, require `schema == 1` and `edition == "java"`, select the **exact** numeric release string, and validate its identity. Never search by DataVersion alone or fall back to a nearby release. A two-component release label is distinct from any differently spelled label; semantic numeric sorting is for ordering only.
2. The index entry gives the release config path relative to `generated` and SHA-256 of the config bytes. Reject a missing or mismatched config, unknown coverage, unsupported schema/edition, identity mismatch, or `unavailable` entry. For stronger trust, authenticate the index itself externally; hashes here detect inconsistencies, not malicious replacement of the entire tree.
3. The config records exact release, DataVersion, counts, coverage, source kind and immutable revision, generator version/hash, and canonical source-lock hash. Resolve its registry and delta paths relative to `generated`, verify their compressed-byte SHA-256, then gzip-decompress UTF-8 JSON. Both payloads repeat edition, schema and exact release. Never infer state validity from a merely present identifier.
4. `blocks` maps full namespaced IDs to either `null` (schema **unknown**) or `{properties, defaults, combinations}`. Property keys and values are strings; domains are sorted arrays and defaults belong to them. `{}` is a **known empty** property map, unlike `null`. `combinations` is `unknown`, `cartesian`, or an explicit array of arrays ordered by sorted property keys. `cartesian` is used only when validated against a full report. `unknown` forbids assuming the cross product is legal.
5. The first `delta` is `baseline`; its `baseline` is an inventory, **not** additions at 1.13. A normal `adjacent` delta names the preceding manifest release in `from`, lists ID `added`/`removed`, and maps IDs with known schema changes to `before`/`after` properties and defaults. `schema_indeterminate` lists common IDs where either schema is unknown; no change/no-change is asserted for these IDs. Differences in evidence level for combinations are not classified as changes. An `after_gap` delta has a null `from` and lists only the newly observed baseline; the immediately preceding index entry and its authenticated profile must identify an unavailable release. It never infers changes across a missing profile. Baseline and after-gap inventories must match the registry and contain no additions, removals, changes or indeterminate comparisons. Neither an addition/removal pair nor a property change establishes a rename or a transformation.
6. Treat `same_registry_as_previous` only as equality of normalized observed payloads, including schema uncertainty and combination evidence. Versions remain separate even if true. Do not interpret `exact` as verified feature flags or complete legal-state combinations. Reject unknowns if the caller requires full schema, combinations, flag settings, or a guarantee beyond the evidence.

## Rebuilding and checking

Python 3.11+ standard library is sufficient for normalization once the pinned cache is populated. The published bytes were produced by CPython 3.11.2 and zlib 1.2.13; gzip uses zero mtime and canonical sorted compact JSON. Exact compressed bytes may vary with zlib/Python versions. Normalization needs no package install, running server or existing `minecraft-data` module; reproducing the local report requires the verified Java runtime and server jar described below.

From the repository root, first populate all 48 locally generated 1.14–26.3 reports in the ignored content-addressed cache as described in [provenance](PROVENANCE.md). Then fetch **only the already pinned URLs** (the Mojang manifest URL is mutable and will fail if its bytes no longer match; retain the original cache or an independently archived copy):

```sh
python3 schematics/tooling/block_history/generate.py --fetch
python3 schematics/tooling/block_history/generate.py --check
python3 -m unittest discover -s schematics/tooling/block_history -p 'test_*.py' -v
```

For offline regeneration or checking, retain the exact raw source files in `.cache/`, named by SHA-256, or pass `--cache /path/to/cache`. `--check` regenerates everything in memory and compares every output byte and the file set; it fails on missing or tampered sources, stale identity, hash mismatch, or differing output. `--fetch` fills missing cache entries after verifying their pinned hashes; it does not repair a corrupt cache silently. `--output` targets another dedicated directory. Generation refuses unexpected files in that output directory, preventing orphaned stale registries from surviving a coverage change; remove obsolete files deliberately after review or generate into a fresh directory. A partially interrupted write is detectable by the hashes and `--check`.

The local reports are never fetched or distributed; reproduce them independently or retain them separately. The build verifies their digests and compares their identifiers and all summary-known schemas against the pinned summaries.

Normal generation validates consumed source bytes, but does not read the separately attested server jars. Add `--verify-server-jars` to check those jar bytes against both pinned hashes; add `--fetch` only if their pinned URLs should be downloaded. This does not rerun the servers or regenerate reports. Empty inventories and violations of independently attested counts fail closed. A transition removing at least 10% of the preceding inventory requires a digest-bound review in the source lock; see [provenance](PROVENANCE.md) for the review fields and limitations.

`discover.py` is a separate, networked **refresh** operation, not a reproducible build: it queries the live manifest and resolves tags, downloads sources and rewrites the lock. Review changes, source identities, official verification and licensing before publishing a refreshed lock, and retain its manifest snapshot and pinned files. It fails rather than manufacture data on download failures. The lock records upstream URLs, commits, metadata SHA-1 and SHA-256, tarball SHA-256 and the official 1.13-family jar/report digests. The generator's `source_lock_sha256` is computed from sorted, two-space-indented UTF-8 JSON with final newline, not necessarily the physical lock-file bytes.

Generated metadata is intentionally minimized factual IDs, value domains and defaults; no large upstream source texts or descriptions are distributed. Source availability and accessibility are not license grants; see the licensing caveat in [provenance](PROVENANCE.md).
