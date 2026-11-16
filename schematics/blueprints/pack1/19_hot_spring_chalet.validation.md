> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/19_hot_spring_chalet.json schematics/schems/pack1/19_hot_spring_chalet.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/19_hot_spring_chalet.json schematics/schems/pack1/19_hot_spring_chalet.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/19_hot_spring_chalet.json schematics/schems/pack1/19_hot_spring_chalet.schem 1.21.4
> ```

# Folder 19 — hot-spring chalet verification

Source of truth: [19_hot_spring_chalet.json](19_hot_spring_chalet.json). Compiled artifact: [19_hot_spring_chalet.schem](../../schems/pack1/19_hot_spring_chalet.schem). Procedure follows [BLUEPRINT_TOOLING.md](../../tooling/BLUEPRINT_TOOLING.md); no source geometry, state value, tool, dependency, or other folder artifact was changed.

## Blueprint and artifact facts

| Check | Result |
|---|---|
| Geometry | 10 × 6 × 13; volume 780; layers are `layers[y][z][x]` |
| Blueprint counts | 239 non-air; 541 air |
| Legend / palette | 13 explicit states; complete palette has 13 entries |
| Spot checks | 14 defined; all 14 pass binary validation |
| Artifact size | 473 bytes |
| SHA-256 | `5da9aeaff9c9425e1b28b75e3abd3d50d0b8b35c1be0aa1ad0dc198bb095c52c` |
| BlockData | 780 bytes / 780 decoded canonical VarInts |

NBT was decompressed and independently parsed with `nbtlib`: root `Schematic`; Sponge `Version=2`; `DataVersion=4189`; `Width=10`, `Height=6`, `Length=13`; `Offset=[0,0,0]`; `PaletteMax=13`; 13 palette entries; empty `BlockEntities` and `Entities`. Checked tag types: `Version`/`DataVersion`/`PaletteMax` are `Int`, dimensions `Short`, `Offset` `IntArray`, `Palette` `Compound`, `BlockData` `ByteArray`, and both entity tags `List[Compound]`.

## Commands and binary verification

Commands were run from the project root. Each listed command exited `0`.

- [`python3 schematics/compile_blueprint.py compile schematics/blueprints/19_hot_spring_chalet.json schematics/19_hot_spring_chalet.schem`](../../tooling/compile_blueprint.py:1) — wrote the artifact and the compile command's own independent NBT/full-voxel validation passed; 473 bytes, SHA-256 above.
- [`python3 schematics/compile_blueprint.py validate schematics/blueprints/19_hot_spring_chalet.json schematics/19_hot_spring_chalet.schem`](../../tooling/compile_blueprint.py:1) — independent reload validation passed: 10 × 6 × 13, 239 non-air, 541 air, 13 palette entries, 14/14 spots.
- [`python3 schematics/compile_blueprint.py compile schematics/blueprints/19_hot_spring_chalet.json /tmp/tmp.Zje2HWIChr/19_hot_spring_chalet.schem`](../../tooling/compile_blueprint.py:1) — deterministic second compile to a temporary directory; exit `0`. `cmp -s` against the permanent artifact exited `0` (byte-identical); both SHA-256 values were `5da9aeaff9c9425e1b28b75e3abd3d50d0b8b35c1be0aa1ad0dc198bb095c52c`. The temporary directory was removed automatically by the command's exit trap.
- [`python3 schematics/compile_blueprint.py test-varints`](../../tooling/compile_blueprint.py:1) — exit `0`; canonical VarInt round trips across 1–5 byte boundaries passed and overlong encoding was rejected.

The binary validator confirmed every voxel, including air, canonical state palette, counts and all spot checks in x-fastest, z-next, y-next order. Geometry and explicit values are preserved.

## Registry and production-reader validation

[`node schematics/validate_blueprint.mjs schematics/blueprints/19_hot_spring_chalet.json schematics/19_hot_spring_chalet.schem`](../../tooling/validate_blueprint.mjs:1) exited **0**. All 13 legend entries passed complete-property-set and value validation against `minecraft-data` Minecraft 1.21.4. The production `readSchematic` → `prismarine-schematic` reader returned the correct dimensions and compared all 780/780 voxels including air: **0 state mismatches**, counts matched (541 air, 239 non-air), and **14/14** reader spot checks passed. Full canonical property sets matched at every voxel.

## Fidelity limits

The printed 8 × 11 dimension refers to the foundation envelope, while the exported 10 × 6 × 13 bounds include inferred one-cell roof overhang. The 8 × 8 deck, open three-row porch bay, roof height/pitch and detailed tile/slab pattern, fence returns, and exact unseen rear surfaces are interpretations where the reference has no dimensions. The six slim columns are represented with cobblestone walls despite the printed wording's ambiguity between wall and full cobblestone blocks. The hanging lantern's count is specified, but its exact position is inferred. The chalet is a separate export, not geometrically combined with the thermal landscape. Local checks establish artifact consistency only; no live server, placement, or physics test was performed or claimed.
