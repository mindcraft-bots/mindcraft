# Schematic builds

## Quick start

The current pack layout is [`screenshots/packN/`](screenshots/), [`blueprints/packN/`](blueprints/), and [`schems/packN/`](schems/), where `N` is a positive pack number. Generated binary assets belong in their pack folder; legacy schematic files directly in the root remain supported. Use [`!listSchematics`](../src/agent/commands/queries.js:231) to see pack, numeric screenshot-folder group, stable file ID/offset, and filename separately. The primary invocation is [`!buildSchematic("pack1:01:01")`](../src/agent/commands/actions.js:492), ordered `pack:group:file-ID`. An explicitly addressed, recognized human request such as `Andy build 01 from group 02 of pack1` is routed deterministically to [`!buildSchematic("pack1:02:01")`](../src/agent/commands/actions.js:492): screenshot folder `2` is group `02`, while the offset comes from the persistent index and is never inferred from sorting. Leading zeros are optional. Malformed, missing, and ambiguous selectors return an error instead of falling through to free-form building. Numeric dash selectors such as `pack1:02-01` are unsupported as IDs; use the colon-separated group/file-ID syntax or an exact pack-qualified filename/stem. Root-level filenames remain supported. Mappings live in [`schems/pack1/index.json`](schems/pack1/index.json) and must not be automatically renumbered. Send a direct command as `/msg Andy !buildSchematic("pack1:02:01")`; direct commands and natural-language build requests are limited to configured `trusted_command_senders`. If `only_chat_with` is non-empty, your player name must also be allowed.

For explicit placement, provide all three coordinates or omit all three. Examples: [`!buildSchematic("pack1:01:01", 100, 64, -20)`](../src/agent/commands/actions.js:492) places the schematic at the supplied world position; [`!buildSchematic("pack1:01:01", null, null, null)`](../src/agent/commands/actions.js:492) uses the bot's nearby placement. The parser requires coordinates together and accepts finite numbers or `null`. Send [`!stop`](../src/agent/commands/actions.js:54) to cancel a running build.

### Pack contents and tooling

- Reference images: [`schematics/screenshots/packN/<folder>/`](screenshots/)
- Source blueprints and per-build notes: [`schematics/blueprints/packN/`](blueprints/)
- Sponge/legacy schematic assets and optional explicit ID manifest: [`schematics/schems/packN/`](schems/)
- Reusable compilation, registry/production-reader validation, and audit tooling: [`schematics/tooling/`](tooling/)
- Generated audit data and logs: [`schematics/tooling/validation/packN/`](tooling/validation/)

The compiler and validator accept repository-relative paths from any current working directory. From the repository root, compile and validate a build using the commands in [`BLUEPRINT_TOOLING.md`](tooling/BLUEPRINT_TOOLING.md). The production-reader validator follows each blueprint's `minecraft_version` and `data_version`; supply a Minecraft-version argument only when it matches the blueprint metadata and the corresponding installed registry. The pack audit command is `python3 schematics/tooling/audit_batch.py --pack pack1`; it reads every blueprint in that pack and reports missing files or validation failures instead of assuming expected folders or fabricated success. Use `--minecraft-version <MC_VERSION>` or `--data-version <DATA_VERSION>` to require a pack-wide metadata value.

The numeric source-folder name is the group identifier: `schematics/screenshots/pack1/2/` is group `02`. Command offsets/file IDs come only from the pack's explicit `index.json`; they are separate from the group and never selected by sorting files at request time. For example, `pack1:02:01` resolves the stable `02-01` manifest mapping (`02_bee_hot_air_balloon.schem`), while `pack1:01:01` resolves the wardrobe. Do not recompute offsets by sorting after additions or renames. Numeric components are positive safe integers (1 through 9007199254740991), with optional leading zeros; pack names are `pack` followed by a positive decimal number.

### Integration review limits

The [focused integration review](tooling/validation/pack1/integration_review.md) records prior real-pack checks. The current schematic tests verify three-component lookup against the actual pack index and exercise wardrobe reading/build-plan creation with simulated server operations only. Build-plan preflight accepts 28/30 assets; the pagoda (04-01) and giant grandfather clock (18-02) still reject potted plants, which require multi-step placement. Binary and production-reader validation do not prove placeability. Live-server placement, permissions, image fidelity, and natural-language LLM interpretation are not tested.

## Game-mode permissions

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

## Command trust and known peers

