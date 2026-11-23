# Blueprint symmetry diagnosis and explicit repair

## Read-only pack audit

With Node dependencies installed, select exactly one literal positive-numbered pack or all discovered packs. Pack1 is an example; pack2 is illustrative and need not exist:

```sh
node schematics/tooling/audit_pack_symmetry.mjs --pack pack1
node schematics/tooling/audit_pack_symmetry.mjs --all
node --test test/schematic/pack_symmetry.test.js test/schematic/pack1/symmetry_audit.test.js
```

For a future pack2 with its own inputs, use `node schematics/tooling/audit_pack_symmetry.mjs --pack pack2`; configure its expectations independently as described below.

The auditor writes deterministic JSON to stdout and never modifies inputs or reports. It exits nonzero for invalid input, an unmet explicit expectation, a mismatch, or an unsupported comparison. `--all` audits every discovered pack independently and does not silently fall back to another pack. Its aggregate contains sorted `packs`: complete or incomplete pack reports, or an incomplete entry with `pack` and `errors` when validation aborts that pack. Any incomplete entry makes the aggregate incomplete and its exit status nonzero; an empty discovery returns an incomplete aggregate with `errors: ["no packs found"]`. Invalid single-pack input still fails on stderr without a report. To compare a recorded report safely, use the test rather than redirecting stdout over an existing file. Report replacement is a separate, deliberate operation; this CLI has no output replacement option.

The schema-2 pack index owns logical schematic families and preserves group and file IDs. Each family requires one corresponding blueprint and at least one actual `.mc<VERSION>.schem` variant; extra or unowned sources and schematics fail. An optional `schematics/tooling/packN/symmetry.json` (not in the compiler's blueprint directory) can declare `{"schema":1,"targets":["1.21.4"],"archive":false,"builds":{"example":{"planes":[{"plane":"x=2.5","bounds":"0,5,0,3,0,2","intent":"exact"}]}}}`. When present, `targets` must be a nonempty array of distinct versions and is a required minimum per family; additional discovered versions are also audited. When present, `planes` must be an array of valid, distinct plane-and-bounds entries (an empty array adds no expectations); null is not an array. Without targets, only the discovered versions can be checked, so an entirely missing expected version cannot be inferred. `archive: true` enables the optional conventional `schematic-archive/packN_originals` inventory and comparisons; absent or false does not require an archive. Build keys are manifest family stems. Extra planes add to defaults; bounds are inclusive. Intent is `measure`, `exact`, or `asymmetric`, with only the latter two enforced. Configuration keys and ownership are validated.

Defaults measure whole-volume X and Z midplanes and, for square footprints, both diagonals; they are **not** requirements for symmetry. Reports include exact dimensions, bounded pair and center counts, all out-of-bounds cell counts (including air), occupied out-of-bounds totals, mismatch totals, and at most 12 example mismatches and occupied out-of-bounds examples, with explicit omitted counts. Door/gate pairs are only adjacent same-material pairs. Per-build explicit choices can describe a local slice rather than a global property. Photos are recursively inventoried as JPEG, PNG or WebP, case-insensitively, including root-level files; they are hashed, not decoded or visually reviewed. Other formats are ignored. A declared source image must be one of these photos in the same pack. The archive is separate from active variants.

The model, dependency lock, configuration, manifest, sources, recognized photos, metadata and binaries are hashed. Exact authenticated source and target release profiles supply DataVersions, and every voxel is checked against the source or reviewed history conversion. Unsupported releases, unsupported transformations and unreviewed conversions are marked unsupported rather than matched; full NBT semantics, entities, physics and visual intent are not checked. Symlink components and unsafe labels are rejected, but path checks are not a sandbox against concurrent filesystem changes: use a trusted, stable workspace. See the [pack 1 audit](validation/pack1/symmetry_audit.md) for its explicitly configured historical choices.

## Single-blueprint diagnosis

Run from the repository root with the installed `minecraft-data` dependency. Inputs are explicit blueprint paths, not manifest IDs. A schema-version-2 pack manifest maps a group and separate ID to a schematic family. A group number does not imply a single build or any symmetry. These pack1 examples select explicit planes, not requirements for other builds:

```sh
node schematics/tooling/symmetry.mjs --check --plane x=2.5 schematics/blueprints/pack1/01_wardrobe_nether_portal.json
node schematics/tooling/symmetry.mjs --plane x=4.5 schematics/blueprints/pack1/02_bee_hot_air_balloon.json
node schematics/tooling/symmetry.mjs --plane x=6.5 --bounds 0,13,7,12,0,0 schematics/blueprints/pack1/03_big_red_barn.json
node schematics/tooling/symmetry.mjs --plane x=z schematics/blueprints/pack1/11_turn.json
node --test test/schematic/symmetry.test.js
```

Repeat `--plane` and/or supply multiple blueprint paths; the same planes and optional bounds apply to each input. Supported vertical planes are `x=<integer or half-integer>`, `z=<integer or half-integer>`, `x=z`, and `x=-z`, with optional integer offsets on diagonal planes such as `x=z+2` or `x=-z+7`. Bounds are inclusive `xmin,xmax,ymin,ymax,zmin,zmax` in blueprint coordinates; without them the complete rectangular volume is considered. The bounded example is a **local slice**, not a global claim.

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

Only a small explicit set of inert air, wool, concrete, terracotta, stone, dirt, glass, planks and logs is editable; it also refuses a change adjacent to any unrecognized or potentially dependent state. Door, gate, rail, stair, chest, fence, attachment, support-sensitive and other multiblock/connectivity edits are refused even when the diagnostic can reflect them correctly. This is a deliberate fail-closed limitation, not a promise of server-side physics correctness; surroundings outside the blueprint are unknown. Do not use it to force an intended asymmetric design into symmetry.

Pack-specific findings, reproducibility and reviewed changes are preserved in the [pack1 audit](validation/pack1/symmetry_audit.md). The separate [read-only mechanics diagnostic](PACK_MECHANICS.md) addresses different concerns and does not establish live placement behavior.
