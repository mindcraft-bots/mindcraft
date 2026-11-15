# Schematic builds

## Quick start

Put the schematic file directly in the repository-root [`schematics/` directory](.). Use in-game chat to list files with [`!listSchematics`](../src/agent/commands/queries.js:231), then build one with [`!buildSchematic("house.schem")`](../src/agent/commands/actions.js:492). To target a specific bot by its exact Minecraft profile name, send it as a whisper/private message, for example `/msg Andy !buildSchematic("house.schem")`. Mindcraft receives Minecraft whispers as player messages, so this is the verified way to address `Andy`; the command inside is parsed and executed directly. If the bot's `only_chat_with` setting contains a non-empty list, your player name must be listed or your message is ignored. Natural-language chat such as “Andy, build the house” is instead a model-interpreted request, not a routing or command guarantee.

For explicit placement, provide all three coordinates or omit all three. Examples: [`!buildSchematic("house.schem", 100, 64, -20)`](../src/agent/commands/actions.js:492) places the schematic at the supplied world position; [`!buildSchematic("house.schem", null, null, null)`](../src/agent/commands/actions.js:492) uses the bot's nearby placement. The parser requires coordinates together and accepts finite numbers or `null`. Send [`!stop`](../src/agent/commands/actions.js:54) to cancel a running build.

### Game-mode permissions

A schematic build needs the bot to enter Creative mode, then attempts to restore its previous mode. On permission-managed servers, prefer granting only the relevant game-mode permissions rather than using `/op`. The command that handles `/gamemode` determines which permission nodes apply: vanilla/Paper/Bukkit and EssentialsX can use different providers, and EssentialsX may override the command. Grant the family that applies on your server; do not assume both are required. Per-mode vanilla nodes can also vary by platform, so test an actual Creative-to-Survival switch.

From the server console, replace `<BotName>` with the bot's exact Minecraft name and grant the vanilla/Paper/Bukkit nodes that your server supports:

```text
lp user <BotName> permission set minecraft.command.gamemode true
lp user <BotName> permission set minecraft.command.gamemode.creative true
lp user <BotName> permission set minecraft.command.gamemode.survival true
```

If EssentialsX handles `/gamemode`, use its applicable nodes instead:

```text
lp user <BotName> permission set essentials.gamemode true
lp user <BotName> permission set essentials.gamemode.creative true
lp user <BotName> permission set essentials.gamemode.survival true
```

These are console commands without a leading slash. In-game `/lp` commands require administrator permission. To inspect the bot's explicit LuckPerms user permissions, run:

```text
lp user <BotName> permission info
```

That output may not show every effective permission inherited from groups or context; if needed, verify the provider configuration or use LuckPerms verbose while testing. The bot sends unqualified `/gamemode creative` and `/gamemode <previous mode>` commands, so confirm that the selected provider permits both transitions. If the bot starts in Adventure or Spectator and must return to that mode, grant the corresponding mode permission as required by your provider; otherwise keep its initial mode Survival or Creative.

Operator status is a broad fallback, not a requirement or preferred solution on permission-managed servers. Permissions may still be constrained by server game-mode settings or other plugins. If a mode change is denied, the build should fail safely; Creative inventory updates and their cleanup/restoration are best effort if the server rejects them. Review the placement and final result in-world.

## File formats and validation

Supported build inputs are Sponge v2 [`.schem`](../src/utils/schematic/reader.js:91) and legacy MCEdit [`.schematic`](../src/utils/schematic/reader.js:128). Sponge v3 `.schem` files are not supported; convert them to Sponge v2 first. `.litematic` files may appear in the list but are not decoded or buildable; convert them to Sponge v2 `.schem` or legacy `.schematic` first. File extensions are not a format conversion: the content must be a real file in the corresponding format.

The reader pre-validates source palette blocks and properties against the connected server's Minecraft registry. Unknown block names/namespaces, unsupported properties or states, and unmapped legacy IDs fail before the bot changes mode or inventory. Builds are checked against the requested block states afterward, but `mineflayer-schem` has limited orientation metadata; some directional blocks may be placed in a different orientation and will be reported as mismatches. A successful local parse is not certification on a live server: confirm the result in the target world. Installation also relies on the required `mineflayer-schem` cancellation-safety patch; postinstall verifies the patch's expected capabilities and checkpoints. If that verification fails, resolve the patch mismatch before running the bot.

