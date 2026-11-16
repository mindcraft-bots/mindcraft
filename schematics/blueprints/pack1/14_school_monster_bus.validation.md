> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/14_school_monster_bus.json schematics/schems/pack1/14_school_monster_bus.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/14_school_monster_bus.json schematics/schems/pack1/14_school_monster_bus.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/14_school_monster_bus.json schematics/schems/pack1/14_school_monster_bus.schem 1.21.4
> ```

# Folder 14 — School Monster-Bus validation

## Artifacts and scope

The permanent architecture remains the source of truth in [`14_school_monster_bus.json`](14_school_monster_bus.json). The compiled artifact is [`14_school_monster_bus.schem`](../../schems/pack1/14_school_monster_bus.schem). No blueprint geometry, source images, dependencies, compiler/validator tools, or other folders were modified for this build.

The recorded source set is the two folder-14 images from the blueprint audit. They show one school monster-bus assembled in steps 1–8 and a reverse/cutaway view of that same vehicle, not additional builds. The city, street, buildings, player, and clouds are excluded.

## Audited dimensions and counts

| Check | Audited result |
| --- | --- |
| Matrix, X×Y×Z | 8×10×15; volume 1,200 voxels |
| Non-air / air | 463 / 737 |
| Legend states / spot checks | 35 / 37 |
| Structural wheel envelope | 8×13 (x=0..7, z=1..13); four tires |
| Initial printed platform | 13×4 (x=2..5, z=1..13); exact construction-stage footprint |
| Hood | 8 yellow-concrete cells, 4×2 (x=2..5, z=1..2 at y=5) |
| Artifact envelope | Includes the attachment-inclusive front/rear z=0..14 sign/button cells, wheel-ground y=0, and roof y=9 |

The final 13×4 platform construction step has 44 black-concrete floor cells: its four front-edge cells are represented by the four furnace grille blocks and its four rear-edge cells by the yellow sill. This is the documented step-to-final-state interpretation, not an extra hidden duplicate floor. The compiler independently checked that all 35 canonical legend states sum to the stated 1,200 cells and agree with the blueprint's exact state counts. In particular, the binary count is 463 non-air plus 737 air.

## Compilation and binary checks

Used the existing [`compile_blueprint.py`](../../tooling/compile_blueprint.py) `compile`, `validate`, and `test-varints` commands as documented in [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md):

```sh
python3 schematics/compile_blueprint.py compile \
  schematics/blueprints/14_school_monster_bus.json schematics/14_school_monster_bus.schem
python3 schematics/compile_blueprint.py validate \
  schematics/blueprints/14_school_monster_bus.json schematics/14_school_monster_bus.schem
python3 schematics/compile_blueprint.py test-varints
```

Compilation and the standalone reload validation both passed. The output is gzip-compressed Sponge v2 NBT, DataVersion 4189, with typed NBT tags, zero offset, a complete 35-state palette, x-fastest/z-next/y-next voxel stream, and correctly typed empty `Entities` and `BlockEntities` lists. The standalone validation compared all 1,200 palette-decoded voxels to the blueprint, including air, and checked the complete state counts and all 37 spots. VarInt boundary self-test passed for 1–5 byte values and rejected a non-canonical overlong encoding.

## Registry and production-reader checks

Ran [`validate_blueprint.mjs`](../../tooling/validate_blueprint.mjs), which validates each full canonical legend state against the installed vanilla Minecraft 1.21.4 registry and compares the schematic through production `readSchematic` for every voxel, including air:

- Registry: all 35 legend states validated.
- Production reader: 1,200/1,200 voxels compared; full canonical block names and properties matched.
- Parser mismatches: 0; count differences: 0; spot-check failures: 0 (37/37 passed).
- Reader-derived counts: 463 non-air and 737 air; counts matched the blueprint.
- Result: full voxel/state comparison PASS. No parser workaround or geometry change was applied.

This is a local file/registry check only; there was no live server or in-world placement test.

## Reproducibility and permanent artifact fingerprints

Compiled a second time to a temporary path and compared SHA-256 hashes. The permanent and second-build schematic hashes are identical:

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| [`14_school_monster_bus.json`](14_school_monster_bus.json) | 23,965 bytes | `a87d1591bbeb937f1ce20ec3e9ed6fc407c9ad74dd6aa67cf20b369a1ef36018` |
| [`14_school_monster_bus.schem`](../../schems/pack1/14_school_monster_bus.schem) | 920 bytes | `dc1785bb1c523fa34d049b7937b950a313d245eae7313df21d398522090eb6d9` |
| Second compile (`/tmp/14_school_monster_bus.determinism.schem`, temporary) | 920 bytes | `dc1785bb1c523fa34d049b7937b950a313d245eae7313df21d398522090eb6d9` |

The JSON and permanent schematic are both nonempty. The temporary comparison output is not a project artifact.

## Fidelity limits and intentional omissions

This is one explicit, dry reconstruction from perspective images, not a recovered exact hidden-voxel model. The 8×13 wheel envelope, 13×4 initial platform, eight-cell 4×2 yellow hood, and stated material/callout counts are retained. The overall 8×10×15 attachment-inclusive envelope, tire profile and internal offsets, body/window/roof heights and details, door/window splits, ladder/warning-bracket placement, and interior seat, carpet, and handrail arrangement are inferred where the images do not provide complete orthographic measurements. The printed structural envelope excludes the thin sign/button cells that extend the matrix to z=0..14.

Printed ordinary and glow item frames for lights are intentionally omitted because they are entities; the resulting bare yellow corners are a known visual mismatch, not a substitute lamp implementation. Front and rear warped signs are blank and have no block-entity/text NBT. The warning redstone block is static; no flashing, powered behavior, vehicle movement, or other function is claimed. Furnace contents, entities, fluids, and complex NBT are absent. Binary/reader validation establishes serialization and exact agreement with this blueprint, not visual fidelity to unseen geometry or gameplay behavior.
