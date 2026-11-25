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

Remove the temporary virtual environment after deactivating it when finished. The Python requirements include the tested `nbtlib==2.0.4` but do not lock every transitive dependency. `npm install` uses the existing root lockfile if present; it may change that file and the existing dependency installation. Do not replace a developer's lockfile or remove their modules just to run tests. For a clean reproducible Node install in a separate checkout, copy `ci/npm-lock.json` to `package-lock.json` there and run `npm ci`; that lock is the one used by the test image. See the Mineflayer patch limitation below before relying on either installation. These host tests do not need Docker or Task and do not prove live-server behavior.

## Local live CI

Install Docker Engine with a running daemon, the [Docker Compose v2 plugin](https://docs.docker.com/compose/install/linux/), and [Task v3](https://taskfile.dev/docs/installation) (or GNU Make instead of Task). The user must have access to the daemon; the machine needs network access to download the images, npm dependencies and server artifacts, plus enough disk and memory for a Java server configured with 2 GiB heap. The image supplies Node 22 and Python 3 for the live batch; the host virtual environment and `nbtlib` are not used by that batch. Run from the repository root:

```sh
task test:schematics
# Alternative when Task is not installed:
make test-schematics
```

The first run downloads the container images, the pinned Purpur 1.21.4 build and its Mojang server, and npm packages; subsequent runs still require those artifacts to be available. No external Minecraft server or LLM is used. The mock is intentionally limited to the suite's goal markers. No ports are published. The offline operator, permissive creative mode and platform preparation are **only** for this isolated disposable world. Do not expose this test stack to untrusted clients.

Compose waits for server and mock health, runs each case sequentially in a fresh Mindcraft process, then removes its uniquely named network and world volume even on failure or interruption. A task must emit a matching successful result with score 1; timeouts, missing results and process errors fail the batch. Logs show requests, commands, builder output and mismatches. The fixture builds use strict provenance and normal delicate safety checks, not a test-only builder. The independent world validator checks every voxel, including air and state properties, after the builder reports completion. The rotation case covers geometry with stateless blocks; arbitrary directional block placement is not implied.

For a schematic task, specify `type`, `schem_path` (a production resolver selector), integer `origin`, `orientation`, `goal`, `agent_count`, `human_count`, and `timeout`. Inventory is derived from selected non-air blocks whose block names have corresponding item names; unsupported mappings fail rather than guessing. The task teleports the bot just outside the target. `prepare_test_platform` explicitly fills an 11-by-11 stone layer below the origin and is destructive to that layer: use it only in disposable worlds. The bot needs operator permissions for task inventory, teleport and optional platform commands. Without the option, prepare a safe, loaded site yourself. The builder still decides whether the site and each placement are safe and reachable.

Fixtures and sidecars in `schematics/ci/` are compiled from `schematics/blueprints/ci/` with the repository's strict compiler. Regenerate into a new location following `schematics/tooling/BLUEPRINT_TOOLING.md`; never overwrite provenance casually. Strict content validation is not proof of live placement on other versions or servers. The image uses a separate CI dependency lock rather than the developer's ignored root lockfile. The upstream image tags and server artifacts can still change.

**Unresolved installation limitation:** the inherited Mineflayer 4.33.0 patch does not apply to the declared and CI-locked 4.39.0. In a normal non-CI environment patch-package prints an error but defaults to exit 0, and the separate postinstall verifier checks only the schematic cancellation patch. In a detected CI environment patch-package normally exits nonzero instead. Consequently, a successful image build or live suite does not mean the Mineflayer patch was installed. Its item-use rotation calculation is equivalent to 4.39's upstream conversion; 4.39 instead calculates underwater status at eye level and has substantially different placement acknowledgement logic. The inherited patch also rewrites certain tool materials and shortens the placement timeout from five seconds to half a second; neither change is present in an unpatched 4.39 install. Blindly transplanting the old patch would override upstream underwater behavior or alter the newer acknowledgement timing, so it has not been applied without a compatibility review. Do not rely on those inherited behaviors. Review the patch against all supported versions and test digging and placement semantics before resolving the mismatch; do not suppress patch-package errors.

Normal startup uses the root settings file and both profiles with one MindServer. `MINECRAFT_HOST`, `MINECRAFT_PORT`, JSON `PROFILES`, CLI `--profiles`, and `SETTINGS_JSON` support test overrides; `SETTINGS_JSON` is applied last. The unified Compose launcher shares the same server instead of starting two competing instances.
