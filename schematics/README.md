# Schematic builds

## Quick start

The pack layout is [`screenshots/packN/`](screenshots/), [`blueprints/packN/`](blueprints/), and [`schems/packN/`](schems/), where `N` is a positive pack number. Generated binary assets belong in their pack folder; legacy schematic files directly in the schematics root remain supported. Use [`!listSchematics`](../src/agent/commands/queries.js:231) to see pack, numeric screenshot-folder **group**, stable **file ID**, and exact **file name** in separate fields. The primary direct selector is [`!buildSchematic("pack1:02:01")`](../src/agent/commands/actions.js:492), ordered `pack:group:fileId`; its fileId-to-fileName mapping is stored in [`schems/pack1/index.json`](schems/pack1/index.json), not inferred from filename sorting. A file ID is a stable per-group index mapping, not the file's sorted position. The term **schematic** is primary in this guide; the parser also accepts the requested aliases below.

### Supported request forms

| Form | Example | Meaning and limits |
| --- | --- | --- |
| Numeric selector — full label | `Andy build file id 01 from group 02 of pack1` | `file id` is the stable numeric ID within screenshot-folder group `02`; it maps through the explicit index and is never a sorted filename position. Leading zeroes normalize numerically. |
| Numeric selector — short label | `Andy build id 01 from group 02 of pack1` | `id` is the short label for `file id`. `offset` remains a numeric alias. Both keep the historical typed grammar. |
| Numeric selector — prefix aliases | `Andy build schematic file id 01 from group 02 of pack1`; `Andy build schem id 01 from group 02 of pack1`; `Andy build schema file id 01 from group 02 of pack1`; `Andy build scheme id 01 from group 02 of pack1` | Any of `schematic`, `schema`, `schem`, or `scheme` may optionally prefix the numeric selector, with the full or short ID label. |
| Numeric bare shorthand | `Andy build 1 from group 2 of pack1` | Retained short numeric form. `offset 1 from group 2 of pack1` is also retained. |
| Filename selector — full label | `Andy build file name 02_bee_hot_air_balloon of pack1` | `file name` means an actual filename. Supported extensions are `.schem`, `.schematic`, and `.litematic`; include an extension to disambiguate same-stem files. `.litematic` can be listed/resolved but is not buildable. |
| Filename selector — short label | `Andy build file 02_bee_hot_air_balloon of pack1` | `file` is the short label for `file name`; `file pack1/02_bee_hot_air_balloon` is the retained pack/name slash form. |
| Filename selector — aliases instead of `file` | `Andy build house via scheme 02_bee_hot_air_balloon of pack1`; `Andy build schema pack1/02_bee_hot_air_balloon`; also `schematic <name> of pack1` and `schem <name> of pack1` | Each of `schematic`, `schema`, `schem`, and `scheme` can replace `file` in a full pack-qualified filename selector, using either `name of packN` or `packN/name`. This is a typed selector, not a general synonym in arbitrary prose. |
| Filename selector — alias prefixes | `Andy build schematic file name 02_bee_hot_air_balloon of pack1`; `Andy build schema file 02_bee_hot_air_balloon of pack1`; `Andy build schem file name 02_bee_hot_air_balloon of pack1`; `Andy build scheme file 02_bee_hot_air_balloon of pack1` | All four aliases can also prefix the full `file name` or short `file` selector. |
| Descriptive typed request | `Andy build a balloon using schematic file id 01 from group 02 of pack1`; `Andy build a "file group pack1" cottage via file name 02_bee_hot_air_balloon of pack1` | `using`/`via` are optional. Text before the complete selector is inert and does not verify asset content. Quote reserved selector words in balanced double quotes in descriptions. |
| Script command, file ID | `!buildSchematic("pack1:02:01")` | Pack selector is `pack:group:fileId`; the stable mapping comes only from the explicit index. |
| Script command, file name | `!buildSchematic("pack1:02_bee_hot_air_balloon")` | Pack-qualified filename basename/stem; supported extension may be included. |
| Script command, root-relative path | `!buildSchematic("schems/pack1/02_bee_hot_air_balloon.schem")` | A contained path relative to `schematics/` is accepted and normalized. Absolute paths, backslashes, and paths escaping the schematics directory are rejected. A bare legacy filename such as `!buildSchematic("example.schem")` is also supported from the root. |
| Optional placement | `!buildSchematic("pack1:02:01", 100, 64, -20)` | Direct script commands accept all three finite coordinates (floored to block coordinates), or omit all three / pass three `null`s for nearby placement. Partial coordinate tuples are invalid. Human typed requests do not accept coordinates. |