The actual [`settings-andy.js`](../settings-andy.js:39) and [`settings-alice.js`](../settings-alice.js:39) list each other as known peers and authorize **Sunny26639 as the sole trusted command sender**, based on the observed human player in the incident evidence. Other players must be explicitly added to each bot's sender allowlist before they can issue direct commands or model-generated commands. An empty allowlist denies every player; omitting the setting retains legacy permissive behavior for non-peer senders. The separate chat-recipient filter can further restrict delivery.

Both actual settings still use offline bot authentication. A username allowlist is **not identity authentication**: if the server/proxy permits offline name spoofing, an attacker can impersonate Sunny26639 and obtain that player's command privileges. Server/proxy identity enforcement has not been verified, and authentication mode was not changed. Known-peer lists are also name-based: add other bot names explicitly, and do not treat an unknown username as proof of a human. Public chat and Minecraft whispers from known peers are ignored at the event boundary; Mindserver peer conversation remains possible, but peer-triggered generated commands are denied. Command fragments are redacted from outgoing shared chat and private bot responses. See the [independent incident review](tooling/validation/andy_alice_incident_review.md) for tested routing behavior, evidence, and limitations.

Both local configs deliberately retain enabled insecure coding. With it enabled, [`!newAction`](../src/agent/commands/actions.js:31) is documented and can execute generated code; this remains high risk, especially with offline name spoofing. When disabled, that command is omitted from generated command docs and selected examples, rejected by dispatch, and guarded in the action itself. Historical/custom prompt text is not erased and the model may still mention unavailable commands; mentioning one does not make it executable. [`!buildSchematic`](../src/agent/commands/actions.js:493) does not require insecure coding. Do not enable code generation merely to build a schematic.

## Rebuild the local Docker services after source changes

The [Compose configuration](../docker-compose.yml) bind-mounts each settings file and the schematic assets, but application source is baked into the images. A simple restart sees updated settings but **does not install the source fix**. Both stopped containers inspected on 2026-11-21 lack the schematic command and deterministic router. Rebuild and recreate both services when the operator is ready; the following commands are instructions only, not actions performed by this review. Run them from the repository root:

```sh
docker compose config --services
docker compose build --no-cache bot-andy bot-alice
docker compose run --rm --no-deps --entrypoint node bot-andy scripts/verify-schematic-patch.js
docker compose run --rm --no-deps --entrypoint node bot-alice scripts/verify-schematic-patch.js
docker compose up -d --force-recreate bot-andy bot-alice
docker compose ps bot-andy bot-alice
docker compose logs --tail=100 bot-andy bot-alice
```

The temporary verification containers above run only the patch verifier, not the bot entrypoint; they were not run during this review either. A clean build needs network access, native build dependencies, and patches compatible with the resolved package versions; the [Dockerfile](../Dockerfile:31) now copies the mandatory verifier before installation triggers it. Check fresh startup logs locally without publishing credentials or complete model/history logs. Public human chat is suppressed when the local Mindserver reports other agents, so prefer a Minecraft whisper for reliable delivery. From Sunny26639, send `/msg Andy Andy build 01 from group 02 of pack1` or the direct command `/msg Andy !buildSchematic("pack1:02:01")`; natural-language routing still requires an explicit bot name inside the whisper. The [persistent index](schems/pack1/index.json) maps that selector to the bee balloon. A message explicitly addressed to Alice is ignored by Andy before inference. Repeated independent requests are not deduplicated; do not resend while a build is active. Verify placement in-world only when ready; no automated test in this review contacts the server.

## Make a schematic from building pictures

Attach the ordered reference images to an image-capable agent and use this reusable workflow prompt. Before sending it, replace `<packN>` with the target pack (for example `pack1`), `<MC_VERSION>` with the requested Minecraft Java version, and `<DATA_VERSION>` with that version's exact Sponge/Minecraft DataVersion. Do not guess either version value. The folder number(s) are the numeric image subdirectories the user asked to process.

