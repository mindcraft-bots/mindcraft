> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/12_scouting_tower.json schematics/schems/pack1/12_scouting_tower.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/12_scouting_tower.json schematics/schems/pack1/12_scouting_tower.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/12_scouting_tower.json schematics/schems/pack1/12_scouting_tower.schem 1.21.4
> ```

# Folder 12 — Scouting tower compilation and validation

## Current production-reader result — 2026-11-15 repair

**PASS:** all 4,563 voxels, exact block states/counts and all 25 spot checks now match. The original 54 mismatched voxels were caused by the shared dependency encoding one-based integer values as literal offsets instead of registry value indices. The [narrow dependency patch](../../../patches/prismarine-schematic+1.3.0.patch) repairs the reader without altering this blueprint or schematic; both hashes match the [preserved baseline](../../tooling/validation/reader_baseline.json). See the [current batch diagnosis and placement limitations](../../schems/pack1/batch_report.md) and [fresh production-reader log](../../tooling/validation/build_logs/pack1/12_scouting_tower.reader.log). This does not certify live placement or remove reconstruction/physics limitations. The initial narrative below is retained as historical evidence, including its now-resolved reader-failure statements.

## Original reconstruction validation — before reader repair

## Scope and source

Compiled the permanent explicit blueprint [`12_scouting_tower.json`](12_scouting_tower.json) only, following [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md), to [`12_scouting_tower.schem`](../../schems/pack1/12_scouting_tower.schem). The blueprint geometry, states, and source were not changed. No other folder, compiler/validator source, dependency, or [`batch_report.md`](../../schems/pack1/batch_report.md) was edited. The blueprint remains the source of truth.

## Commands and compiler/binary results

All commands ran from the project root. The compiler is [`compile_blueprint.py`](../../tooling/compile_blueprint.py) and uses `nbtlib`.

```sh
python3 schematics/compile_blueprint.py compile \
  schematics/blueprints/12_scouting_tower.json schematics/12_scouting_tower.schem
python3 schematics/compile_blueprint.py validate \
  schematics/blueprints/12_scouting_tower.json schematics/12_scouting_tower.schem
python3 schematics/compile_blueprint.py test-varints
tmp=$(mktemp /tmp/12_scouting_tower.XXXXXX.schem)
python3 schematics/compile_blueprint.py compile \
  schematics/blueprints/12_scouting_tower.json "$tmp"
cmp -s schematics/12_scouting_tower.schem "$tmp"
sha256sum schematics/12_scouting_tower.schem "$tmp"
wc -c schematics/12_scouting_tower.schem
```

Every Python command exited 0. `compile` and its built-in reload validation, then independent `validate`, both reported:

| Check | Result |
|---|---:|
| Dimensions (X × Y × Z) | 13 × 27 × 13 |
| Volume / decoded canonical VarInts | 4563 / 4563 |
| Non-air / air | 872 / 3691 |
| Canonical palette states | 36 |
| Binary spot checks | 25 / 25 passed |
| Gzipped Sponge v2 schematic size | 1106 bytes |
| SHA-256 | `774f18ad7a1b016cae92fde687cd210f21e2c4bfa1b8e117a7890a4080e11961` |

The validator reloaded the gzip NBT and checked the full voxel stream, palette, counts, and spots. It confirmed root name `Schematic`; `Version` is `Int(2)`, `DataVersion` is `Int(4189)`, `Width`/`Height`/`Length` are `Short(13/27/13)`, `Offset` is `IntArray[0,0,0]`, `PaletteMax` is an `Int` equal to 36, `Palette` is a `Compound` with contiguous canonical `Int` IDs, and `BlockData` is a `ByteArray`. `BlockEntities` and `Entities` are empty `List[Compound]` tags. All 4563 canonical signed-byte VarInts decode in x-fastest, z-next, y-next order to the exact blueprint voxel sequence, including air; every binary spot matches. The explicit `test-varints` command passed 1–5 byte boundary coverage and rejected the overlong encoding.

The temporary second compile reported the same 1106-byte output and SHA-256. `cmp` reported byte-for-byte identical (`yes`); both files hashed to `774f18ad7a1b016cae92fde687cd210f21e2c4bfa1b8e117a7890a4080e11961`. The temporary file was removed after comparison.

## Production reader and vanilla registry

Ran the existing [`validate_blueprint.mjs`](../../tooling/validate_blueprint.mjs), which imports the production [`readSchematic()`](../../../src/utils/schematic/reader.js) reader, checks the installed Minecraft 1.21.4 registry, and compares all voxels and full properties, including air:

```sh
node schematics/validate_blueprint.mjs \
  schematics/blueprints/12_scouting_tower.json schematics/12_scouting_tower.schem