Human routing requires the bot's exact name at the start (case-insensitive; an optional `@` is accepted), followed by `build` and one complete selector. Only a request addressed to this bot is actionable; a request addressed to a known peer is ignored by this bot. After `build`, inert descriptive text may precede the selector; `please`, `can you`, `could you`, and `would you` are allowed after the address. The one selector must be terminal apart from optional sentence punctuation. Full and short labels are specifically `file id` / `id` for a stable numeric ID and `file name` / `file` for a literal basename. The typed parser returns `selectorKind: "fileId"` with `fileId` for numeric selections, or `selectorKind: "fileName"` with `fileName` for filename selections; legacy `kind`, `id`, and `filename` aliases remain for compatibility. `!listSchematics` entries expose `fileId` and `fileName` plus the legacy `id` and `filename` fields. The direct script command retains its positional `filename, x, y, z` behavior (the first argument now conceptually represents `fileName`). A literal filename named `id` or `name` should use explicit `file name id of pack1` / `file name name of pack1`, a pack/name slash form, or a supported extension; bare numbers are not filename selectors. An extension or exact selector is required when same-stem files are ambiguous. Descriptive text can contain selector-reserved words only inside balanced double quotes; only `\\` and `\"` escapes are accepted inside them. The parser does not inspect or verify the description against the selected asset, and does not guarantee arbitrary paraphrases. `colour scheme` and `database schema` remain ordinary chat unless a complete typed target shape follows. Once addressed typed selector intent is recognized, incomplete/partial, duplicate, contradictory, malformed, extra-instruction, coordinate-bearing, traversal, injection, or unresolved selectors fail closed without model inference. Messages without selector intent remain ordinary chat. Both route and direct command require configured trusted senders; `only_chat_with`, if set, must also allow that sender. Source changes require rebuilding and recreating the deployed image.

Both direct commands and typed human requests are restricted to configured `trusted_command_senders`; a non-empty `only_chat_with` list must also allow the sender. Send a direct command as `/msg Andy !buildSchematic("pack1:02:01")`. Pack names are normalized to lowercase in typed requests. Group and file ID are positive safe integers (1 through 9007199254740991), optionally written with leading zeroes, and must resolve to an existing index mapping. Keep mappings stable; do not renumber them or calculate file IDs from sorting. The bot also needs permission to switch into Creative mode. Prefer least-privilege game-mode permissions over `/op`; provider-specific examples are below. Source changes are baked into Docker images, so rebuild and recreate the image before expecting updated routes.

For explicit placement, provide all three coordinates or omit all three. Examples: [`!buildSchematic("pack1:01:01", 100, 64, -20)`](../src/agent/commands/actions.js:492) places at the supplied world position; [`!buildSchematic("pack1:01:01", null, null, null)`](../src/agent/commands/actions.js:492) uses nearby placement. Coordinates are direct-command-only. Send [`!stop`](../src/agent/commands/actions.js:54) to cancel a running build. The command signature and parameter schema are in [`src/agent/commands/actions.js`](../src/agent/commands/actions.js:492), listing output in [`src/agent/commands/queries.js`](../src/agent/commands/queries.js:231), and the typed parser in [`src/agent/schematic_request.js`](../src/agent/schematic_request.js:93).

Typed filename basenames accept only ASCII letters, digits, underscores, dots, and hyphens, with no spaces, quotes, or subdirectories; a digits-only basename needs a supported extension to be a filename selector. Filename and extension spelling must match the actual file's case exactly, even though labels and typed pack names are case-insensitive. The full `file name packN/<basename>` slash form is supported too. Direct root-relative paths have the broader confined-path behavior described in the table; these typed-chat limits do not redefine that interface.

Alias substitution also works in the full filename label: `schema name <basename> of packN` or `schema name packN/<basename>`, likewise for `schem`, `scheme`, and `schematic`. Numeric selectors retain `file offset` as well as `offset` and the bare shorthand; each may have an optional alias prefix. A `#` may precede the file ID when an alias or ID/offset label is present, and group digits may independently have a `#`. The unprefixed bare shorthand must start with digits, not `#`.

### Pack contents and tooling

- Reference images: [`schematics/screenshots/packN/<folder>/`](screenshots/)
- Source blueprints and per-build notes: [`schematics/blueprints/packN/`](blueprints/)
- Sponge/legacy schematic assets and optional explicit ID manifest: [`schematics/schems/packN/`](schems/)
- Reusable compilation, registry/production-reader validation, and audit tooling: [`schematics/tooling/`](tooling/)
- Generated audit data and logs: [`schematics/tooling/validation/packN/`](tooling/validation/)

