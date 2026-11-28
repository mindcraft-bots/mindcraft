# Pack 1 versioned compilation report

> Historical compilation record: statements below describe the runs at the time, not current selection behavior. The 30 originals have since been moved to the [outside-root archive](../../../../schematic-archive/pack1_originals/README.md); see the [current 60-variant audit](symmetry_audit.md). No compilation or provenance policy was changed by that move.

Historically both targets compiled all 30 indexed blueprints; the bee alone was subsequently recompiled for both targets. The other entries remain historical, not newly strict-validated. No IDs were unsupported or failed for either target. The two generated conversion reports contain per-file SHA-256 hashes, geometry, and conversion details: [1.21.4](../../../schems/pack1/conversion.mc1.21.4.json) and [26.1](../../../schems/pack1/conversion.mc26.1.json). Variants are in [the pack directory](../../../schems/pack1/); the existing schema-version-2 index remains unchanged.

## Current migration verification

The current active pack has 30 logical schema-2 families and 60 versioned binaries, with no unsuffixed binaries. The [current full-volume audit](symmetry_audit.md) compares 143,414 active voxels without mismatch, with the 30 archived originals separately identified. All original and variant bytes were checked against pre-migration Git; the [archive inventory](../../../../schematic-archive/pack1_originals/inventory.json) records the originals. The 1.21.4 isolated batch audit passed 30/30 binary, reader, and byte-regeneration checks, plus VarInt and full schematic tests; its transient results are under `tmp/pack1-migration-audit-20261123/`. These checks do not establish live-server placement. The 26.1 full-volume audit uses the reviewed history conversion; the batch production-reader validator only accepts the source-release target.

## Bee-only regeneration and provenance

The [reviewed plan](bee_symmetry_plan.json) and [validation note](../../../blueprints/pack1/02_bee_hot_air_balloon.validation.md) document the assumption and exact four changes. Both new bee variants were compiled using the actual compiler and strict reviewed history: 1.21.4 DataVersion 4189 SHA-256 `bbb7232b2ab68f3501c7fdd7418aa815066ec76eba1930b9274b8e757c8b16f4`; 26.1 DataVersion 4786 SHA-256 `0f7945a43f00d7e8a417de1e66f9db2da06e2fdd7fa6d474147c8cc3c0583f1a`. Full palette and 1,530-cell streams were checked; the latter renames 24 chains to iron chains with properties retained. Each compiler sidecar is individually bound to the corrected source and asset; its pack-report fields are null because the existing schema-1 conversion reports are mixed historical/current inventories, not newly generated schema-2 strict pack reports. Their bee entries and hashes are updated without promoting other entries. The pinned historical inventory excludes only the two replaced bee variants; the original bee and all other originals and variants retain historical status. Strict validation proves registry/state correspondence, not design fidelity or authorship.

Pre-correction variants and source are recoverable from Git commit `03be8a6`, with old variant hashes in the [validation note](../../../blueprints/pack1/02_bee_hot_air_balloon.validation.md). The unsuffixed originals remain untouched. The prior pack-wide reader and no-clobber statements below describe historical runs, not a fresh full pack compile or full suite.

## Successful IDs

Each selector below succeeded for both 1.21.4 and 26.1. Unsupported IDs: none for either version.

| Group | Successful file IDs |
| --- | --- |
| 1 | 1 |
| 2 | 1, 2, 3 |
| 3 | 1, 2 |
| 4 | 1 |
| 5 | 1 |
| 6 | 1 |
| 7 | 1 |
| 8 | 1 |
| 9 | 1 |
| 10 | 1 |
| 11 | 1, 2, 3, 4, 5, 6 |
| 12 | 1 |
| 13 | 1 |
| 14 | 1 |
| 15 | 1 |
| 16 | 1 |
| 17 | 1, 2 |
| 18 | 1, 2 |
| 19 | 1, 2 |

## Verification

- Independently decoded Sponge v2 NBT and VarInts and compared each complete palette and every voxel against the current blueprint. For 26.1, the sole explicit state transformation was chain to iron chain, preserving axis and waterlogged properties. All 30 files per version passed, with 71,707 voxels per version. Dimensions, offsets, entity lists, Sponge version, DataVersion (4189 or 4786), and individual report hashes also matched.
- The six 26.1 chain transformations affected IDs 2:1 (24 voxels), 2:2 (24), 2:3 (24), 8:1 (19), 9:1 (1), and 18:2 (4). No other blueprint required a fallback.
- All 30 canonical unsuffixed files retained their individual HEAD SHA-256 hashes. The wardrobe original differs at four repaired door voxels (ID 1:1); the bee original differs at the four authorized symmetry corrections (ID 2:1).
- The production reader matched all 143,414 voxel names and properties. Both numeric and filename selectors chose the appropriate versioned variants; selectors without version options still chose canonical assets, and all 30 explicit 26.1 variants were rejected for 1.21.4.
- Repeating either pack command refused to overwrite its existing outputs; all 60 variant and two conversion-report hashes remained unchanged. No staging directories remained.
- Historically, after generating variants, eight of nine compiler/history and version-selection tests passed because the real-listing assertion expected the unsuffixed bee file. The assertion has since been corrected to check the selected 1.21.4 and 26.1 variants, and a real-pack selected-variant reader check was added. The combined suites now pass 10/10; the VarInt boundary check also passed. These results do not represent a fresh full schematic suite or live-server test.

Aggregate SHA-256 values are computed over lexically sorted filenames, each UTF-8 filename followed by a NUL byte and its raw 32-byte individual SHA-256 digest:

| Files | Aggregate SHA-256 |
| --- | --- |
| 30 canonical files | `2702aec7e48354fe9a8a5dcdfde4353aa82eddfd4d9a27c83546314ed35a36b3` |
| 30 1.21.4 variants | `09fc60bc49a3e9e438329c4da097b089130e00bd1af940bd7e2dde0e67d7aacd` |
| 30 26.1 variants | `a56816a5b575585a9c5b187e18b80de4c47745f38e0eeda1e6172ec3d9c47bc5` |
