# Validation evidence status

`symmetry_audit.json` is the current deterministic 60-active-variant audit, with archived originals in a separate historical field. `symmetry_audit.pre_generalization.json` preserves the immediately preceding report, and `symmetry_audit.historical.json` preserves the earlier 90-stream audit and paths as originally recorded. `batch_validation.json`, `integration_other_pack_audit.json`, `integration_pack1_audit.log`, `npm_test.log`, `varint_test.log`, and `build_logs/` are historical snapshots, not current migration results. The compilation report explicitly distinguishes its historical runs. Fresh batch runs write only to a new directory under `tmp/`.

## Pack1 provenance and historical context

The individually recompiled bee variants use standalone sidecars with null pack-report references; the existing schema-1 conversion reports are mixed historical/current inventories, not claims of a strict pack recompilation.

The 58 unchanged active versioned pack1 assets remain `HISTORICAL_UNKNOWN` at their original paths and pinned hashes. These 58 remain usable with warnings unless strict-only mode is enabled. The pinned list also records 30 former original paths as historical evidence; the originals now reside outside the selectable root and are not selectable. The two recompiled bee variants are independently `STRICT_VALIDATED`; the unsuffixed bee original is archived and not selectable.

The pack archive migration test is intentionally a pack-wide integration check: it compares archived originals with their inventory and historical hash list, and checks active variants against pinned hashes or strict content provenance. Its separate synthetic fixture exercises inventory failure cases; neither needs Git history. These local hashes are consistency evidence, not independent signatures or proof of the claimed historical commit.

The supplied screenshot shows Minecraft 26.1 rejecting `minecraft:chain`: the original pack targets Java 1.21.4 / DataVersion 4189, whereas 26.1 uses `minecraft:iron_chain`. Client configuration does not downgrade a server. Do not substitute 26.1 names into canonical 1.21.4 assets, and changing only `DataVersion` does not convert a block palette. No live 1.21.4 or 26.1 server placement test was performed; registry validation is not proof of placement compatibility.

The [symmetry audit](symmetry_audit.md) records the converted full-volume comparisons; the [archive inventory](../../../../schematic-archive/pack1_originals/README.md) records the preserved originals.
