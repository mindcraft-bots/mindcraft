> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/13_skull_cave.json schematics/schems/pack1/13_skull_cave.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/13_skull_cave.json schematics/schems/pack1/13_skull_cave.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/13_skull_cave.json schematics/schems/pack1/13_skull_cave.schem 1.21.4
> ```

# Folder 13 — Skull Cave artifact validation

## Current production-reader result — 2026-11-15 repair

**PASS:** all 5,120 voxels, exact block states/counts and all 32 spot checks now match. The original 123 mismatched voxels were caused by the shared dependency encoding one-based integer values as literal offsets instead of registry value indices. The [narrow dependency patch](../../../patches/prismarine-schematic+1.3.0.patch) repairs the reader without altering this blueprint or schematic; both hashes match the [preserved baseline](../../tooling/validation/reader_baseline.json). See the [current batch diagnosis and placement limitations](../../schems/pack1/batch_report.md) and [fresh production-reader log](../../tooling/validation/pack1/build_logs/pre_relocation/13_skull_cave.reader.log). This does not certify live placement or remove reconstruction/physics limitations. The initial narrative below is retained as historical evidence, including its now-resolved reader-failure statements.

## Original reconstruction validation — before reader repair

## Scope and result

Compiled the existing source of truth, [13_skull_cave.json](13_skull_cave.json), without editing its layers, legend, counts, spot checks, or intended states. The permanent output is [13_skull_cave.schem](../../schems/pack1/13_skull_cave.schem). The JSON was retained. No other folder, source, dependency, tooling, or batch report was changed; no live-server test was run.

The schematic is structurally and byte-for-byte correct against the blueprint according to the independent Python NBT validator. The production-reader check did **not** pass its full state comparison: it read all 5,120 voxels, including air, and reported 123 leaf-state mismatches caused by the installed parser. These are recorded below; no workaround or state substitution was applied. Compilation correctness is distinct from visual fidelity: the blueprint explicitly documents inferred geometry and intentionally omitted water/entities.

## Artifact facts

| Item | Result |
|---|---|
| Blueprint | [schematics/blueprints/13_skull_cave.json](13_skull_cave.json), 24,723 bytes |
| Blueprint SHA-256 | `a29881f90e96309bf2372e9f68ee99abb4e7633841b05b1d1497a96f5de02cea` |
| Schematic | [schematics/13_skull_cave.schem](../../schems/pack1/13_skull_cave.schem), 915 bytes, nonempty |
| Schematic SHA-256 | `2305ac10ead58f88a1f7d21986c7248a7ecd30a610e21b58660556a8142c48d1` |
| Format | Gzip-compressed Sponge schematic v2 NBT; root Schematic; DataVersion 4189 |
| Dimensions / volume | 20 × 16 × 16 / 5,120 voxels |
| Non-air / air | 2,639 / 2,481 |
| Palette / BlockData | 23 canonical palette states / 5,120 bytes (one-byte VarInt per voxel) |
| Offset / lists | `[0,0,0]`; correctly typed empty List[Compound] Entities and BlockEntities |
| Spot checks | 32 defined; all pass binary validation |

## Commands and binary validation

Commands were run from the project root. The compiler is the existing [compile_blueprint.py](../../tooling/compile_blueprint.py:1); the procedural requirements are documented in [BLUEPRINT_TOOLING.md](../../tooling/BLUEPRINT_TOOLING.md:1).

- [`python3 schematics/compile_blueprint.py compile schematics/blueprints/13_skull_cave.json schematics/13_skull_cave.schem`](../../tooling/compile_blueprint.py:204) — exit 0; compilation also reloaded and independently validated its output through nbtlib.
- [`python3 schematics/compile_blueprint.py validate schematics/blueprints/13_skull_cave.json schematics/13_skull_cave.schem`](../../tooling/compile_blueprint.py:204) — exit 0. Verified gzip/NBT parsing, tag types, v2/DataVersion, exact dimensions, zero offset, empty typed entity lists, exact canonical palette and IDs, complete canonical VarInt stream, every voxel in x-fastest/z-next/y-next order, counts, volume, and all 32 spot checks.
- [`python3 schematics/compile_blueprint.py test-varints`](../../tooling/compile_blueprint.py:204) — exit 0; 1–5 byte boundaries and known encodings passed; overlong/noncanonical encoding rejected.

Binary validation returned: dimensions `[20,16,16]`; volume 5,120; non-air 2,639; air 2,481; palette entries 23; BlockData 5,120 bytes; spot checks 32; schematic 915 bytes; SHA-256 `2305ac10ead58f88a1f7d21986c7248a7ecd30a610e21b58660556a8142c48d1`.

### Blueprint state counts

All 23 expected counts matched in binary validation:

| Canonical state | Count |
|---|---:|
| minecraft:air | 2,481 |
| minecraft:chest[facing=east,type=single,waterlogged=false] | 2 |
| minecraft:chest[facing=north,type=single,waterlogged=false] | 1 |
| minecraft:chest[facing=west,type=single,waterlogged=false] | 1 |
| minecraft:diamond_block | 4 |
| minecraft:dirt | 260 |
| minecraft:emerald_block | 4 |
| minecraft:gold_block | 9 |
| minecraft:grass_block[snowy=false] | 260 |
| minecraft:jungle_fence[east=false,north=false,south=false,waterlogged=false,west=false] | 6 |
| minecraft:jungle_leaves[distance=7,persistent=true,waterlogged=false] | 123 |
| minecraft:jungle_slab[type=bottom,waterlogged=false] | 35 |
| minecraft:jungle_stairs[facing=north,half=bottom,shape=straight,waterlogged=false] | 6 |
| minecraft:smooth_quartz | 174 |
| minecraft:smooth_quartz_slab[type=bottom,waterlogged=false] | 16 |
| minecraft:smooth_quartz_slab[type=top,waterlogged=false] | 5 |
| minecraft:smooth_quartz_stairs[facing=east,half=bottom,shape=straight,waterlogged=false] | 2 |
| minecraft:smooth_quartz_stairs[facing=south,half=bottom,shape=straight,waterlogged=false] | 4 |
| minecraft:smooth_quartz_stairs[facing=south,half=top,shape=straight,waterlogged=false] | 6 |
| minecraft:smooth_quartz_stairs[facing=west,half=bottom,shape=straight,waterlogged=false] | 2 |
| minecraft:soul_lantern[hanging=true,waterlogged=false] | 5 |
| minecraft:stone | 1,666 |
| minecraft:vine[east=false,north=false,south=true,up=false,west=false] | 48 |

## Minecraft registry and real production reader

Ran [`node schematics/validate_blueprint.mjs schematics/blueprints/13_skull_cave.json schematics/13_skull_cave.schem`](../../tooling/validate_blueprint.mjs:1), using the installed minecraft-data 1.21.4 registry and the production schematic reader. Exit status was 2, **because the complete state comparison failed**, not because the program failed to run.

Checker outcomes:

- All 23 legend entries validated against vanilla Minecraft 1.21.4, including the full canonical property sets and legal values.
- Dimensions `[20,16,16]` and volume 5,120 passed; compared voxels 5,120, including air.
- Parser-derived air count was 2,481, matching the blueprint. All counts match except the two leaf states below.
- Full voxel-and-state comparison: **FAIL**, 123 mismatches.
- Spot checks: **31/32 pass; one fails** at `(x=1,y=15,z=3)`, expected jungle leaves with distance 7, persistent true, waterlogged false; parser returned acacia leaves with distance 1, persistent true, waterlogged false.
- Count differences: expected jungle leaves 123, actual 0; expected acacia leaves 0, actual 123. No other state count differs.

An additional read-only coordinate enumeration through the same production reader confirmed **all 123** differences are exactly this conversion:

- Expected at every listed position: `minecraft:jungle_leaves[distance=7,persistent=true,waterlogged=false]`.
- Actual at every listed position: `minecraft:acacia_leaves[distance=1,persistent=true,waterlogged=false]`.
- No other voxel/state mismatches were found. Coordinates below are `(x,z)` grouped by `y`.

| y | Mismatch positions `(x,z)` |
|---:|---|
| 2 | (0,2), (19,2) |
| 3 | (0,2), (1,2), (19,2) |
| 4 | (0,2), (1,2), (17,2), (19,2) |
| 5 | (0,2), (1,2), (17,2), (19,2) |
| 6 | (0,2), (1,2), (17,2) |
| 7 | (1,2), (2,2), (17,2) |
| 8 | (1,2), (2,2), (17,2), (18,2) |
| 9 | (1,2), (2,2), (18,2) |
| 10 | (1,2), (2,2), (18,2) |
| 11 | (2,2), (18,2) |
| 12 | (2,2), (18,2) |
| 15 | (1,3), (2,3), (5,3), (6,3), (11,3), (12,3), (17,3), (18,3), (1,4), (5,4), (6,4), (10,4), (11,4), (17,4), (18,4), (2,5), (3,5), (7,5), (8,5), (12,5), (13,5), (16,5), (3,6), (7,6), (11,6), (12,6), (16,6), (17,6), (1,7), (4,7), (5,7), (9,7), (10,7), (14,7), (18,7), (1,8), (4,8), (8,8), (9,8), (13,8), (14,8), (18,8), (2,9), (3,9), (6,9), (7,9), (11,9), (15,9), (16,9), (2,10), (6,10), (7,10), (10,10), (11,10), (15,10), (19,10), (0,11), (4,11), (5,11), (9,11), (13,11), (14,11), (18,11), (0,12), (4,12), (8,12), (9,12), (13,12), (17,12), (18,12), (1,13), (2,13), (6,13), (7,13), (11,13), (12,13), (16,13), (2,14), (5,14), (6,14), (10,14), (11,14), (15,14), (16,14), (1,15), (5,15), (9,15), (10,15), (14,15), (18,15) |

This is an observed production-parser state conversion. The blueprint's 123 jungle-leaf entries, `distance=7`, and `persistent=true` were retained in the NBT and fully passed the independent binary comparison; no geometry/state changes or parser workaround were made.

## Determinism and mechanical geometry audits

Recompiled the same JSON to a newly created temporary directory using the existing compiler, compared the temporary file byte-for-byte with the permanent schematic (`cmp`), then removed the temporary directory with the shell cleanup trap. The comparison passed; both compilations were 915 bytes and had SHA-256 `2305ac10ead58f88a1f7d21986c7248a7ecd30a610e21b58660556a8142c48d1`. The JSON and permanent schematic were both confirmed nonempty; their byte sizes and hashes are recorded above.

Read-only structural checks against the JSON layers:

- Printed host bounds are exactly `x=0..19, y=0..14, z=3..15`, dimensions 20 × 15 × 13 (3,900 cells), within the 20 × 16 × 16 full artifact envelope.
- There are 387 non-air cells outside the printed host box: 297 at northward `z=0..2` (facade/projections) and 90 at the `y=15` leaf layer; zero other out-of-host cells. The remaining 2,252 non-air cells are within the printed host box. This distinction preserves the printed site dimensions without incorrectly truncating the skull/roof envelope.
- All 48 south-facing vines have a non-air supporting cell at `z+1`: 24 stone, 16 jungle leaves, 2 smooth quartz, 5 dirt, and 1 grass block. No vine is unsupported. The six dirt/grass attachments are solid supports; they make the source audit's shorthand “quartz/stone/leaves” non-exhaustive, but are not a geometry failure.
- All five hanging lanterns have stone directly above at `y+1`.
- The 2,639 non-air layer cells agree with the blueprint's declared count.

## Printed-source interpretation and limits

The blueprint represents one progressively assembled Skull Cave, not several builds. The 20 × 15 × 13 printed dimension is retained as the host cliff box; the complete schematic adds the northward skull projection and top foliage. The printed entrance is 11 rows high while the book specifies only five upper rows and four lower rows; the two intervening width-7 rows are explicitly inferred. Cave depth 12, hidden chamber, facade, platform, stairs, treasures, lantern count, and foliage arrangement/states are documented blueprint interpretations, not pixel-perfect recoverable geometry.

The blueprint deliberately excludes depicted water, a water apron/basin, boat, player, and all entities. The resulting entrance is dry; it is not validated as a boat route, and no navigation/physics test was performed. Binary correctness proves faithful encoding of the existing audited blueprint, not visual exactness or omitted-water equivalence.
