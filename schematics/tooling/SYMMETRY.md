# Blueprint symmetry diagnosis and explicit repair

Run from the repository root with the installed `minecraft-data` dependency. Inputs are explicit blueprint paths, not manifest IDs. The schema-version-2 [pack manifest](../schems/pack1/index.json) maps a group and separate ID to a particular schematic filename: group 2 includes three balloons, and group 3 contains both a barn and a silo. A group number does not imply a single build or any symmetry.

```sh
node schematics/tooling/symmetry.mjs --check --plane x=2.5 schematics/blueprints/pack1/01_wardrobe_nether_portal.json
node schematics/tooling/symmetry.mjs --plane x=4.5 schematics/blueprints/pack1/02_bee_hot_air_balloon.json
node schematics/tooling/symmetry.mjs --plane x=6.5 --bounds 0,13,7,12,0,0 schematics/blueprints/pack1/03_big_red_barn.json
node schematics/tooling/symmetry.mjs --plane x=z schematics/blueprints/pack1/11_turn.json
node --test test/schematic/symmetry.test.js
```

Repeat `--plane` and/or supply multiple blueprint paths; the same planes and optional bounds apply to each input. Supported vertical planes are `x=<integer or half-integer>`, `z=<integer or half-integer>`, `x=z`, and `x=-z`, with optional integer offsets on diagonal planes such as `x=z+2` or `x=-z+7`. Bounds are inclusive `xmin,xmax,ymin,ymax,zmin,zmax` in blueprint coordinates; without them the complete rectangular volume is considered. The front roof-profile example is a **local slice**, not a claim about the rest of the barn.

The JSON report gives each unordered pair once. `pairs.compared` counts in-region pairs with at least one non-air cell, while matched air-only pairs are counted separately; `coverage` is matched/compared, or null when no such pairs exist. Center-plane cells are counted and tested against their own reflected states separately, not included in pair coverage. The out-of-bounds cell count includes air; occupied entries give source and reflected coordinates, state, and whether the target lies outside the selected region or the blueprint. An exact result requires no mismatch and no reflected cell outside the region, including air. A high coverage score alone never proves symmetry. Each mismatch contains source/target coordinates, source, transformed expected and actual complete states, and a mutually exclusive occupancy, material, or state class.

The diagnostic validates dimensions, rows, symbols, the exact Minecraft release/DataVersion and complete legal palette states using the installed registry. It reflects cardinal facing and connection keys, horizontal axes, rotation, door hinges, stair handedness, chest halves and rail shapes; explicitly listed non-directional properties remain unchanged. Unknown properties, unsupported types/shapes/facings and incomplete or illegal states fail closed with exit 2 rather than guessing. This checks voxel block states only, not block entities, entities, placement support, physics, visual fidelity, or whether symmetry is intended. It cannot establish an authoritative side from a score. Diagnostic JSON output is written only to stdout: a normal report exits 0 even for mismatches; `--check` exits 1 for any non-exact result and 2 for an error. The diagnostic never writes files.

## Explicit repair: plan, review, apply to a new file

The separate [repair tool](symmetry_fix.mjs) is intentionally more restrictive than diagnosis. Create a configuration JSON with **exactly** these fields, replacing the example with independently reviewed choices for the actual source:

```json
{
  "plane": "x=19.5",
  "bounds": "0,39,0,0,0,0",
  "authoritative": "low",
  "threshold": 0.95,
  "allow": [[39, 0, 0]]
}
```

`low` or `high` means the sign of X minus the plane for X, Z minus the plane for Z, X−Z−offset for `x=z+offset`, or X+Z−offset for `x=-z+offset`. Every changed **destination** coordinate must be in `allow`, exactly once, with no extras; this includes air-to-solid and solid-to-air. The threshold must be explicitly supplied in [0.95, 1]. A high score is a guardrail, not evidence of symmetry or a reason to select a side. The entire selected region must reflect into itself, all center states must already reflect into themselves, and the non-air pair denominator must be nonzero. A failing threshold, out-of-bounds reflection, unsupported state, omitted target or ambiguous center is refused with an error; inspect the diagnostic report first.

For example, after preparing a source and configuration in a trusted directory, run:

```sh
set -C
node schematics/tooling/symmetry_fix.mjs --plan source.json config.json > approved-patch.json
# Inspect the entire report and exact before/after list against the reference;
# approve this exact file only after independent review.
node schematics/tooling/symmetry_fix.mjs --apply source.json approved-patch.json --output new-blueprint.json
```

