> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/10_pachinko_parkour.json schematics/schems/pack1/10_pachinko_parkour.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/10_pachinko_parkour.json schematics/schems/pack1/10_pachinko_parkour.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/10_pachinko_parkour.json schematics/schems/pack1/10_pachinko_parkour.schem 1.21.4
> ```

# Folder 10 pachinko parkour compilation and validation

## Scope and source of truth

This validation covers only folder 10. The permanent explicit blueprint source is [`10_pachinko_parkour.json`](10_pachinko_parkour.json:1); the compiled target is [`10_pachinko_parkour.schem`](../../schems/pack1/10_pachinko_parkour.schem). The source defines dimensions 14 × 16 × 6, origin `(0,0,0)`, and explicit cells in [`layers[y][z][x]`](10_pachinko_parkour.json:25) order. It remains unchanged and is the sole geometry/state source; no JSON was deleted or edited, and no geometry or material/state values were inferred or modified during compilation.

All commands below were run from the project root, `/home/sunny/Projects/github.com/mindcraft-bots/mindcraft`. The required procedure is documented in [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md:5) and uses the existing [`compile_blueprint.py`](../../tooling/compile_blueprint.py:204) and [`validate_blueprint.mjs`](../../tooling/validate_blueprint.mjs:65). Only the requested folder-10 schematic and this validation note were created. No tooling, dependencies, unrelated files, or [`batch_report.md`](../../schems/pack1/batch_report.md) were changed. No live server test was run.

## Compile, binary validation and VarInts

Each command exited **0**:

| Command | Outcome |
| --- | --- |
| [`python3`](../../tooling/compile_blueprint.py:204) [`schematics/compile_blueprint.py`](../../tooling/compile_blueprint.py:204) [`compile`](../../tooling/compile_blueprint.py:207) [`schematics/blueprints/10_pachinko_parkour.json`](10_pachinko_parkour.json:1) [`schematics/10_pachinko_parkour.schem`](../../schems/pack1/10_pachinko_parkour.schem) | Compiled gzip Sponge v2 NBT, reloaded it with [`nbtlib`](../../tooling/compile_blueprint.py:16), and passed the compiler's built-in independent validation. Dimensions `[14,16,6]`; volume `1344`; non-air/air `656/688`; palette states `20`; spot checks `30`; `BlockData` `1344` bytes; artifact `751` bytes; SHA-256 `c058e9ac4ed773a3ee4655b9c3889159b9689ff7b24d8bf4365f2c19b65c1903`. |
| [`python3`](../../tooling/compile_blueprint.py:210) [`schematics/compile_blueprint.py`](../../tooling/compile_blueprint.py:210) [`validate`](../../tooling/compile_blueprint.py:210) [`schematics/blueprints/10_pachinko_parkour.json`](10_pachinko_parkour.json:1) [`schematics/10_pachinko_parkour.schem`](../../schems/pack1/10_pachinko_parkour.schem) | **PASS**. Full binary voxel stream, canonical palette, counts, all 30 spot checks and NBT structure matched the source. Exit `0`. |
| [`python3`](../../tooling/compile_blueprint.py:213) [`schematics/compile_blueprint.py`](../../tooling/compile_blueprint.py:213) [`test-varints`](../../tooling/compile_blueprint.py:213) | **PASS**. Boundary round trips passed for 1–5 byte values, including canonical encodings; the overlong encoding was rejected. Exit `0`. |

The independent binary validation confirmed a gzip-compressed Sponge v2 NBT document with root name `Schematic`, `Version` as `Int` value 2, and `DataVersion` as `Int` value 4189. It checked all expected typed tags, dimensions, zero `Offset`, `PaletteMax=20`, the complete canonical palette with contiguous IDs, and empty typed `List[Compound]` `Entities` and `BlockEntities`. It decoded all `1,344` signed-byte-backed VarInts in x-fastest, z-next, y-next order; every voxel (including air), per-state count, and all spot checks matched the blueprint. No prohibited entity, block-entity payload, fluid, or waterlogged state is present.

### Verified blueprint state counts

| Canonical state | Count |
| --- | ---: |
| `minecraft:air` | 688 |
| `minecraft:birch_button[face=wall,facing=east,powered=false]` | 1 |
| `minecraft:birch_button[face=wall,facing=north,powered=false]` | 5 |
| `minecraft:deepslate_brick_slab[type=bottom,waterlogged=false]` | 26 |
| `minecraft:deepslate_brick_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]` | 1 |
| `minecraft:deepslate_brick_stairs[facing=east,half=top,shape=straight,waterlogged=false]` | 1 |
| `minecraft:deepslate_brick_stairs[facing=west,half=bottom,shape=straight,waterlogged=false]` | 1 |
| `minecraft:deepslate_brick_stairs[facing=west,half=top,shape=straight,waterlogged=false]` | 1 |
| `minecraft:deepslate_bricks` | 28 |
| `minecraft:iron_door[facing=east,half=lower,hinge=right,open=false,powered=false]` | 1 |
| `minecraft:iron_door[facing=east,half=upper,hinge=right,open=false,powered=false]` | 1 |
| `minecraft:ladder[facing=north,waterlogged=false]` | 4 |
| `minecraft:light_blue_concrete` | 28 |
| `minecraft:red_concrete` | 22 |
| `minecraft:redstone_wire[east=none,north=none,power=0,south=none,west=none]` | 5 |
| `minecraft:sea_lantern` | 4 |
| `minecraft:smooth_quartz` | 502 |
| `minecraft:smooth_quartz_stairs[facing=west,half=bottom,shape=straight,waterlogged=false]` | 2 |
| `minecraft:sticky_piston[extended=false,facing=north]` | 5 |
| `minecraft:yellow_concrete` | 18 |

## Minecraft 1.21.4 registry and production-reader validation

Ran [`node`](../../tooling/validate_blueprint.mjs:1) [`schematics/validate_blueprint.mjs`](../../tooling/validate_blueprint.mjs:65) [`schematics/blueprints/10_pachinko_parkour.json`](10_pachinko_parkour.json:1) [`schematics/10_pachinko_parkour.schem`](../../schems/pack1/10_pachinko_parkour.schem) — exit **0**. The validator used the installed Minecraft 1.21.4 [`minecraft-data`](../../tooling/validate_blueprint.mjs:11) registry and the production [`readSchematic`](../../../src/utils/schematic/reader.js:173) parser path.

**PASS:** all `20/20` legend states passed registry validation; all `1,344/1,344` voxels, including air, were compared with full canonical property sets; parser-derived state counts matched (`countDiffs=[]`); all `30/30` spot checks passed (`spotCheckFailures=[]`); and the result reported `parserMismatches=0` and `fullVoxelAndStateComparison=PASS`. No parser mismatch occurred, and no parser/dependency change or state adjustment was made.

## Determinism and artifact checks

The exact rebuild command was [`python3`](../../tooling/compile_blueprint.py:204) [`schematics/compile_blueprint.py`](../../tooling/compile_blueprint.py:204) [`compile`](../../tooling/compile_blueprint.py:207) [`schematics/blueprints/10_pachinko_parkour.json`](10_pachinko_parkour.json:1) `/tmp/10_pachinko_parkour.TsdueB.schem` — exit **0**. The [`sha256sum`](../../tooling/BLUEPRINT_TOOLING.md:35) checks for [`schematics/10_pachinko_parkour.schem`](../../schems/pack1/10_pachinko_parkour.schem) and `/tmp/10_pachinko_parkour.TsdueB.schem` both returned `c058e9ac4ed773a3ee4655b9c3889159b9689ff7b24d8bf4365f2c19b65c1903`; [`cmp`](../../tooling/BLUEPRINT_TOOLING.md:35) confirmed byte identity (exit **0**). The temporary output was removed after the comparison.

| Artifact | Size | Nonempty check |
| --- | ---: | --- |
| Source [`10_pachinko_parkour.json`](10_pachinko_parkour.json:1) | 16,365 bytes | [`test -s`](../../tooling/compile_blueprint.py:150) passed (exit `0`) |
| Compiled [`10_pachinko_parkour.schem`](../../schems/pack1/10_pachinko_parkour.schem) | 751 bytes | [`test -s`](../../tooling/compile_blueprint.py:150) passed (exit `0`) |
| Temporary deterministic rebuild (removed after compare) | 751 bytes | [`test -s`](../../tooling/compile_blueprint.py:150) passed (exit `0`) |

## Blueprint fidelity and limits

The source [`dimension_audit`](10_pachinko_parkour.json:26) records only an explicit 11 × 6 × 4 base, a 9 × 9 target, and two additional top layers. The total 14 × 16 × 6 envelope, three-block stair projection, shell height, half-height top rim, roof/hatch and slab placement are inferred from oblique book photographs. Exact voxel equivalence to those photographs is therefore not certified.

The source [`material_audit`](10_pachinko_parkour.json:52) deliberately excludes lava under the no-fluid constraint: the interior is dry air, not lava or a substitute material, so this is not the illustrated lethal game. Target pixel placement, hidden wiring/supports, piston/button offsets, four upper mechanism positions, stair halves/bevels, and door/button details are visually or structurally inferred. The thin roof rim is interpreted as slabs. Redstone states are isolated, unpowered dots; neighbor updates, door connectivity, piston behavior, timing and route completion are not simulated. The stair approach retains its intentional gap. There is no live/physics test and no guarantee of functional parkour. These fidelity limits and occlusion uncertainties are retained in the source [`state_audit`](10_pachinko_parkour.json:79) and [`occlusion_uncertainties`](10_pachinko_parkour.json:88); binary/registry/parser validity is not a claim of visual or gameplay fidelity.
