# Local schematic end-to-end test

## Host schematic tests

Use Node.js 22 and npm, Python 3 with `venv` and `pip`, and the native build dependencies needed by the project's npm packages. On Debian/Ubuntu, install those build dependencies with:

```sh
sudo apt-get install python3 python3-venv python3-pip build-essential pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev libgl1-mesa-dev libgles2-mesa-dev libosmesa6-dev libxi-dev libxinerama-dev libxrandr-dev
```

From the repository root, install the Node dependencies and the declared Python requirements in an isolated environment. Activating it makes its `python3` available to the Node test runner and the Python subprocesses:

```sh
npm install
VENV_DIR="$(mktemp -d /tmp/mindcraft-host-venv.XXXXXX)"
python3 -m venv "$VENV_DIR"
. "$VENV_DIR/bin/activate"
python -m pip install -r requirements.txt
npm run test:schematic
```

Remove the temporary virtual environment after deactivating it when finished. The Python requirements include the tested `nbtlib==2.0.4` but do not lock every transitive dependency. `npm install` uses the existing root lockfile if present; it may change that file and the existing dependency installation. Do not replace a developer's lockfile or remove their modules just to run tests. For a clean reproducible Node install in a separate checkout, copy `ci/npm-lock.json` to `package-lock.json` there and run `CI=true npm ci`; that lock is the one used by the test image. Copy any uncommitted changes into the separate checkout before testing. These host tests do not need Docker or Task and do not prove live-server behavior.

## Quality-Gate automation

After Code changes, Quality-Gate should run `task quality:gate` or `make quality-gate`. The full gate runs the patch verifier, root and schematic offline suites, and `task test:schematics` (or the equivalent Make target when Task is unavailable). It runs all checks even if an earlier one fails, returns nonzero for any failure, and prints a private temporary directory containing separate logs. Review logs before sharing: test output can contain sensitive data. Remove that directory when no longer needed. `task quality:fast` or `make quality-fast` runs the offline subset for iteration; success is not a full gate pass. Python dependencies must be available on PATH for offline schematic tests. When using a separate checkout, it must contain the complete proposed changes; diff review remains necessary in the original checkout.

## Local live CI