```

The command exited **2**, a validation failure that is retained and reported, not hidden. It successfully validated all 36 legend entries against `minecraft-data 1.21.4`; dimensions were `[13,27,13]`; it compared all 4563 voxels; parser-derived air was 3691; the 25 spot checks ran; and it found **54** full-state mismatches. No registry-entry or dimension failure occurred.

### Reader count differences

The expected leaf counts by state are shifted by the parser, and eight distance-7 leaves are read as birch leaves. All non-leaf state counts matched. These are the complete count differences from the production validator:

| Canonical state | Expected | Reader |
|---|---:|---:|
| `minecraft:birch_leaves[distance=1,persistent=true,waterlogged=false]` | 0 | 8 |
| `minecraft:spruce_leaves[distance=1,persistent=true,waterlogged=false]` | 20 | 0 |
| `minecraft:spruce_leaves[distance=2,persistent=true,waterlogged=false]` | 15 | 20 |
| `minecraft:spruce_leaves[distance=3,persistent=true,waterlogged=false]` | 5 | 15 |
| `minecraft:spruce_leaves[distance=4,persistent=true,waterlogged=false]` | 2 | 5 |
| `minecraft:spruce_leaves[distance=5,persistent=true,waterlogged=false]` | 3 | 2 |
| `minecraft:spruce_leaves[distance=6,persistent=true,waterlogged=false]` | 1 | 3 |
| `minecraft:spruce_leaves[distance=7,persistent=true,waterlogged=false]` | 8 | 1 |

The tool's `firstMismatches` field is intentionally capped at 20. To preserve the complete mismatch details, the production `readSchematic()` parser was also traversed independently over the same full volume; the following coordinate groups include all 54 differing `(x,y,z)` locations. For each group, expected and actual states are stated exactly; coordinates are in `x,y,z` order.

| Count | Expected → actual | All differing coordinates (`x,y,z`) |
|---:|---|---|
| 20 | `spruce_leaves[distance=1,persistent=true,waterlogged=false]` → `spruce_leaves[distance=2,persistent=true,waterlogged=false]` | `(11,0,10); (11,1,10); (10,1,11); (11,2,10); (10,2,11); (11,3,10); (10,3,11); (11,4,10); (10,4,11); (2,5,3); (11,5,10); (10,5,11); (11,6,9); (9,6,11); (2,7,3); (2,8,3); (3,16,1); (1,16,3); (3,18,1); (1,18,3)` |
| 15 | `spruce_leaves[distance=2,persistent=true,waterlogged=false]` → `spruce_leaves[distance=3,persistent=true,waterlogged=false]` | `(11,2,9); (11,3,9); (11,4,9); (9,4,11); (11,5,9); (9,5,11); (11,6,10); (10,6,11); (9,7,11); (2,16,1); (4,16,1); (1,16,2); (2,18,1); (4,18,1); (1,18,2)` |
| 5 | `spruce_leaves[distance=3,persistent=true,waterlogged=false]` → `spruce_leaves[distance=4,persistent=true,waterlogged=false]` | `(10,7,11); (2,15,1); (1,15,2); (2,19,1); (1,19,2)` |
| 2 | `spruce_leaves[distance=4,persistent=true,waterlogged=false]` → `spruce_leaves[distance=5,persistent=true,waterlogged=false]` | `(2,14,1); (1,14,2)` |
| 3 | `spruce_leaves[distance=5,persistent=true,waterlogged=false]` → `spruce_leaves[distance=6,persistent=true,waterlogged=false]` | `(2,13,1); (1,13,2); (3,14,1)` |
| 1 | `spruce_leaves[distance=6,persistent=true,waterlogged=false]` → `spruce_leaves[distance=7,persistent=true,waterlogged=false]` | `(2,12,1)` |
| 8 | `spruce_leaves[distance=7,persistent=true,waterlogged=false]` → `birch_leaves[distance=1,persistent=true,waterlogged=false]` | `(5,24,5); (7,24,5); (8,24,5); (5,24,6); (7,24,6); (6,25,5); (7,25,5); (6,26,5)` |

There are exactly two spot-check failures: `(6,26,5)` expects spruce leaves distance 7 but reads birch leaves distance 1; `(2,12,1)` expects spruce leaves distance 6 but reads spruce leaves distance 7. The other 23 spots pass. The parser behavior is consistent with the known prismarine-schematic integer-state conversion issue; no state or source workaround was applied. The binary validation independently confirms the original intended spruce-leaf states are preserved in the schematic palette and voxel stream.

## Limits and disposition

Compilation, NBT/VarInt validation, binary full-volume comparison, all 25 binary spots, deterministic byte comparison, and registry validation passed. The production-reader full-state/count/spot comparison **does not pass** because of the 54 reported leaf-state mismatches above. No live-server test, placement test, climbability test, or survival-physics test was performed. Blueprint geometry/states and all source/tooling files remain untouched.
