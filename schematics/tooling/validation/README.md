# Validation evidence and scope

Files directly in this directory (including `pre_relocation_batch_validation.json`, `reader_baseline.json`, and the reader repair logs) are historical outputs captured before schematic assets, blueprints, tooling, and validation output were organized by `packN`. Their original commands, recorded paths, timestamps, hashes, and results are preserved as evidence and are not rewritten to suggest they ran against the current layout.

Pack-specific checked-in reports and reviews live under `schematics/tooling/validation/packN/`. For pack1, [`pack1/README.md`](pack1/README.md) distinguishes deterministic audit reports from historical snapshots: [`pack1/batch_validation.json`](pack1/batch_validation.json) is historical, not a current batch run. Fresh batch audits write to a new directory under `tmp/`, not over checked-in evidence. Use [`../BLUEPRINT_TOOLING.md`](../BLUEPRINT_TOOLING.md) for current commands and limitations.
