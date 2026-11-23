# Reusable task prompt: generate Mindcraft schematics from pictures

Before using this prompt, replace `<packN>` with a positive pack name (for example `pack1`), `<MC_VERSION>` with the target Minecraft Java version, and `<DATA_VERSION>` with that version's exact DataVersion. Select the numeric screenshot folder(s) requested by the user. Never guess a missing target version or DataVersion.

Pack1 examples are illustrative. Keep reusable tools and tests pack-neutral, put genuine pack-specific evidence under that pack's validation directory, and configure optional symmetry targets or archive use under `schematics/tooling/<packN>/`, not in the blueprint folder. Run the recursive schematic suite; use the source-version limits in the tooling guides rather than assuming every diagnostic supports every release.

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
4. Compile the real Sponge v2 gzip-NBT schematic to `schematics/schems/<packN>/<NN_building_slug>.mc<MC_VERSION>.schem`. Do not put new pack assets in the schematic root. The exact release and DataVersion must be covered by the authenticated generated history profiles; consult the compiler guide for availability and evidence limitations. Run from the repository root, substituting actual values:

   ```sh
   python3 schematics/tooling/compile_blueprint.py compile \
     schematics/blueprints/<packN>/<NN_building_slug>.json \
     schematics/schems/<packN>/<NN_building_slug>.mc<MC_VERSION>.schem --target-version <MC_VERSION>
   python3 schematics/tooling/compile_blueprint.py validate \
     schematics/blueprints/<packN>/<NN_building_slug>.json \
     schematics/schems/<packN>/<NN_building_slug>.mc<MC_VERSION>.schem --target-version <MC_VERSION>
   python3 schematics/tooling/compile_blueprint.py test-varints
   node schematics/tooling/validate_blueprint.mjs \
     schematics/blueprints/<packN>/<NN_building_slug>.json \
     schematics/schems/<packN>/<NN_building_slug>.mc<MC_VERSION>.schem <MC_VERSION> --require-strict-provenance
   ```

   Keep the compiler's `.schem.provenance.json` and `.schem.provenance.sha256` sidecars with the artifact. Compilation refuses existing outputs or sidecars: choose a fresh path, never remove user data to retry. Selection requires a known compatible versioned variant and acceptable provenance; an unsuffixed file is not selectable. A family selector chooses the highest compatible version; an explicitly suffixed selector pins it. Strict validation is not a live-server placement guarantee. The binary validator checks NBT types, dimensions, DataVersion, palette, canonical VarInt stream order (X fastest, then Z, then Y), every voxel, counts and spot checks. The Node validator checks the installed version's registry and compares through Mindcraft's production `readSchematic` reader. Report nonzero exits and reader mismatches honestly; do not alter the blueprint simply to manufacture a passing result.
5. Write a per-build record at `schematics/blueprints/<packN>/<NN_building_slug>.validation.md` with exact commands and exit statuses, dimensions/counts, validation results, file size/hash, assumptions and limitations. Distinguish binary validity from production-reader comparison and visual fidelity.
6. Track actual progress in `schematics/schems/<packN>/batch_report.md`. Do not mark a build complete until its JSON, `.schem` and validation note exist and are nonempty. Preserve existing report history and generated audit sections.

## Group, numeric ID, and filename selectors

Keep screenshot-folder group, numeric **file ID**, and actual selected **file name** as distinct values. Each file ID is an explicit, stable per-group mapping in `schematics/schems/<packN>/index.json`; it is not a sorted filename position and must not be recomputed after additions or renames. The schema-version-2 manifest nests numeric IDs under numeric groups and maps each entry to an unsuffixed logical `.schem` family key, not a physical output. `!listSchematics` displays pack, group, file ID, and selected file name separately.

For a direct script call, the file-ID selector is `!buildSchematic("<packN>:<group>:<fileId>")`, ordered pack, group, fileId. For example, screenshot folder `2` and file ID `1` in pack1 are `!buildSchematic("pack1:2:1")`, also accepted with leading zeroes as `!buildSchematic("pack1:02:01")`. Numeric components must be positive safe integers and the mapping must exist. Preserve the existing positional command behavior; do not alter parameter order.

An explicitly addressed human message begins with the bot name and `build`. Full/short labels are `file id` / `id` for a numeric selector and `file name` / `file` for an actual filename. `offset` and bare numeric shorthand remain supported. Prefix aliases `schematic`, `schema`, `schem`, and `scheme` work with ID and filename labels; each alias also substitutes for `file` in full pack-qualified filename contexts. Examples: `Andy build a balloon using schematic file id 01 from group 02 of pack1`; `Andy build file id 01 from group 02 of pack1`; `Andy build file name 02_bee_hot_air_balloon of pack1`; `Andy build scheme id 01 from group 02 of pack1`; `Andy build house via scheme 02_bee_hot_air_balloon of pack1`; `Andy build schema pack1/02_bee_hot_air_balloon`. Existing `Andy build file <basename> of pack1` and `Andy build file pack1/<basename>` remain valid. Use a version-suffixed `.schem` filename to pin a selectable variant; `.schematic` and `.litematic` are not selectable. Literal filenames `id`/`name` need explicit filename form, slash form, or an extension. Descriptive text may precede one selector, optionally connected by `using` or `via`; quote reserved selector words in balanced double quotes (only escaped double quote and backslash are supported). Descriptive text is inert and does not verify the selected schematic. Ordinary `colour scheme` or `database schema` text remains chat. The sole selector must be complete and terminal; malformed, partial, duplicate, ambiguous, conflicting, injected, traversing, or extra-instruction selectors fail closed without model fallback. There is no guarantee for arbitrary paraphrases. Requests require a configured trusted sender (and must pass `only_chat_with` if configured); human requests do not accept coordinates. Rebuild and recreate Docker images after source changes.

Direct script forms also include `!buildSchematic("pack1:02_bee_hot_air_balloon")` for a pack filename stem and `!buildSchematic("schems/pack1/02_bee_hot_air_balloon.schem")` for a contained family selector relative to the schematics root; neither selects an unsuffixed physical file. Only compatible versioned `.schem` variants are selectable; `.schematic` and `.litematic` are not selectable. Script coordinates are optional only as a complete tuple: `!buildSchematic("pack1:2:1", 100, 64, -20)` or omit all three / pass three `null` values. Human typed requests do not accept coordinates.

Only configured trusted command senders can use direct commands or typed human requests; a non-empty `only_chat_with` list must also allow the sender. Recognized malformed or unresolved selectors fail safely and do not fall through to model inference; messages without typed selector intent remain ordinary chat. The bot needs Creative-mode permission to build; document provider-specific least-privilege permissions rather than recommending `/op`. From the repository root, run `npm run test:schematic` and `python3 schematics/tooling/audit_batch.py --pack <packN> --minecraft-version <source-version> --output-dir tmp/<new-audit-directory>`; the latter writes reports and logs only in the new output directory. Application source is baked into Docker images: rebuild and recreate the image after source changes. See `schematics/README.md` for exact grammar, security limits, supported formats, actual audit/test commands, and permission guidance.

If file-writing access is unavailable, say that the files have not been created and provide a repeatable generator with dependency installation and execution instructions for the exact target paths. In the final report list only actually generated and tested artifacts; include assumptions, version/DataVersion, dimensions/origin, palette/counts, file sizes, validation outcomes, uncertainties, and any omitted features. Do not claim live Mindcraft placement or exact image fidelity.