Install Docker Engine with a running daemon, the [Docker Compose v2 plugin](https://docs.docker.com/compose/install/linux/), and [Task v3](https://taskfile.dev/docs/installation) (or GNU Make instead of Task). The user must have access to the daemon; the machine needs network access to download the images, npm dependencies and server artifacts, plus enough disk and memory for a Java server configured with 2 GiB heap. The image supplies Node 22 and Python 3 for the live batch; the host virtual environment and `nbtlib` are not used by that batch. Run from the repository root:

If the host lacks both tools, Linux x86-64 users can install these pinned releases in a new temporary directory, without changing global configuration. The SHA-256 values below correspond to the upstream release checksums; verify updated versions independently before changing them. This isolated Docker configuration uses the default local Docker context, not existing credentials or custom contexts; check the daemon target before starting. Images and server artifacts still require network access.

```sh
TOOLS="$(mktemp -d /tmp/mindcraft-ci-tools.XXXXXXXX)"
mkdir -p "$TOOLS/docker/cli-plugins"
curl -fL https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-x86_64 -o "$TOOLS/docker/cli-plugins/docker-compose"
echo 'ed1917fb54db184192ea9d0717bcd59e3662ea79db48bff36d3475516c480a6b  '"$TOOLS/docker/cli-plugins/docker-compose" | sha256sum -c - || exit 1
chmod +x "$TOOLS/docker/cli-plugins/docker-compose"
curl -fL https://github.com/go-task/task/releases/download/v3.41.0/task_linux_amd64.tar.gz -o "$TOOLS/task.tar.gz"
echo '0a2595f7fa3c15a62f8d0c244121a4977018b3bfdec7c1542ac2a8cf079978b8  '"$TOOLS/task.tar.gz" | sha256sum -c - || exit 1
tar -xzf "$TOOLS/task.tar.gz" -C "$TOOLS" task
export DOCKER_CONFIG="$TOOLS/docker"
export PATH="$TOOLS:$PATH"
docker info --format '{{.Name}}'
docker compose version
task --version
```

Run the gate only if the displayed daemon is the intended local daemon. Afterwards restore the prior `PATH` and `DOCKER_CONFIG` (or use a subshell) and remove only the newly created `$TOOLS` directory. Task is optional when using Make.

```sh
task test:schematics
# Alternative when Task is not installed:
make test-schematics
```

The first run downloads the container images, the pinned Purpur 1.21.4 build and its Mojang server, and npm packages; subsequent runs still require those artifacts to be available. No external Minecraft server or LLM is used. The mock is intentionally limited to the suite's goal markers. No ports are published. The offline operator, permissive creative mode and platform preparation are **only** for this isolated disposable world. Do not expose this test stack to untrusted clients.

Compose waits for server and mock health, runs each case sequentially in a fresh Mindcraft process, then removes its uniquely named network and world volume even on failure or interruption. A task must emit a matching successful result with score 1; timeouts, missing results and process errors fail the batch. Logs show requests, commands, builder output and mismatches. The fixture builds use strict provenance and normal delicate safety checks, not a test-only builder. The independent world validator checks every voxel, including air and state properties, after the builder reports completion. The rotation case covers geometry with stateless blocks; arbitrary directional block placement is not implied.

For a schematic task, specify `type`, `schem_path` (a production resolver selector), integer `origin`, `orientation`, `goal`, `agent_count`, `human_count`, and `timeout`. Inventory is derived from selected non-air blocks whose block names have corresponding item names; unsupported mappings fail rather than guessing. The task teleports the bot just outside the target. `prepare_test_platform` explicitly fills an 11-by-11 stone layer below the origin and is destructive to that layer: use it only in disposable worlds. The bot needs operator permissions for task inventory, teleport and optional platform commands. Without the option, prepare a safe, loaded site yourself. The builder still decides whether the site and each placement are safe and reachable.

Fixtures and sidecars in `schematics/ci/` are compiled from `schematics/blueprints/ci/` with the repository's strict compiler. Regenerate into a new location following `schematics/tooling/BLUEPRINT_TOOLING.md`; never overwrite provenance casually. Strict content validation is not proof of live placement on other versions or servers. The image uses a separate CI dependency lock rather than the developer's ignored root lockfile. The upstream image tags and server artifacts can still change.

**Mineflayer patch compatibility:** postinstall fails if any patch fails or if either the schematic cancellation checks or exact patched Mineflayer 4.39.0 digging source is missing. The inherited item-use rotation is already upstream. Upstream eye-level water calculation and its Aqua Affinity handling are retained rather than disabling the water penalty; waterlogged and unloaded eye-level blocks remain subject to upstream limitations. Placement keeps the upstream five-second timeout and reference/destination acknowledgement logic: an acknowledged refusal fails promptly, while a 500 ms timeout would misclassify slow replies. The material correction applies only to direct members of the Java 1.21.4 pickaxe tag that the locked data labels `incorrect_for_wooden_tool`, without mutating the block. The pinned tag source is [misode/mcmeta at 277751c76153ac1a084813188ac7ceea2028b625](https://github.com/misode/mcmeta/blob/277751c76153ac1a084813188ac7ceea2028b625/data/minecraft/tags/block/mineable/pickaxe.json). Other versions and unknown names use upstream estimates; they may be slower or inaccurate until independently reviewed. This does not change harvestability. Re-review the tag, patch and verifier digest when upgrading Mineflayer or supported versions.

**Minecraft protocol compatibility:** the inherited `minecraft-data` 3.97.0 patch was a no-op against the unmodified 3.119.0 CI package: both 1.21.6 serverbound chat checksum fields are already `u8` upstream. It was removed rather than renamed. Postinstall now verifies the exact 1.21.6 data and both unsigned checksum fields; tests also round-trip checksum values 0, 127, 128 and 255 through the protocol serializer and parser. This checks only those fields, not every registry or protocol behavior. Re-review upstream data if verification fails after an upgrade; do not silently change protocol versions or signedness to pass it.

## Dependency audit limitations

On 2026-11-25, the CI lock audit changed from 22 affected packages (17 moderate, 4 high, 1 critical) to 21 (19 moderate, 2 high, 0 critical) after a clean install. Counts are affected packages, including propagated findings, not individual advisory counts, and change with the advisory database. The remaining high finding is Zod's oversized-collection memory exhaustion, propagated to OpenAI; moderate findings include UUID through Minecraft authentication and glob through the build cache. Audit fixability alone does not establish compatibility.

The `gl` install script invokes the `node-gyp` CLI. Its scoped override moves the CLI from 10.3.1 to 11.5.0, outside `gl`'s declared 10.x range; the latter supports Node ^18.17 or >=20.5, including the Node 22 CI runtime. It brings both build-tool `tar` consumers onto locked 7.5.23, which is outside the reported vulnerable ranges, instead of blindly replacing their declared tar 6 APIs. npm hoists this CLI in the tested install, so the `canvas` source-build fallback also uses it. A clean forced source build compiled both native modules, and the full gate passed. This is still an override across a declared major boundary, not an upstream compatibility promise: retest native compilation, header downloading, the CI image and supported Node versions when upgrading `gl`, `node-gyp` or the lock, and remove the override when upstream supplies a safe compatible toolchain. The existing locked Minecraft protocol dependency itself requires Node >=22.

OpenAI 4's optional Zod peer requires 3.x, while the Mistral SDK also uses Zod and imports its `zod/v3` API. The fixed advisory version is 4.6.6; forcing it underneath those consumers would violate OpenAI's peer range and does not establish that the embedded v3 API is fixed. A safe remediation requires an independently tested OpenAI/SDK and schema migration, including all configured providers and actual schema usage, rather than a cosmetic audit reduction. UUID fixes similarly require compatible authentication upstream changes. Avoid untrusted archives and inputs, use isolated builds and least privilege, and re-run the audit as upstream versions change; these precautions do not eliminate remaining vulnerabilities. Do not use `--force` as a substitute for a tested migration.

Normal startup uses the root settings file and both profiles with one MindServer. `MINECRAFT_HOST`, `MINECRAFT_PORT`, JSON `PROFILES`, CLI `--profiles`, and `SETTINGS_JSON` support test overrides; `SETTINGS_JSON` is applied last. The unified Compose launcher shares the same server instead of starting two competing instances.
