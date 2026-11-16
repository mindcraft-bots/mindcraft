> **Historical execution record:** The results, exact shell transcripts, file hashes, and source-image ordering below were recorded before the pack/tooling relocation. Those recorded command strings and hash values are intentionally preserved as evidence, not claimed as commands or hashes from the current layout. Markdown links now target current files; use [`BLUEPRINT_TOOLING.md`](../../tooling/BLUEPRINT_TOOLING.md) for current commands. Blueprint image metadata now names the current screenshot paths, so historical byte hashes refer to the original metadata bytes.


> **Current rerun commands (not part of the historical execution record):** From the repository root, run the following commands. When invoking the tool by absolute path from another working directory, its input arguments still resolve from the repository root. `compile` writes to the canonical output; use it only when intentionally rebuilding.
>
> ```sh
> python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/pack1/02_bee_hot_air_balloon.json schematics/schems/pack1/02_bee_hot_air_balloon.schem
> python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/pack1/02_bee_hot_air_balloon.json schematics/schems/pack1/02_bee_hot_air_balloon.schem
> node schematics/tooling/validate_blueprint.mjs schematics/blueprints/pack1/02_bee_hot_air_balloon.json schematics/schems/pack1/02_bee_hot_air_balloon.schem 1.21.4
> ```

# Folder 02 validation — Bee hot-air balloon illustrated alternative

## Current production-reader result — 2026-11-15 repair

**PASS:** all 1,530 voxels, exact block states/counts and all 18 spot checks now match. The original 4 mismatched voxels were caused by the shared dependency encoding one-based integer values as literal offsets instead of registry value indices. The [narrow dependency patch](../../../patches/prismarine-schematic+1.3.0.patch) repairs the reader without altering this blueprint or schematic; both hashes match the [preserved baseline](../../tooling/validation/reader_baseline.json). See the [current batch diagnosis and placement limitations](../../schems/pack1/batch_report.md) and [fresh production-reader log](../../tooling/validation/build_logs/pack1/02_bee_hot_air_balloon.reader.log). This does not certify live placement or remove reconstruction/physics limitations. The initial narrative below is retained as historical evidence, including its now-resolved reader-failure statements.

## Original reconstruction validation — before reader repair

## Inputs and artifacts

- Blueprint: [`02_bee_hot_air_balloon.json`](02_bee_hot_air_balloon.json)
- Compiled schematic: [`02_bee_hot_air_balloon.schem`](../../schems/pack1/02_bee_hot_air_balloon.schem)
- Dimensions: **10 × 17 × 9**; volume **1,530**; non-air **440**; air **1,090**.
- Full palette: 25 distinct canonical states. Binary `BlockData`: 1,530 bytes (all values are one-byte palette indices here).
- SHA-256: `1fadaa1d0383e918b954dde7f9fc09a0528674c44e9a09cddf4ddeac5379a119` (761-byte gzip file).

## Commands and results

Executed from project root:

```sh
python3 schematics/compile_blueprint.py test-varints
python3 schematics/compile_blueprint.py validate schematics/blueprints/02_bee_hot_air_balloon.json schematics/02_bee_hot_air_balloon.schem
python3 schematics/compile_blueprint.py compile schematics/blueprints/02_bee_hot_air_balloon.json /tmp/02_bee_hot_air_balloon.repro.schem
sha256sum schematics/02_bee_hot_air_balloon.schem /tmp/02_bee_hot_air_balloon.repro.schem
node schematics/validate_blueprint.mjs schematics/blueprints/02_bee_hot_air_balloon.json schematics/02_bee_hot_air_balloon.schem
```

- Binary validator / gzip NBT reload using `nbtlib`: **PASS**. DataVersion 4189, Sponge v2, required typed tags, zero offset, empty entity lists, full palette, canonical VarInts, exact x-fastest/z-next/y-next voxel sequence, expected counts, all **18** spot checks, and all **1,530** voxels including air passed.
- VarInt boundary suite: **PASS**, including multibyte one-through-five-byte cases and rejection of overlong encoding.
- Deterministic gzip/recompile: **PASS**. Both hashes were identical to the SHA-256 above.
- Minecraft 1.21.4 registry: **PASS** for all 25 legend entries, with complete property sets and legal values.
- Production `readSchematic` comparison: **FAIL (known dependency defect)** after visiting all **1,530** positions. The only four voxel mismatches are the four pink candles, which installed `prismarine-schematic` 1.3.0 reports as `candles=2` instead of serialized/expected `candles=1`; counts differ by exactly those four states. The candle spot check at `(2,2,2)` shares this same mismatch. No blueprint or NBT state was altered to mask it.

## Notes and limits

- This is the illustrated alternative, not a step-by-step build. Materials, bee colors, stripe spacing, eyes/brows, wing loops, rear details, and shared basket/body geometry are inferred; see the unchanged blueprint assumptions.
- Cocoa’s blueprint orientation follows the assigned convention: north-exterior pods use `facing=south` (toward the adjacent support log). The registry confirms legal states, but does not encode attachment direction; no vanilla model/source asset was used to independently confirm it.
- Campfires have no item/block-entity payload. Candle support, wing geometry, burner offsets, and hidden details remain uncertain. **NO LIVE SERVER TEST**; no in-world support or placement behavior was tested.
