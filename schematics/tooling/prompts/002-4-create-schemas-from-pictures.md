# Batch Task: Generate Mindcraft Sponge v2 Schematics for Folders 1–19

## Scope & Exclusions (Strict)
- **Root Input Directory:** `screenshots/packN`
- **Target Folders:** Process ONLY numeric subdirectories `1` through `19` in ascending numerical order (`1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19`).
- **Target Minecraft Version:** Minecraft Java Edition `1.21.4` (`DataVersion: 4189`).

---

## Execution Pipeline (Sequential per Folder)

1. **Discover & Sort Inputs:**
   - List the target subdirectories `1` through `19` sorted numerically (`1` first, `19` last).
   - Inside each folder, list all `.jpg` files sorted in strict ascending alphanumeric order (so sequential book pages are read in exact reading order).

2. **Initialize Progress Log:**
   - Create or update `schematics/batch_report.md` to track each folder (`01` to `19`), its input images, generated `schematics/blueprints/<prefixed_slug>.json`, generated `schematics/<prefixed_slug>.schem`, dimensions, and validation status. If a folder is already marked `[DONE]` with both files verified on disk, skip it.

3. **Process One Folder at a Time via `new_task`:**
   - For each folder `N` (`1` to `19`), spawn a dedicated sub-task in **`Voxel Architect`** mode (`new_task`).
   - Pass the exact folder number `N` (formatted as two digits, e.g., `01`), the ordered list of `.jpg` file paths inside that folder, and instruct `Voxel Architect` to:
     1. Read all listed `.jpg` files in alphanumeric order using `read_file`.
     2. Reconstruct the complete building accurately into `schematics/blueprints/<NN_building_slug>.json`.
     3. Delegate to the `Code` sub-agent to compile and validate `schematics/<NN_building_slug>.schem` (Sponge v2 gzip NBT, `DataVersion: 4189`, `nbtlib` verification, keeping the JSON blueprint intact).
     4. Return the verified paths, dimensions, and `!buildSchematic` command.

4. **Verify & Record After Each Folder:**
   - Confirm both `schematics/blueprints/<NN_building_slug>.json` and `schematics/<NN_building_slug>.schem` exist and are non-empty, update `schematics/batch_report.md`, and proceed to the next folder.

5. **Final Summary:**
   - Once all 19 folders (`1` through `19`) are complete, output a clean summary table listing every folder number, building title, `.schem` filename, dimensions (`X x Y x Z`), and ready-to-use `!buildSchematic("<filename>.schem")` command.
