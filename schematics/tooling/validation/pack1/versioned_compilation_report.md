# Pack 1 versioned compilation report

Both targets compiled all 30 indexed blueprints. No IDs were unsupported or failed for either target. The two generated conversion reports contain per-file SHA-256 hashes, geometry, and conversion details: [1.21.4](../../../schems/pack1/conversion.mc1.21.4.json) and [26.1](../../../schems/pack1/conversion.mc26.1.json). Variants are in [the pack directory](../../../schems/pack1/); the existing schema-version-2 index remains unchanged.

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
- All 30 canonical unsuffixed files retained their individual HEAD SHA-256 hashes. The only voxel difference between these legacy files and current blueprints is the four repaired wardrobe door voxels in ID 1:1.
- The production reader matched all 143,414 voxel names and properties. Both numeric and filename selectors chose the appropriate versioned variants; selectors without version options still chose canonical assets, and all 30 explicit 26.1 variants were rejected for 1.21.4.
- Repeating either pack command refused to overwrite its existing outputs; all 60 variant and two conversion-report hashes remained unchanged. No staging directories remained.
- Historically, after generating variants, eight of nine compiler/history and version-selection tests passed because the real-listing assertion expected the unsuffixed bee file. The assertion has since been corrected to check the selected 1.21.4 and 26.1 variants, and a real-pack selected-variant reader check was added. The combined suites now pass 10/10; the VarInt boundary check also passed. These results do not represent a fresh full schematic suite or live-server test.

Aggregate SHA-256 values are computed over lexically sorted filenames, each UTF-8 filename followed by a NUL byte and its raw 32-byte individual SHA-256 digest:

| Files | Aggregate SHA-256 |
| --- | --- |
| 30 canonical files | `2702aec7e48354fe9a8a5dcdfde4353aa82eddfd4d9a27c83546314ed35a36b3` |
| 30 1.21.4 variants | `5c3fa5cd260fb6a0c308e33f50354fc3d9a4be848f25f111ffd0b3fbbeec2636` |
| 30 26.1 variants | `45a0343a29de69c8763b72fb304b370f28f17dbc57eda903362cf8a50534b1f6` |
