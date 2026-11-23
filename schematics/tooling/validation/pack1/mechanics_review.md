# Pack1 mechanics review

The [report](mechanics_audit.json) covers the 30 pack1 source blueprints; the [generic mechanics documentation](../../PACK_MECHANICS.md) describes the model and its limitations.

## Findings and decisions

* **Actionable review warning:** 80 carousel carpets at y=3 have explicitly authored air directly below at y=2. The vanilla non-air-below survival predicate is false for that snapshot. Consider this when planning actual placement and neighbor updates, but do not substitute support blocks without a design decision.
* **Not an unsupported-carpet finding:** the other 36 carousel carpets are above 32 rail or powered-rail cells and four redstone torches. Their below cells are non-air, so the modeled carpet predicate is true; no full/sturdy top face is required. This does **not** certify the rails, torches, carts, update order or any other mechanics.
* **Design decision, not automatic repair:** 32 stairs differ from recalculation using the authored neighbors: four steamboat, 24 carousel, four clock. The carousel's [source](../../../blueprints/pack1/17_carousel.json) explicitly specifies inner roof corners. Those intentional authored states produce outer corners in this snapshot model. Retaining the intended visual state versus allowing vanilla recalculation is a choice, not evidence of a symmetry defect.
* **Unknown, not clean:** 139 stairs encounter an outside-volume neighbor necessary to the model. Real surrounding world blocks may change their outcomes. Each indeterminate location and the consulted path are in the report.

The diagnostic computes a hypothetical neighbor-normalized result from a static authored snapshot. Forced block states may remain different until a relevant neighbor update, and other changes or placement order can change the outcome. No live server placement, actual update timing, schematic pasting, or observed survival was tested. Schematic states and neighboring-world behavior are distinct from visual intent and symmetry.

## Review context

The independent review supplied with this task inspected Mojang 1.21.4 mappings and classes and reported 4 + 24 + 4 mismatches, 80 air-below carpets and 36 rail/torch-below carpets. The report and regression tests reproduce those totals and enumerate the coordinates; the coordinate fixtures are regression expectations, not independently supplied coordinate-level evidence.