## Make a schematic from a building picture

Attach the picture to a separate image-capable AI agent and send it the following prompt. Image-to-voxel work is an approximation: a single view does not reveal hidden sides or exact dimensions, so the agent must state assumptions rather than claim an exact architectural reconstruction. The target file must be saved at the repository-root [`schematics/` directory](.).

```text
You are creating a Minecraft building schematic from the attached building picture for the Mindcraft project. Inspect the attached image, then produce a usable, approximate Minecraft build—not a claim of exact architectural reconstruction. A single picture cannot reveal unseen sides, depth, or exact measurements: explicitly list reasonable assumptions for every unseen or ambiguous feature before generating anything.

Target environment and compatibility:
- Determine the target Minecraft Java version from the user's stated version or the project's configured server version. State the version you targeted. If you cannot determine it, ask the user rather than silently inventing a version.
- Output exactly one Sponge v2 `.schem` file. Do not output Sponge v3, `.litematic`, or a renamed JSON/text file.
- Use only ordinary, version-compatible, namespaced vanilla blocks supported by that target version. Do not use custom/modded blocks, unknown palette entries, block entities, entities, fluids (water/lava), or claims that these are supported.
- Prefer conservative blocks with simple placement/orientation behavior. Avoid complicated directional/redstone/mechanism blocks and special state combinations. State any visual compromises.

Plan the voxel build:
- Infer and report width (X), height (Y), and depth/length (Z), in blocks, plus the chosen approximate scale and how image proportions were mapped to those dimensions. Keep dimensions reasonable for a hand-built structure and within Mindcraft's limits (each axis at most 256; total volume at most 1,000,000 blocks).
- Identify the ground-level origin corner, its local X/Z direction, and the intended ground-level world Y. Clearly describe which corner/direction the origin represents so I can place it consistently. Keep the floor at that origin level.
- Describe the palette/material choices and approximate block counts. Build a plausible structure with a genuinely hollow, walkable interior; usable door openings/doors and windows; and coherent floor, walls, roof, and openings. Do not fill the interior solid. Choose simple standard doors/windows only if their states can be represented safely.
- Keep the geometry internally consistent with the declared dimensions and origin. Air is valid for empty/interior cells; ensure it is encoded correctly rather than as an invalid palette index.

Create and validate a real file:
- If you have file-writing/tool access, write the binary gzip-compressed NBT Sponge v2 schematic itself as `picture_build.schem` in the repository-root `schematics/` directory. Do not merely print the bytes or save a JSON/text description with a `.schem` extension.
- If you cannot directly write files, do not claim that you created or attached a schematic. Instead provide a complete runnable Python or JavaScript generator script plus the generated-output instructions. The script must write the actual binary gzip NBT Sponge v2 file to the exact requested folder, list dependencies and installation commands, and be repeatable to regenerate the same output. Prefer standard, maintained NBT tooling; do not require proprietary software.
- Ensure the Sponge v2 NBT fields and types are correct for the selected version, including dimensions, palette, and block data. Palette keys must be valid namespaced block IDs; palette indices must be valid. Encode BlockData as the correct sequence of unsigned VarInts in Sponge order (X fastest, then Z, then Y), with one index per voxel and valid air indices. Validate the palette/index bounds, block-data voxel count, dimensions, gzip/NBT readability, and the file's actual binary format. Do not use an incorrect fixed-width encoding or substitute JSON for NBT.
- Confirm that every referenced block and state belongs to the target version's vanilla registry; use no unknown/custom blocks and avoid unsupported orientation properties. Do not add entities or block-entity NBT, and do not claim that any are included.

Return a concise report containing: (1) stated image assumptions and approximation caveat, (2) target Minecraft version, dimensions, scale, origin corner/directions and ground-level Y, (3) palette/material counts, (4) exact output path and file size, (5) validation steps/results, and (6) any visual/state limitations. If you supplied a generator instead of writing the file, include exact dependency installation and run commands, and say clearly that the user must run it to generate the file. Finally state that the file belongs in this project's root `schematics/` folder and can be checked with `!listSchematics` and built using `!buildSchematic("picture_build.schem")` (or explicit X, Y, Z coordinates); do not imply that any live Mindcraft server build was tested.
```
