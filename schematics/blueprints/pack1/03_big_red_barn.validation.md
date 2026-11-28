> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/03_big_red_barn.json schematics/schems/pack1/03_big_red_barn.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/03_big_red_barn.json schematics/schems/pack1/03_big_red_barn.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/03_big_red_barn.json schematics/schems/pack1/03_big_red_barn.schem 1.21.4
> ```

# Folder 03 binary validation — Big Red Barn

## Inputs and audit interpretation

- Blueprint: [03_big_red_barn.json](03_big_red_barn.json)
- Binary output: [03_big_red_barn.schem](../../schems/pack1/03_big_red_barn.schem)
- Source images, inspected in the recorded order: [IMG_20261115_155842-1536x1152.jpg](../../screenshots/pack1/3/IMG_20261115_155842-1536x1152.jpg), then [IMG_20261115_155852-1536x1152.jpg](../../screenshots/pack1/3/IMG_20261115_155852-1536x1152.jpg).
- The dimension audit records a printed 12×17 ground footprint, 7-block corner posts, an 11-course gable interpretation, a 14×19 roof-inclusive footprint, and an 18×17×19 attachment-inclusive envelope. The 11 wall courses exclude the dirt base; the gable apex is at y=11, ridge at y=12, and the ventilator reaches bottom slabs at y=16.
- The image does not numerically specify roof overhang, pen, windows, ventilator, or interior dimensions. The blueprint therefore explicitly records interpretations: symmetric gables and curved roof profile; open 4×4 end entrances; mirrored long-wall windows; an inferred east-side pen and canopy; open interior stalls/beams/hay/torches; and a hollow ventilator with stepped birch cap. Red finish allocation, exact attachment dimensions, and some interior details are acknowledged as inferred rather than printed facts. No door blocks, mobs, scenery, or speculative block entities were added.
- The blueprint's canonical states and full explicit [`layers[y][z][x]`](03_big_red_barn.json) volume were preserved; no geometry or state edits were made for compilation or validation.

## Build and verification results

All commands below were run from the project root using the existing tooling unchanged.

- Compile: [`python3 schematics/compile_blueprint.py compile schematics/blueprints/03_big_red_barn.json schematics/03_big_red_barn.schem`](../../tooling/compile_blueprint.py)
- VarInt suite: [`python3 schematics/compile_blueprint.py test-varints`](../../tooling/compile_blueprint.py)
- Binary revalidation: [`python3 schematics/compile_blueprint.py validate schematics/blueprints/03_big_red_barn.json schematics/03_big_red_barn.schem`](../../tooling/compile_blueprint.py)
- Production reader and registry: [`node schematics/validate_blueprint.mjs schematics/blueprints/03_big_red_barn.json schematics/03_big_red_barn.schem`](../../tooling/validate_blueprint.mjs)

| Check | Result |
|---|---|
| Compile (nbtlib, gzip Sponge v2, DataVersion 4189; includes independent reload/validation) | PASS, exit 0 |
| VarInt boundary suite (1–5 byte values; overlong encoding rejected) | PASS, exit 0 |
| Independent binary validation | PASS, exit 0 |
| Production [`readSchematic()`](../../../src/utils/schematic/reader.js:173) and full canonical Minecraft 1.21.4 registry validation | PASS, exit 0 |
| Production comparison | 5,814/5,814 voxels including air and full states matched; 26 legend states registry-valid; expected counts matched; 16/16 spot checks passed; 0 mismatches |
| Deterministic second compilation in a temporary directory | PASS; byte-identical SHA-256 |

| Binary facts | Verified value |
|---|---:|
| Dimensions (X×Y×Z) | 18×17×19 |
| Volume | 5,814 |
| Non-air / air | 1,102 / 4,712 |
| Palette entries / distinct canonical states | 26 |
| BlockData stream | 5,814 bytes; complete VarInt stream, x-fastest then z then y |
| Sponge Version / DataVersion | 2 / 4189 |
| Offset | `[0, 0, 0]` |
| `BlockEntities` / `Entities` | empty `List[Compound]` / empty `List[Compound]` |
| NBT structure | Root `Schematic`; expected tag types and integer palette entries validated |
| Schematic file size | 946 bytes |
| Schematic SHA-256 | `68cd72d47b5af6f72c59b225eaa24a1c026b1529b023e14083bb3e427f38c813` |
| Blueprint JSON size / SHA-256 | 22,424 bytes / `05299a5636968e39fc9f225abbd9b5df98d3552601ddef017e016514c44da106` |

Expected counts were checked against the blueprint and the complete serialized volume: birch fence states 40, birch fence gate 1, birch planks 89, birch slab states 159, birch stair states 164, dirt 229, glass pane states 24, hay blocks 15, red concrete 171, red concrete powder 10, red terracotta 86, wall torches 4, white concrete 110, and air 4,712.

## Limitations

No live-server test was performed. These local checks do not establish survival placement order, neighbor-update stability, or exact photographic fidelity. No production-reader discrepancy was observed for this blueprint.
