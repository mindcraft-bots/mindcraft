# Historical introduction to schematic building

This prompt records the initial feature request and is preserved for historical intent; it predates the current implementation and its pack layout. Do not follow its old flat-file destination or treat its proposed internals as current instructions. For current user-facing build syntax, permissions and layout, use [`schematics/README.md`](../../README.md). For actual blueprint compile/validation commands, use [`schematics/tooling/BLUEPRINT_TOOLING.md`](../BLUEPRINT_TOOLING.md).

You are an expert Node.js and Mineflayer developer working on the `mindcraft-bots/mindcraft` repository (based on the `develop` branch). The feature introduced here now stores pack assets in `schematics/blueprints/packN/` and `schematics/schems/packN/`; generated source images are kept in `schematics/screenshots/packN/`.

Your task is to extend the bot's capabilities so it can build structures from pre-made schematic files (`.schem`, `.schematic`, `.litematic`) stored in a local `schematics/` directory using `mineflayer-schem` and `prismarine-schematic`. Additionally, the bot must automatically switch to Creative mode before building, fetch the required blocks from the Creative inventory (`bot.creative`), and restore its previous game mode (e.g., Survival) once the build finishes, fails, or is interrupted.

Please inspect the existing codebase first to match its exact module syntax (ESM `import`/`export`), error-handling conventions, logging helpers (`log()`), and command wrappers (`runAsAction`), then implement the following changes step-by-step:

### 1. Dependencies & Directory Setup
- Check `package.json` and install `mineflayer-schem` and `prismarine-schematic` if they are not already present.
- Create a `schematics/` folder in the project root (add a `.gitkeep` file inside so Git tracks the empty directory).

### 2. Plugin Initialization
- Locate where the Mineflayer `bot` instance is created and plugins like `pathfinder` or `collectBlock` are loaded (typically in `src/utils/mcdata.js` inside `initBot`, or `src/agent/agent.js`).
- Import `{ builder }` from `'mineflayer-schem'` and load it onto the bot instance (`bot.loadPlugin(builder)`).

### 3. Implement Creative Schematic Building Skill (`src/agent/library/skills.js`)
- Inspect `src/agent/library/skills.js` to follow the exact pattern used by other building/movement skills.
- Add and export an async function `buildSchematic(bot, filename, x = null, y = null, z = null)` with the following behavior:
  1. **Validation & Parsing:**
     - Safely resolve the file path inside `<project_root>/schematics/<filename>` (prevent path traversal).
     - Verify the file exists using `fs/promises`; if not, log an informative message via `log(bot, ...)` and return `false`.
     - Read the buffer and parse it using `await Schematic.read(buffer)` from `'prismarine-schematic'`.
  2. **Game Mode Management (Creative Switch):**
     - Save the bot's current game mode before starting: `const previousGameMode = bot.game?.gameMode || 'survival';`.
     - If `previousGameMode !== 'creative'`, send `bot.chat('/gamemode creative')` and wait briefly (e.g., 500–800ms or wait for the `game` event) so the server updates `bot.game.gameMode` and unlocks `bot.creative` inventory packets.
     - Log a warning if the bot fails to enter Creative mode (e.g., lacking `/op` permissions).
  3. **Creative Inventory Block Supply:**
     - Ensure `mineflayer-schem` can source blocks from Creative mode. Inspect how `mineflayer-schem`'s `Build` class requests missing items (typically via `bot.creative.setInventorySlot` when `bot.game.gameMode === 'creative'`, or by listening to item requests / pre-stocking needed block types from the schematic palette into empty hotbar/inventory slots using `bot.creative.setInventorySlot(slot, new Item(block.type, 64))`). Implement a reliable fallback or hook so the bot never stalls waiting for blocks in chests while in Creative mode.
  4. **Building & Interrupt Handling:**
     - Determine `startPos`: if `x`, `y`, and `z` are valid numbers, use `new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))`; otherwise, default to `bot.entity.position.offset(2, 0, 2).floored()`.
     - Instantiate `const build = new Build(schematic, bot.world, startPos)` from `'mineflayer-schem'`.
     - Add an interrupt watcher (`setInterval`) checking `bot.interrupt_code` every 500ms to call `bot.builder.stop()` if interrupted.
     - Execute `await bot.builder.build(build)` inside a `try / finally` block.
  5. **Cleanup & Mode Restoration (`finally` block):**
     - Clear the interrupt interval.
     - Always restore the original game mode if it was changed: if `previousGameMode !== 'creative'`, send `bot.chat(\`/gamemode \${previousGameMode}\`)` (defaulting to `/gamemode survival` if unknown) so the bot never gets stuck in Creative mode after completion, errors, or `!stop` interruptions.