The compiler and validator accept repository-relative paths from any current working directory. From the repository root, compile and validate a build using the commands in [`BLUEPRINT_TOOLING.md`](tooling/BLUEPRINT_TOOLING.md). The production-reader validator follows each blueprint's `minecraft_version` and `data_version`; supply a Minecraft-version argument only when it matches the blueprint metadata and the corresponding installed registry. The pack audit command is `python3 schematics/tooling/audit_batch.py --pack pack1`; it reads every blueprint in that pack and reports missing files or validation failures instead of assuming expected folders or fabricated success. Use `--minecraft-version <MC_VERSION>` or `--data-version <DATA_VERSION>` to require a pack-wide metadata value.

The numeric source-folder name is the group: `schematics/screenshots/pack1/2/` is group `2`. `schematics/schems/pack1/index.json` uses schema version 2 with nested `groups`, then numeric ID keys mapped to exact filenames. IDs are separate from group numbers and are never selected by sorting files at request time. For example, `pack1:2:1` resolves through group `2`, ID `1` to `02_bee_hot_air_balloon.schem`, while `pack1:1:1` resolves to the wardrobe. Do not recompute or renumber mappings after additions or renames. Numeric components are positive safe integers (1 through 9007199254740991), with optional leading zeroes; pack names are `pack` followed by a positive decimal number.

### Integration review limits

The [focused integration review](tooling/validation/pack1/integration_review.md) records prior real-pack checks. The current schematic tests verify three-component lookup against the actual pack index and exercise wardrobe reading/build-plan creation with simulated server operations only. Build-plan preflight accepts 28/30 assets; the pagoda (group 04, ID 01) and giant grandfather clock (group 18, ID 02) still reject potted plants, which require multi-step placement. Binary and production-reader validation do not prove placeability. Live-server placement, permissions, image fidelity, and natural-language LLM interpretation are not tested.

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

Both actual settings still use offline bot authentication. A username allowlist is **not identity authentication**: if the server/proxy permits offline name spoofing, an attacker can impersonate Sunny26639 and obtain that player's command privileges. Server/proxy identity enforcement has not been verified, and authentication mode was not changed. Known-peer lists are also name-based: add other bot names explicitly, and do not treat an unknown username as proof of a human. Public chat and Minecraft whispers from known peers are ignored at the event boundary; Mindserver peer conversation remains possible, but peer-triggered generated commands are denied. Command fragments are redacted from outgoing shared chat and private bot responses. The [incident routing regression tests](../test/schematic/incident_review.test.js) exercise these boundaries; they do not establish identity authentication or live-server behavior.

Both local configs deliberately retain enabled insecure coding. With it enabled, [`!newAction`](../src/agent/commands/actions.js:31) is documented and can execute generated code; this remains high risk, especially with offline name spoofing. When disabled, that command is omitted from generated command docs and selected examples, rejected by dispatch, and guarded in the action itself. Historical/custom prompt text is not erased and the model may still mention unavailable commands; mentioning one does not make it executable. [`!buildSchematic`](../src/agent/commands/actions.js:493) does not require insecure coding. Do not enable code generation merely to build a schematic.

## Safe code updates and Docker redeployment

Use Git to transfer reviewed commits between clones. Commit the intended code/assets, review the exact commit, push the exact tracked branch to the intended repository or fork, and configure the destination checkout to track that intended remote branch. The updater derives the remote and branch from that checkout's configured upstream; it does not assume `origin`, `main`, or `develop`, switch branches, or push changes.

### First-time bootstrap and destination review

The update script is itself part of the code being transferred, so it is not present in a pre-existing destination clone until that clone has received the commit containing it. Bootstrap the script through the destination's normal reviewed Git procedure, not by assuming it can update itself. First back up and manually reconcile the destination's tracked, untracked, and ignored data, confirm the intended remote/branch, and review all host-specific configuration. An earlier destination inspection reported 16 modified tracked paths and 343 untracked paths, including conflicts such as a differing schematic index; those are historical counts, not a current safety check. Do not run an update there until local changes are backed up and reconciled. Inspect ignored runtime data separately as well. No updater can infer which local configuration or runtime state should win, and this audit does not inspect or modify that deployment checkout.

Tracked schematic assets (indexes, binaries, blueprints, screenshots), source, and tests transfer through Git commits. Confirm intended files are tracked with `git ls-files`. If Git LFS or submodules are introduced, verify their objects/checkout explicitly; the updater refuses submodules and Git LFS pointer files rather than claiming to hydrate them. Ignored files do not transfer. Provision `keys.json` and other secrets securely; do not commit or copy credentials as part of a blanket repository migration. Histories/state and dependencies likewise require deliberate destination-side handling.