```text
You are creating Minecraft Sponge v2 schematics for Mindcraft from the attached ordered reference images. Treat `<packN>` as the requested pack name, `<MC_VERSION>` as the exact target Minecraft Java version, and `<DATA_VERSION>` as that version's exact DataVersion. Process only the numeric image folders requested by the user, in numeric order; within each folder inspect every provided `.jpg` in alphanumeric order. If a required value, image, or assignment is missing, ask rather than inventing it. For each folder, reconstruct an approximate but internally consistent block build. A picture cannot reveal unseen sides or exact dimensions: record uncertainty and assumptions; never claim exact recovery for occluded features.

## Compatibility and content constraints
- Target Minecraft Java `<MC_VERSION>` / DataVersion `<DATA_VERSION>` exactly. Store both values in every blueprint and use that version's vanilla block registry. Never silently substitute another version.
- Produce one persistent JSON voxel blueprint and one real gzip-compressed NBT Sponge v2 `.schem` per build. Do not create Sponge v3, `.litematic`, fake text `.schem`, or unsupported custom/modded palette entries.
- Exclude fluids (water/lava), entities, inventories, and block-entity payloads. Avoid complicated orientation, redstone, or mechanism states unless the documented format and build path safely support them. Clearly describe visual/function compromises.
- Keep dimensions reasonable: each axis at most 256 and volume at most 1,000,000 blocks. State X×Y×Z, scale, origin corner, local directions, ground-level Y, material palette/counts, and all inferred details. Encode air for empty cells and a genuinely walkable interior where the reference calls for one.

## Repository layout and naming
- Read source images from `schematics/screenshots/<packN>/<numeric-folder>/`.
- Save each complete, permanent source blueprint to `schematics/blueprints/<packN>/<NN_building_slug>.json`.
- Save the compiled binary to `schematics/schems/<packN>/<NN_building_slug>.schem`; save its per-build validation record beside the blueprint as `<NN_building_slug>.validation.md`.
- Track progress and final results in `schematics/schems/<packN>/batch_report.md`; preserve earlier report narratives and generated audit sections rather than replacing unrelated history.
- Use primary syntax `!buildSchematic("<packN>:<group>:<file-ID>")`; translate “id 01 from group 02 of pack1” to `pack1:02:01`, never reverse the components. The numeric group is the screenshot folder; the file ID is its persistent manifest offset. Numeric dash selectors such as `pack1:02-01` are unsupported as IDs. `!buildSchematic("<packN>:<NN_building_slug>")` remains valid for pack-qualified literal filenames/stems. Run `!listSchematics` to confirm separate group and file ID.
- Maintain `schematics/schems/<packN>/index.json` explicitly; persistent `GG-OO` keys map numeric screenshot group GG plus per-group file-ID/offset OO. Never renumber existing mappings or derive offsets from filename sorting. Keep group/file-ID-to-filename pairs unique and targets real. Numeric components are positive safe integers (1 through 9007199254740991), with optional leading zeros; pack names are `pack` plus a positive decimal number. Directly indexed filename forms may use other names.

## Sequential workflow and actual validation commands
1. Inventory the requested numeric folder(s), sort folder numbers numerically and `.jpg` paths alphanumerically, then inspect every image. Record filenames and uncertainty before blueprinting. Do not skip work solely because a note says `[DONE]`; verify the actual JSON and `.schem` are present and nonempty.
2. Build a complete explicit blueprint with dimensions, origin, `minecraft_version: "<MC_VERSION>"`, `data_version: <DATA_VERSION>`, legend, `layers[y][z][x]`, expected state counts, and spot checks. Keep it as the source of truth.
3. From the repository root, compile and independently validate the generated file with the real tooling:

   `python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/<packN>/<NN_building_slug>.json schematics/schems/<packN>/<NN_building_slug>.schem`

   `python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/<packN>/<NN_building_slug>.json schematics/schems/<packN>/<NN_building_slug>.schem`

   `python3 schematics/tooling/compile_blueprint.py test-varints`

   `node schematics/tooling/validate_blueprint.mjs schematics/blueprints/<packN>/<NN_building_slug>.json schematics/schems/<packN>/<NN_building_slug>.schem <MC_VERSION>`

   The compiler verifies gzip/NBT Sponge v2 structure, DataVersion, dimensions, palette, canonical VarInt order (X fastest, then Z, then Y), every voxel, counts, and spot checks. The Node validator uses the production `readSchematic` parser and installed `minecraft-data` registry for the exact version; report any nonzero status or parser mismatch truthfully. Do not alter geometry or expected states merely to make an audit pass. Compilation writes the canonical `.schem`, so only run it for the intended output; audits regenerate to temporary files.
4. Record the exact commands, exit statuses, dimensions, voxel/block counts, registry/reader results, output byte size and SHA-256 in the per-build note. Distinguish binary validation from production-reader comparison; neither proves visual fidelity or live server placement. Mark unsupported/inferred details and do not claim a live test.
5. After each folder, verify the JSON, `.schem`, and note are nonempty; update the pack report without overwriting historical sections. Add a deliberate ID mapping when appropriate and verify the corresponding command syntax. Summarize only builds actually inspected and tested.

If you cannot write files directly, do not claim the artifacts exist. Supply a complete repeatable generator plus exact dependency installation and run instructions that create the JSON and actual binary schematic in the specified paths. Report assumptions, version/DataVersion, dimensions/origin, palette/counts, exact paths and sizes, checks and limitations. Never imply that a live Mindcraft server build was tested.
```
