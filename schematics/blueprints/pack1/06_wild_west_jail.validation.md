> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/06_wild_west_jail.json schematics/schems/pack1/06_wild_west_jail.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/06_wild_west_jail.json schematics/schems/pack1/06_wild_west_jail.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/06_wild_west_jail.json schematics/schems/pack1/06_wild_west_jail.schem 1.21.4
> ```

# Folder 06 — Wild West Jail validation

## Scope and source

Recompiled only the permanent blueprint [`06_wild_west_jail.json`](./06_wild_west_jail.json) to [`06_wild_west_jail.schem`](../../schems/pack1/06_wild_west_jail.schem), using the documented tooling in [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md). Before this revalidation, the parent canonicalized the property ordering in 11 fence/bar state strings and corresponding `expected_counts` keys alphabetically. This was a semantic-only string canonicalization: no geometry, layer character, property value, or count changed. No other source, tool, dependency, geometry, or batch report was changed. The temporary determinism output was removed after comparison.

## Commands executed

From the project root:

```sh
python3 schematics/compile_blueprint.py compile \
  schematics/blueprints/06_wild_west_jail.json schematics/06_wild_west_jail.schem
python3 schematics/compile_blueprint.py validate \
  schematics/blueprints/06_wild_west_jail.json schematics/06_wild_west_jail.schem
python3 schematics/compile_blueprint.py test-varints
```

The same compile command was run to a temporary file inside `schematics/`, then compared with `sha256sum` and `cmp -s`; `cmp -s` returned 0 and the temporary file was deleted.

Production reader and registry validation:

```sh
node schematics/validate_blueprint.mjs \
  schematics/blueprints/06_wild_west_jail.json schematics/06_wild_west_jail.schem
```

## Compilation and independent binary validation

- Format: gzip-compressed Sponge v2 NBT, DataVersion 4189; compiler's `nbtlib` reload and validation succeeded.
- Dimensions: **13 × 9 × 9**, volume **1,053**.
- Palette: **42** states; spot checks: **24**.
- Counts: **446 non-air**, **607 air**.
- `BlockData`: **1,053 bytes**; compiled file: **1,019 bytes**.
- SHA-256 of target: `fd669b40f52d9346f7b91a0263e7335bb2b24eaef14ff932c80c2ac4dcb3b965`.
- Second compile SHA-256: identical (`fd669b40f52d9346f7b91a0263e7335bb2b24eaef14ff932c80c2ac4dcb3b965`); `cmp -s` confirmed byte-identical output.
- Exit statuses: compile **0**; independent binary `validate` **0**; `test-varints` **0**; second compile **0**; deterministic `cmp -s` **0**; production-reader validation **0**.
- Independent binary validation passed for the full byte stream, dimensions, palette, typed NBT, all voxel data, counts, and all 24 spots. `test-varints` passed 1–5-byte boundary checks and rejected overlong encodings.

## Production reader and registry result

Used production [`readSchematic()`](../../../src/utils/schematic/reader.js) (`prismarine-schematic`) and the installed `minecraft-data` 1.21.4 registry. All **42** legend entries were validated against the registry. Dimensions were **13 × 9 × 9**; all **1,053/1,053** voxels, including air, were compared. Parser-derived counts match all expected counts; all **24/24** spot checks passed.

**Current full voxel and state comparison: PASS.** `parserMismatches: 0`; `countDiffs: []` (**0 current count mismatches**); `firstMismatches: []`; `spotCheckFailures: []`; `parserDerivedCountsMatch: true`. Parser-derived air is **607**. The production-reader command exited **0**.

### Revalidation history: initial exact-string mismatch and resolution

The earlier production-reader run exited **2**, despite `parserMismatches: 0`, `firstMismatches: []`, and `spotCheckFailures: []`. It reported **22 `countDiffs` (11 expected/actual key pairs)** because the validator compares exact state-string count keys: the 11 blueprint `expected_counts` keys had `west=...` before `waterlogged=false`, while the reader's canonical strings order `waterlogged=false` before `west=...`. Each pair represented the same semantic state and count, not a voxel or geometry difference.

The parent resolved that exact-string mismatch by alphabetically canonicalizing the properties in those 11 blueprint fence/bar state strings and their corresponding `expected_counts` keys. The property values, per-state counts, and voxel geometry remained unchanged; the stated semantic identity across all **1,053 voxels** was preserved. Recompilation and the current production-reader run now agree on exact state strings and counts, with **0 mismatches**.

The affected pre-canonicalization state variants (each had an expected-key count and a property-reordered reader-key count) were:

| Block state properties as specified by blueprint | Count |
| --- | ---: |
| `birch_fence[east=false,north=true,south=true,west=false,waterlogged=false]` | 2 |
| `birch_fence[east=true,north=false,south=false,west=true,waterlogged=false]` | 4 |
| `iron_bars[east=false,north=false,south=true,west=false,waterlogged=false]` | 2 |
| `iron_bars[east=false,north=true,south=false,west=false,waterlogged=false]` | 2 |
| `iron_bars[east=false,north=true,south=true,west=false,waterlogged=false]` | 3 |
| `iron_bars[east=true,north=false,south=false,west=true,waterlogged=false]` | 13 |
| `spruce_fence[east=false,north=false,south=false,west=false,waterlogged=false]` | 8 |
| `spruce_fence[east=false,north=false,south=false,west=true,waterlogged=false]` | 1 |
| `spruce_fence[east=false,north=true,south=false,west=true,waterlogged=false]` | 1 |
| `spruce_fence[east=true,north=false,south=false,west=false,waterlogged=false]` | 1 |
| `spruce_fence[east=true,north=true,south=false,west=false,waterlogged=false]` | 1 |

Thus the historical 22 entries were exactly two string keys for each of the 11 variants above (blueprint key versus property-reordered reader key), not 22 distinct semantic count discrepancies. Property-string canonicalization corrected the representational mismatch; no workaround or state substitution was applied.

## Origin, audits, and limitations

- Origin is `(0,0,0)`, the northwest bottom corner of the main foundation; x east, y up, z south. The main front faces south, the cell projects east, and schematic offset is zero.
- Blueprint audit measurements retained: main foundation 9 × 9; front acacia columns 8 blocks high; rear columns 7 blocks high; clear cell interior 3 × 3. The overall 13 × 9 × 9 envelope, porch setback/depth, wall/roof levels, cell height/exterior and slab half-heights are inferred as documented in the source blueprint.
- Material/state ambiguities remain as documented in the blueprint: smooth acacia interpreted as stripped acacia logs; spruce porch supports, sign/awning details, furniture and obscured vent placement/orientation inferred from oblique compressed illustrations; door hinge is not visually confirmed. This is a best-effort reconstruction, not a claim of block-exact reproduction.
- No entities, fluids, inventories, signs, custom block-entity payloads, or escape tunnel were included. No live server test was run; registry and file-reader validation are offline only.
