> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/03_storage_silo.json schematics/schems/pack1/03_storage_silo.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/03_storage_silo.json schematics/schems/pack1/03_storage_silo.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/03_storage_silo.json schematics/schems/pack1/03_storage_silo.schem 1.21.4
> ```

# Folder 03 binary validation — Storage Silo

## Inputs and audit interpretation

- Blueprint: [03_storage_silo.json](03_storage_silo.json)
- Binary output: [03_storage_silo.schem](../../schems/pack1/03_storage_silo.schem)
- Source images, inspected in the recorded order: [IMG_20261115_155842-1536x1152.jpg](../../screenshots/pack1/3/IMG_20261115_155842-1536x1152.jpg), then [IMG_20261115_155852-1536x1152.jpg](../../screenshots/pack1/3/IMG_20261115_155852-1536x1152.jpg).
- No numeric silo dimensions are printed. The blueprint marks all dimensions as inferred and records a 9×9 dirt base, 7×7 body with four 1×1 corner notches, red courses y=1..17, white band y=18, open vent at y=19, and three roof tiers at y=20..22. The resulting 23-layer envelope has a physical slab top at y=22.5; this is not claimed as a printed 23-block height.
- Red concrete/terracotta/powder, white concrete, birch roof/fence parts, and ladder are appearance-based material interpretations. The ladder's east-facing x=8 column and exact extent are inferred. Roof tier sizes, wall ribs, fence vent supports, the hidden ladder backing, and the empty interior are explicit blueprint interpretations. No speculative chest/storage contents, floors, door, entities, or combined barn+silo placement were added; the relative placement is not encoded by the images.
- The blueprint's canonical states and full explicit [`layers[y][z][x]`](03_storage_silo.json) volume were preserved; no geometry or state edits were made for compilation or validation.

## Build and verification results

All commands below were run from the project root using the existing tooling unchanged.

- Compile: [`python3 schematics/compile_blueprint.py compile schematics/blueprints/03_storage_silo.json schematics/03_storage_silo.schem`](../../tooling/compile_blueprint.py)
- VarInt suite: [`python3 schematics/compile_blueprint.py test-varints`](../../tooling/compile_blueprint.py)
- Binary revalidation: [`python3 schematics/compile_blueprint.py validate schematics/blueprints/03_storage_silo.json schematics/03_storage_silo.schem`](../../tooling/compile_blueprint.py)
- Production reader and registry: [`node schematics/validate_blueprint.mjs schematics/blueprints/03_storage_silo.json schematics/03_storage_silo.schem`](../../tooling/validate_blueprint.mjs)

| Check | Result |
|---|---|
| Compile (nbtlib, gzip Sponge v2, DataVersion 4189; includes independent reload/validation) | PASS, exit 0 |
| VarInt boundary suite (1–5 byte values; overlong encoding rejected) | PASS, exit 0 |
| Independent binary validation | PASS, exit 0 |
| Production [`readSchematic()`](../../../src/utils/schematic/reader.js:173) and full canonical Minecraft 1.21.4 registry validation | PASS, exit 0 |
| Production comparison | 1,863/1,863 voxels including air and full states matched; 14 legend states registry-valid; expected counts matched; 14/14 spot checks passed; 0 mismatches |
| Deterministic second compilation in a temporary directory | PASS; byte-identical SHA-256 |

| Binary facts | Verified value |
|---|---:|
| Dimensions (X×Y×Z) | 9×23×9 |
| Volume | 1,863 |
| Non-air / air | 616 / 1,247 |
| Palette entries / distinct canonical states | 14 |
| BlockData stream | 1,863 bytes; complete VarInt stream, x-fastest then z then y |
| Sponge Version / DataVersion | 2 / 4189 |
| Offset | `[0, 0, 0]` |
| `BlockEntities` / `Entities` | empty `List[Compound]` / empty `List[Compound]` |
| NBT structure | Root `Schematic`; expected tag types and integer palette entries validated |
| Schematic file size | 497 bytes |
| Schematic SHA-256 | `cce83cb03d3dbea8254632978e52dd5325694d52a307436238b19c28d5da36c0` |
| Blueprint JSON size / SHA-256 | 12,321 bytes / `aa8a08a42b2049f0cfda9e6ec376875740dc78d0b90fabac2d7462555855b920` |

Expected counts were checked against the blueprint and the complete serialized volume: birch fence 8, birch planks 75, birch bottom slabs 25, birch stair states 47, dirt 81, east-facing ladder 20, red concrete 192, red concrete powder 12, red terracotta 136, white concrete 20, and air 1,247.

## Limitations

No live-server test was performed. These local checks do not establish survival placement order, neighbor-update stability, or exact photographic fidelity. No production-reader discrepancy was observed for this blueprint.