### Update, build, recreate, verify

From the repository root, only after reviewing and backing up the destination:

```sh
scripts/update.sh --apply \
&& docker compose build bot-andy bot-alice \
&& docker compose up -d --force-recreate bot-andy bot-alice
```

The `&&` chain stops before Docker if update is blocked or fails. Then check status and inspect recent startup logs locally:

```sh
docker compose ps bot-andy bot-alice
docker compose logs --tail=100 bot-andy bot-alice
```

For an offline preflight, run `scripts/update.sh --check`; it compares with the locally cached upstream-tracking ref only, does not refresh the index, and makes no network request, so it cannot tell whether the remote has newer commits. It does not inspect incoming content/collisions or certify deployment readiness. A missing cached ref blocks this check; `--apply` can fetch the configured branch to create that ref. `--apply` fetches without force and only fast-forwards a clean, non-bare, named, non-shallow, non-sparse, non-partial checkout with no Git operation in progress, unsafe index flags, submodules, configured checkout filters, or untracked files. Both existing and incoming gitlinks are refused. Ahead/diverged branches, conflicts, fetch failures and ignored incoming-path collisions are refused. It never runs `reset`, `clean`, `stash`, rebase, force, or a merge commit. Fetch disables tag updates, pruning, submodule recursion, automatic maintenance, commit-graph writes, and opportunistic configured ref mappings; it may still write fetched objects, the selected tracking ref, reflogs, and FETCH_HEAD even if a later safety check fails.

The script requires a POSIX shell, Git supporting its selected options, and standard `dirname`, `cat`, `mkdir`, `rmdir`, `grep`, and `awk` commands. Tests use Git 2.53.0; they do not prove behavior on every Git/filesystem version. Hooks and fsmonitor are disabled for updater Git commands. Partial/promisor clones and configured checkout filters (even unused/global ones) are conservatively rejected to avoid implicit downloads/hydration; materialize and review a normal full clone manually instead. This is not a sandbox for untrusted Git configuration, transport/credential helpers, executables, upstream content, or environment. Repository/index environment overrides are rejected. The default target is the checkout containing the script, not the caller's directory; `--repo PATH` selects an explicit checkout (or a directory inside it). Symlinked parent directories and linked worktrees are supported, but symlinked script files are not resolved to their referent. Checkout/script/metadata directory paths containing newlines are unsupported and refused; filenames inside a supported checkout may contain spaces, tabs, or newlines.

Git's `merge --ff-only --no-overwrite-ignore` protection is retained. Adversarial tests verify ignored file/directory/symlink collisions, including an ignored parent directory containing tracked and ignored children, fail without changing HEAD, index bytes, user bytes, or symlinks on the tested Git. Unrelated ignored runtime data remains in place on successful updates. These are not general atomicity guarantees: I/O errors, disk exhaustion, process termination, or unrelated concurrent writers can leave partial checkout changes. There is no automatic rollback, which could itself destroy user changes. After any failure, inspect HEAD, index, and files and preserve data before retrying; never assume failure means nothing changed. The advisory directory lock excludes concurrent calls in the same worktree only, not unrelated Git/file writers or other linked worktrees sharing refs. Traps remove an owned empty lock on normal exit and handled HUP/INT/TERM; a kill/crash or signal during lock acquisition can leave a stale lock. Never delete a lock automatically: confirm its owner is no longer running first. No timeout, power-loss durability, race-free filesystem snapshot, or serialization with Docker is provided. If the script is absent in an older checkout, bootstrap manually as above. Tests run with `node --test test/update-project.test.js`; Git mutations use only temporary local clones and temporary bare remotes, with non-file transports disabled.

