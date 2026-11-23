# Pack1 mechanics snapshot diagnostic

This is separate from the symmetry audit. The [machine-readable report](validation/pack1/mechanics_audit.json) covers all 30 source blueprints and records their SHA-256 hashes, model/version, implementation and dependency hashes, every modeled carpet, every stair mismatch and every indeterminate stair. Coordinates are local `[x,y,z]`; evidence gives the exact consulted in-volume state or an explicit outside-volume unknown. A missing finding is **not** a general stability or symmetry certification.

From the repository root, with the locked dependencies installed:

```sh
node schematics/tooling/audit_pack1_mechanics.mjs > /tmp/pack1-mechanics.json
cmp /tmp/pack1-mechanics.json schematics/tooling/validation/pack1/mechanics_audit.json
node --test test/schematic/pack1_mechanics.test.js
```

The program reads only and writes JSON to stdout. To refresh the persisted report after reviewing source changes, redirect stdout explicitly to the report path; it does not repair, compile or write blueprints or schematics. Input must declare both Java 1.21.4 and data version 4189, use a supported explicit layer matrix and have complete dimensions, rows and legend. Older pack1 matrices without a schema label are accepted only after the same structural checks. Complete block states are checked against the installed 1.21.4 registry. Unknown/modded/malformed states are not assumed to be air or non-stairs. Only vanilla registered stair blocks and the 16 wool carpets are modeled; no support rules for rails, torches, other carpets or other blocks are inferred. A partial or outside-volume neighbor yields unknown rather than a warning, even if some possible worlds would agree.

## Findings and decisions

* **Actionable review warning:** 80 carousel carpets at y=3 have explicitly authored air directly below at y=2. The vanilla non-air-below survival predicate is false for that snapshot. Consider this when planning actual placement and neighbor updates, but do not substitute support blocks without a design decision.
* **Not an unsupported-carpet finding:** the other 36 carousel carpets are above 32 rail or powered-rail cells and four redstone torches. Their below cells are non-air, so the modeled carpet predicate is true; no full/sturdy top face is required. This does **not** certify the rails, torches, carts, update order or any other mechanics.
* **Design decision, not automatic repair:** 32 stairs differ from recalculation using the authored neighbors: four steamboat, 24 carousel, four clock. The carousel's [source](../blueprints/pack1/17_carousel.json) explicitly specifies inner roof corners. Those intentional authored states produce outer corners in this snapshot model. Retaining the intended visual state versus allowing vanilla recalculation is a choice, not evidence of a symmetry defect.
* **Unknown, not clean:** 139 stairs encounter an outside-volume neighbor necessary to the model. Real surrounding world blocks may change their outcomes. Each indeterminate location and the consulted path are in the report.

The diagnostic computes a hypothetical neighbor-normalized result from a static authored snapshot. Forced block states may remain different until a relevant neighbor update, and other changes or placement order can change the outcome. No live server placement, actual update timing, schematic pasting, or observed survival was tested. Schematic states and neighboring-world behavior are distinct from visual intent and symmetry.

## Vanilla evidence and verification

The independent review supplied with this task inspected Mojang 1.21.4 mappings and classes and reported 4 + 24 + 4 mismatches, 80 air-below carpets and 36 rail/torch-below carpets. The report and regression tests reproduce those totals and enumerate the coordinates; the coordinate fixtures are regression expectations, not independently supplied coordinate-level evidence.

The implementation was also checked against the actual Mojang 1.21.4 server bytecode and official mappings, not a live placement test:

* Mojang's [release metadata](https://piston-meta.mojang.com/v1/packages/c88775961e316f2be09859c54e13017660ee7770/1.21.4.json) identifies the [server bundle](https://piston-data.mojang.com/v1/objects/4707d00eb834b446575d89a61a11b5d548d8c001/server.jar) (SHA-1 `4707d00eb834b446575d89a61a11b5d548d8c001`) and [official server mappings](https://piston-data.mojang.com/v1/objects/0b1e60cc509cfb0172573ae56b436c29febbc187/server.txt) (SHA-1 `0b1e60cc509cfb0172573ae56b436c29febbc187`). The nested 1.21.4 server jar has SHA-256 `de9538d2497c8f4174805f3fcedb8ade3060446aa203f351b820ea5bd04adbf4`.
* Mappings identify `StairBlock` as `drm`, `getStairsShape` as `e` (mapped source lines 143–166), `canTakeShape` as `c` (170–171), and `isStairs` as `o` (175). In the bytecode of `drm.e(Ldwy;Ldfo;Lji;)Ldyg;`, offsets 11–114 read the forward neighbor and return outer-left/right when same-half, perpendicular and unblocked; offsets 115–218 read the opposite neighbor and return inner-left/right under corresponding checks; offset 219 returns straight. `drm.c` checks a side stair with the current facing and half, regardless of stair material. The front-side check uses the opposite of the neighbor facing; the back-side check uses the neighbor facing. Mappings identify `jn.g` as opposite, `jn.i` as counterclockwise and `dyg.a` through `dyg.e` as straight, inner-left, inner-right, outer-left and outer-right respectively.
* Mappings identify `CarpetBlock` as `dkf`, `canSurvive` as `a` (line 44), `BlockPos.below` as `ji.e`, and `LevelReader.isEmptyBlock` as `dgm.u`. The method `dkf.a(Ldwy;Ldgm;Lji;)Z` calls `isEmptyBlock` on `below()` and returns its negation. `WoolCarpetBlock` extends `CarpetBlock`. Its update method also consults survival; neither observation proves a particular paste or placement sequence.

For independent inspection, extract `META-INF/versions/1.21.4/server-1.21.4.jar` from the server bundle, verify these hashes, consult the mappings, and disassemble `drm` and `dkf` with a Java class-file disassembler (for example, `javap -c -p`). The focused tests exercise front priority, both handednesses, half/axis filtering, side blockers, cross-material stairs, unknowns, all reviewed locations and read-only reproducibility.
