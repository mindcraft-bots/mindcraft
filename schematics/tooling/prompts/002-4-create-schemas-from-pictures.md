# Reusable task prompt: generate Mindcraft schematics from pictures

Before using this prompt, replace `<packN>` with a positive pack name (for example `pack1`), `<MC_VERSION>` with the target Minecraft Java version, and `<DATA_VERSION>` with that version's exact DataVersion. Select the numeric screenshot folder(s) requested by the user. Never guess a missing target version or DataVersion.

## Scope and constraints

- Reference inputs are under `schematics/screenshots/<packN>/<numeric-folder>/`. Process only the requested numeric folders; sort them numerically and inspect every supplied `.jpg` in alphanumeric order.
- Target Minecraft Java `<MC_VERSION>` / DataVersion `<DATA_VERSION>`, exactly. Store both in each blueprint and use only block IDs and states valid for that version's vanilla registry.
- This is image-based approximation, not exact recovery: unseen sides, scale and dimensions cannot always be established. Record assumptions and visual compromises rather than asserting unknown details.
- Exclude fluids (water/lava), entities, inventories, block-entity NBT and custom/modded blocks. Prefer simple, compatible block states and avoid unsupported orientation, redstone or mechanism claims.
- Keep each axis at most 256 blocks and total volume at most 1,000,000. Produce a coherent, internally consistent build; where appropriate include a genuinely walkable, hollow interior.

## Per-folder workflow

1. Inventory image names and read every image in order. Use printed dimensions/material labels as primary evidence; explicitly note ambiguity or occlusion.
2. Choose a descriptive `snake_case` slug prefixed by the zero-padded two-digit source-folder number, such as `02_example_build`.
3. Save a complete, explicit source blueprint as `schematics/blueprints/<packN>/<NN_building_slug>.json`. Include dimensions `width_x`, `height_y`, `length_z`; origin and direction conventions; `minecraft_version: "<MC_VERSION>"`; `data_version: <DATA_VERSION>`; legend; `layers[y][z][x]`; exact expected state counts; and spot checks. Use air for empty cells and preserve the JSON as the geometry/state source of truth.
4. Compile the real Sponge v2 gzip-NBT schematic to `schematics/schems/<packN>/<NN_building_slug>.schem`. Do not put new pack assets in the schematic root. Run from the repository root:

   ```sh
   python3 schematics/tooling/compile_blueprint.py compile \
     schematics/blueprints/<packN>/<NN_building_slug>.json \
     schematics/schems/<packN>/<NN_building_slug>.schem
   python3 schematics/tooling/compile_blueprint.py validate \
     schematics/blueprints/<packN>/<NN_building_slug>.json \
     schematics/schems/<packN>/<NN_building_slug>.schem
   python3 schematics/tooling/compile_blueprint.py test-varints
   node schematics/tooling/validate_blueprint.mjs \
     schematics/blueprints/<packN>/<NN_building_slug>.json \
     schematics/schems/<packN>/<NN_building_slug>.schem <MC_VERSION>
   ```

   The binary validator checks NBT types, dimensions, DataVersion, palette, canonical VarInt stream order (X fastest, then Z, then Y), every voxel, counts and spot checks. The Node validator checks the installed version's registry and compares through Mindcraft's production `readSchematic` reader. Report nonzero exits and reader mismatches honestly; do not alter the blueprint simply to manufacture a passing result. No live server test is implied.
5. Write a per-build record at `schematics/blueprints/<packN>/<NN_building_slug>.validation.md` with exact commands and exit statuses, dimensions/counts, validation results, file size/hash, assumptions and limitations. Distinguish binary validity from production-reader comparison and visual fidelity.
6. Track actual progress in `schematics/schems/<packN>/batch_report.md`. Do not mark a build complete until its JSON, `.schem` and validation note exist and are nonempty. Preserve existing report history and generated audit sections.

## Stable group and file IDs

Use the primary public command `!buildSchematic("<packN>:<group>:<file-ID>")`. The group is the numeric screenshot folder, and the file ID is the stable per-group offset in `schematics/schems/<packN>/index.json`; they are never interchangeable. For example, screenshot folder `2` is group `02`, and “build id 01 from group 02 of pack1” translates to `!buildSchematic("pack1:02:01")`. Group and offset accept positive numbers with or without leading zeros. Keep the manifest mappings explicit and persistent; never dynamically alphabetize or renumber offsets. `!listSchematics` displays pack, group, file ID, and filename separately. Numeric dash-form selectors such as `pack1:02-01` are unsupported as IDs; pack-qualified literal filenames/stems and direct filename lookups remain compatible. Numeric group/offset values are positive safe integers (1 through 9007199254740991); pack names use `pack` plus a positive decimal number.

If file-writing access is unavailable, say that the files have not been created and provide a repeatable generator with dependency installation and execution instructions for the exact target paths. In the final report list only actually generated and tested artifacts; include assumptions, version/DataVersion, dimensions/origin, palette/counts, file sizes, validation outcomes, uncertainties, and any omitted features. Do not claim live Mindcraft placement or exact image fidelity.
