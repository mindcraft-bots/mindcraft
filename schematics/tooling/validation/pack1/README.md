# Validation evidence status

`symmetry_audit.json`, `symmetry_audit.pre_generalization.json`, and `symmetry_audit.historical.json` are immutable historical snapshots, including their original comparisons and paths; they are not expected to equal a fresh audit. `batch_validation.json`, `integration_other_pack_audit.json`, `integration_pack1_audit.log`, `npm_test.log`, `varint_test.log`, and `build_logs/` are historical snapshots, not current migration results. The compilation report distinguishes its historical runs. Fresh batch runs write only to a new directory under `tmp/`.

## Pack1 provenance and historical context

The individually recompiled bee variants use standalone sidecars with null pack-report references; the existing schema-1 conversion reports are mixed historical/current inventories, not claims of a strict pack recompilation.

The 58 unchanged active versioned pack1 assets remain `HISTORICAL_UNKNOWN` at their pinned hashes, usable with warnings unless strict-only mode is enabled. The pinned list also records 30 former original paths as historical evidence, not current assets. The two recompiled bee variants are independently `STRICT_VALIDATED`.

The pack migration test checks the 60 current variants against pinned hashes or strict content provenance. Historical original digests are compared as records only; retired bytes and old encoding cannot be independently verified here. Generic synthetic fixtures still exercise optional archive inventory failures. These local hashes are consistency evidence, not independent signatures or proof of a historical commit.

The supplied screenshot shows Minecraft 26.1 rejecting `minecraft:chain`: the original pack targets Java 1.21.4 / DataVersion 4189, whereas 26.1 uses `minecraft:iron_chain`. Client configuration does not downgrade a server. Do not substitute 26.1 names into canonical 1.21.4 assets, and changing only `DataVersion` does not convert a block palette. No live 1.21.4 or 26.1 server placement test was performed; registry validation is not proof of placement compatibility.

The [symmetry audit](symmetry_audit.md) explains reproducible current full-volume comparisons and separately identifies frozen historical comparisons.