### 4. Register LLM Commands (`src/agent/commands/actions.js` & `queries.js`)
- In `src/agent/commands/actions.js`, register a new action command in `actionsList`:
  - **Name:** `!buildSchematic`
  - **Description:** Follow the exact grammar in `schematics/README.md`. Use **schematic** as the primary noun. Full/short labels are `file id` / `id` (stable numeric per-group mapping, with `offset` retained) and `file name` / `file` (actual filename). `schema`, `schem`, `scheme`, and `schematic` optionally prefix either selector or replace `file` for a full pack-qualified filename target. Examples include `Andy build a balloon using schematic file id 01 from group 02 of pack1`, `Andy build file id 01 from group 02 of pack1`, `Andy build file name 02_bee_hot_air_balloon of pack1`, `Andy build house via scheme 02_bee_hot_air_balloon of pack1`, and `Andy build schema pack1/02_bee_hot_air_balloon`. Keep older `id`, `offset`, bare numeric, `file <name> of packN`, and `file packN/<name>` forms working. Descriptive text is inert; optional `using`/`via` connectors and balanced double-quoted reserved words are supported. Exact filename disambiguation is required; ordinary phrases such as `colour scheme` and `database schema` stay ordinary chat. Malformed, partial, duplicate, conflicting, injected, traversing, or extra-instruction selectors fail closed and never fall through to model inference. Numeric selectors map `pack:group:fileId` through schema-version-2 `schematics/schems/<packN>/index.json`; fileId is a stable mapping, not sorted position. Show pack, group, fileId, and fileName separately in `!listSchematics`. Explain configured trusted sender restrictions, direct command coordinate tuples, temporary Creative mode changes, and required Docker image rebuilds without suggesting arbitrary paraphrases or descriptions are validated.
  - **Params:** `filename` (string), plus optional coordinate-typed `x`, `y`, and `z` supplied all together or omitted together.
  - **Perform:** Wrap `skills.buildSchematic(agent.bot, filename, x, y, z)` with `runAsAction` so the agent's status updates properly and `SelfPrompter` does not interrupt the build.
- In `src/agent/commands/queries.js` (or the equivalent query file), register `!listSchematics` to list supported `.schem`, `.schematic`, and `.litematic` files inside `schematics/`; present pack, group, fileId, and exact fileName independently (retain compatibility aliases if existing callers depend on them). `.litematic` listing does not mean it can be built.

### 5. Verification
- Check for syntax or ESLint issues (`npm run lint` if configured).
- Run `npm run test:schematic` from the repository root. For pack-wide generated evidence, run `python3 schematics/tooling/audit_batch.py --pack <packN>`; it writes `schematics/tooling/validation/<packN>/batch_validation.json`, build logs, and the generated section of `schematics/schems/<packN>/batch_report.md`. Report actual exit codes and mismatches. Remind operators to configure `trusted_command_senders` (and check `only_chat_with` where set), then grant only the server-specific game-mode permissions needed for Creative and restoration; do not recommend `/op` as a routine requirement. Rebuild/recreate Docker images after changing source.