The CLI requires an explicit `--plan` for non-writing planning; omitting the mode is a usage error, not an automatic dry run. Planning writes only stdout; the shell redirection creates the patch file (noclobber above prevents accidental replacement). Bounds must be a nonempty, exact six-integer inclusive region within the blueprint. Optional spot-check state assertions must be valid complete states matching their resolved voxels, both before planning and after derivation. Applying requires the exact full approved plan, verifies its source SHA-256 and recomputes every field and change, then requires a distinct, nonexistent output path. It validates the source counts and spot checks, recomputes expected counts and non-air count, updates unannotated changed spot checks, and checks the derivative's selected region. Annotated spot checks at changed positions are refused because their assertions or prose cannot safely be rewritten. It retains the other JSON fields but cannot establish that free-text descriptions remain true; review all metadata. Alongside the resulting blueprint, a no-clobber `.symmetry-audit.json` receipt contains the approved change record and source/output hashes; the receipt is also printed. Each file is staged and installed atomically via a same-directory hard link. Inputs and existing path components that are symlinks are refused; output and receipt cannot already exist. Use a trusted directory with no concurrent hostile path replacement: Node's path checks and the two separate file installations are not a transactional filesystem sandbox, and a crash between them can leave a receipt without the output. The tool never overwrites the source or generates a schematic; compile and independently validate any approved derivative separately.

Only a small explicit set of inert air, wool, concrete, terracotta, stone, dirt, glass, planks and logs is editable; it also refuses a change adjacent to any unrecognized or potentially dependent state. Door, gate, rail, stair, chest, fence, attachment, support-sensitive and other multiblock/connectivity edits are refused even when the diagnostic can reflect them correctly. This is a deliberate fail-closed limitation, not a promise of server-side physics correctness; surroundings outside the blueprint are unknown. Do not use it to force the bee, barn or Allay into symmetry.

The reproducible [all-30 audit](validation/pack1/symmetry_audit.md) and its [machine evidence](validation/pack1/symmetry_audit.json) record 40 reference hashes, all global plane counts, local door/gate inventories, and source-to-90-binary comparisons. The separate [read-only mechanics diagnostic](PACK1_MECHANICS.md) records stair and carpet concerns, which are distinct from symmetry and do not establish live placement behavior.

## Audit interpretation and reviewed change

The pre-repair voxel audit covered 30 blueprints, eight of which had at least one exact plane; for example, the enderman and pig balloons reflect around X=3.5, the silo around Z=4, the safety fence around X=4 and Z=1, the turn across X=Z, the carousel around X=8, and the strider bath around X=4. These are observed results, not a requirement that every build be symmetric. The barn has a one-sided pen, offset ventilator, and other intentional differences. Its front roof profile at the bounds above has seven matching non-air pairs; the whole attachment-inclusive envelope is asymmetric and extends beyond X=6.5's reflected extent.

The wardrobe was already exactly symmetric around X=2.5, so symmetry did not discover the defect: both open door leaves hinged toward the center despite the blueprint's documented outside-hinge interpretation of the reference. The only repair is four explicit legend property changes: at (2,0,1) and (2,1,1), south-facing door hinges change left to right; at (3,0,1) and (3,1,1), they change right to left. Counts and symbol positions remain unchanged, and the result is still exactly symmetric. No symmetry score was used to choose a side.

The bee initially had 217/221 matched pairs. The user explicitly authorized symmetry and selected preservation of the west side as a deterministic reconstruction assumption, not photographic proof; the four east cells are documented in the [validation note](../blueprints/pack1/02_bee_hot_air_balloon.validation.md). The original 221 occupied-pair cohort now matches completely. The diagnostic reports 220/220 current non-air pairs because one pair became air-only. Other asymmetries are not automatically defects.

Before the wardrobe edit, the supplied audit found all 30 original schematics voxel-identical to their blueprints, 29 fresh-byte equal, and the wardrobe byte difference attributable to NBT/palette encoding and gzip. Its original exists in HEAD and historical copies; no overwritten original was evidenced, so restoration is unnecessary. The original wardrobe schematic is still preserved and now differs from the repaired source at those four door cells. Historical validation reports describe the pre-repair state and should not be interpreted as current source/binary equality. Separately generated 1.21.4 and 26.1 variants reflect the repair; all 60 derivatives and the original hashes are documented in the [versioned compilation report](validation/pack1/versioned_compilation_report.md). This diagnostic itself creates no binary.