This updater does not install dependencies, run `rsync`, or build/deploy Docker. In particular, do not assume update success validates the image build context, destination config, or image safety. The Dockerfile copies application source into the image, and these bot services do not bind-mount that source: host source updates require image rebuild and container recreation to take effect. The Compose file does bind-mount settings, profiles, credentials, schematics, and bot state from the destination host; those mounted contents override corresponding image contents at runtime. The current `.dockerignore` excludes `keys.json` but not `.git`; metadata including potentially credential-bearing remote configuration can therefore enter the image. Review build-context safety separately without assuming the updater fixes it. Tracked host-specific files (including both bots' settings/profile files) can be replaced by a clean fast-forward, so review them before update and inspect the resulting host files before deployment. The ignored `package-lock.json` means dependency resolution/image builds are not guaranteed reproducible.

Use `rsync` only for specific reviewed operational files when an intentional data migration needs it: stop processes that write the data, dry-run and review each selected path, and do not use `--delete` or blanket-copy `.git`, dependencies, credentials, or bot state. Do not alter ignore/Docker-context policy automatically as part of code update. Docker builds require appropriate network/native build prerequisites and compatible package patches; successful script output is not evidence that Docker will build or run correctly.

After verifying services, check fresh startup logs locally without publishing credentials or complete history/model logs. For an in-world schematic check, send `/msg Andy Andy build 01 from group 02 of pack1` or `/msg Andy !buildSchematic("pack1:02:01")`; the [persistent index](schems/pack1/index.json) maps that selector. Do not repeat an independent request while a build is active. Verify placement in-world only when ready; automated tests do not contact a live server.

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
- Use primary syntax `!buildSchematic("<packN>:<group>:<id>")`; translate “id 1 from group 2 of pack1” to `pack1:2:1`, never reverse the components. The numeric group is the screenshot folder; ID is its persistent explicit index mapping, not sorted position. Addressed typed requests also accept `build id <number> from group <number> of packN`, `build offset <number> from group <number> of packN`, bare `build <number> from group <number> of packN`, `build file <basename> of packN`, and `build file packN/<basename>`. Descriptive text, optional `using`/`via`, quote constraints, and safe failure are defined above. Direct commands accept pack-qualified filename/stems/extensions and contained root-relative filenames. Run `!listSchematics` to confirm separate pack, group, ID, and filename.
- Maintain schema-version-2 `schematics/schems/<packN>/index.json` explicitly; nested numeric group and ID keys map to exact filenames. Never renumber mappings or derive IDs from filename sorting. Keep each group/ID mapping unique and each target real. Numeric components are positive safe integers (1 through 9007199254740991), with optional leading zeroes; pack names are `pack` plus a positive decimal number. Directly indexed filename forms may use other names.

## Sequential workflow and actual validation commands
1. Inventory the requested numeric folder(s), sort folder numbers numerically and `.jpg` paths alphanumerically, then inspect every image. Record filenames and uncertainty before blueprinting. Do not skip work solely because a note says `[DONE]`; verify the actual JSON and `.schem` are present and nonempty.
2. Build a complete explicit blueprint with dimensions, origin, `minecraft_version: "<MC_VERSION>"`, `data_version: <DATA_VERSION>`, legend, `layers[y][z][x]`, expected state counts, and spot checks. Keep it as the source of truth.
3. From the repository root, compile and independently validate the generated file with the real tooling:

   `python3 schematics/tooling/compile_blueprint.py compile schematics/blueprints/<packN>/<NN_building_slug>.json schematics/schems/<packN>/<NN_building_slug>.schem`

   `python3 schematics/tooling/compile_blueprint.py validate schematics/blueprints/<packN>/<NN_building_slug>.json schematics/schems/<packN>/<NN_building_slug>.schem`

   `python3 schematics/tooling/compile_blueprint.py test-varints`

   `node schematics/tooling/validate_blueprint.mjs schematics/blueprints/<packN>/<NN_building_slug>.json schematics/schems/<packN>/<NN_building_slug>.schem <MC_VERSION>`

   The compiler verifies gzip/NBT Sponge v2 structure, DataVersion, dimensions, palette, canonical VarInt order (X fastest, then Z, then Y), every voxel, counts, and spot checks. The Node validator uses the production `readSchematic` parser and installed `minecraft-data` registry for the exact version; report any nonzero status or parser mismatch truthfully. Do not alter geometry or expected states merely to make an audit pass. Compilation writes the canonical `.schem`, so only run it for the intended output; audits regenerate to temporary files. Run `python3 schematics/tooling/audit_batch.py --pack <packN>` to write the machine result at `schematics/tooling/validation/<packN>/batch_validation.json`, per-build logs, and the generated report section. Run `npm run test:schematic` for the complete schematic test suite.
4. Record the exact commands, exit statuses, dimensions, voxel/block counts, registry/reader results, output byte size and SHA-256 in the per-build note. Distinguish binary validation from production-reader comparison; neither proves visual fidelity or live server placement. Mark unsupported/inferred details and do not claim a live test.
5. After each folder, verify the JSON, `.schem`, and note are nonempty; update the pack report without overwriting historical sections. Add a deliberate ID mapping when appropriate and verify the corresponding command syntax. Summarize only builds actually inspected and tested.

If you cannot write files directly, do not claim the artifacts exist. Supply a complete repeatable generator plus exact dependency installation and run instructions that create the JSON and actual binary schematic in the specified paths. Report assumptions, version/DataVersion, dimensions/origin, palette/counts, exact paths and sizes, checks and limitations. Never imply that a live Mindcraft server build was tested.
```
