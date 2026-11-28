# Local schematic end-to-end test

## Preconfigured isolated workflows

From the repository root, `make ci-isolated-install`, `make ci-isolated-live`,
`make ci-isolated-full`, and `make ci-isolated-cache-tests` create fresh private
workspaces. Equivalent Task targets are `ci:isolated:install`, `ci:isolated:live`,
`ci:isolated:full`, and `ci:isolated:cache-tests`. For explicit options, run
`python3 scripts/run_isolatedci.py full --jobs 2 --workspace-parent /tmp`;
other actions are `install`, `live`, and `cache-tests`. The full action runs
the existing full gate, not an alternative selection. The cache action runs the
named Python cache tests and Node build/cache tests. Each invocation installs a
fresh CI lock; no test result is cached. Timing uses a monotonic clock, does not
require `/usr/bin/time`, and reports the exit status even on setup failure.

Requirements: Git, Node 22/npm, Python 3.9–3.11 with venv and pip (the install
action alone needs no venv), the native build
packages listed below, network access to npm and PyPI, and sufficient disk.
Live/full additionally require Linux x86_64, network access to GitHub releases
and container registries, Docker CLI, and permission to use the local Docker
socket at `/var/run/docker.sock`. The isolated Docker config deliberately ignores
the caller's context, credentials, and remote hosts. The wrapper downloads
Compose v2.32.4 from its official GitHub release and checks SHA-256
`ed1917fb54db184192ea9d0717bcd59e3662ea79db48bff36d3475516c480a6b`
before executing it, then checks the plugin and local daemon. Unsupported
platforms and unavailable daemons fail; a checksum protects integrity, not a
compromised upstream release. Docker access is effectively privileged and the
test pulls and executes third-party images. npm lifecycle scripts and Python
packages also execute code; the Python transitive dependencies are not fully
locked or hash-pinned. Run only on a trusted machine and trusted checkout.

Each run prints its owner-only workspace and retains it, including the isolated
checkout, npm cache, venv, setup logs, and nested full-gate logs in its `tmp`
directory. Logs may contain sensitive information: inspect locally before
sharing. Nothing is automatically dumped on failure. Remove only that printed
workspace when finished. The snapshot includes tracked and non-ignored untracked
working-tree files and deletions, but excludes other ignored data; it rejects
symlinks. Do not modify the checkout during snapshot creation. Its local Git
index is newly created, so its diff check does not replace reviewing the original
worktree and staged changes. The caller's index, modules, lockfile, npm config,
credentials and bot data are never changed. Snapshot enumeration uses the caller's
effective Git ignore policy (including global and info excludes) before switching
to the private Git environment; inaccessible configured ignore files fail closed.
Ignored files, including the developer lockfile, are not copied by this wrapper;
the CI lock is installed afterwards. Tracked files remain included even when
ignored. Do not put credentials in tracked or non-ignored files. The normal gate
still supports the developer-dependency workflow described below.

The snapshot process alone receives the Git configuration needed to enumerate;
install and test processes inherit only PATH and locale, plus private HOME, npm,
Git, Python and Docker settings. Proxy variables are deliberately not inherited,
including credential-bearing URLs; networks requiring a proxy need a separately
reviewed setup. Choose a trusted PATH. On the first SIGINT or SIGTERM the wrapper
requests that a separate live session/group supervisor forward it to its own
group, waits 25 seconds, then the supervisor sends SIGKILL to its own group
before the wrapper reports elapsed time and status 130 or 143. The wrapper
never signals a saved group ID. The supervisor stays alive after reaping the
workflow child, so a signal at that boundary still reaches same-group descendants.
Safe fallback signalling of an unresponsive supervisor requires default SIGCHLD
handling; the wrapper refuses auto-reaping or custom SIGCHLD handlers. It assumes
no other thread or component reaps its direct supervisor child.
On normal completion the supervisor immediately kills its own group to remove
remaining same-group descendants, preserving the child's exit status. Once that
normal cleanup has begun, a simultaneous late interrupt can report cancellation
without providing another grace period. If the stop request reaches the
supervisor before its normal-finish request, it gets the full grace; repeated
signals do not shorten it. Each
gate check runs under its own detached session leader, which forwards interrupts
and signals its own group while it is still alive; the scheduler never signals a
stored group ID. After the check exits, the leader kills its group (including
itself) to clean up remaining same-group descendants. On interruption it allows
up to 15 seconds for the check to exit before escalation; the extra 10 seconds allow for gate teardown, not a guarantee that
Compose finishes. The live shell's exit trap runs Compose down, which has no
independent timeout. Repeated signals to the wrapper do not shorten its grace;
forcibly killing it bypasses cleanup. These deadlines cover the subprocess wait,
not synchronous snapshot, download, filesystem teardown, or uninterruptible
kernel operations, so they are not a hard bound on total workflow time. The
wrapper cannot kill detached check groups if the gate itself fails to handle the
signal. A supervisor that dies unexpectedly cannot safely signal its former group;
when detected, the wrapper or gate reports that descendants or resources may remain. A
forced supervisor death after reporting its result can be indistinguishable from
its own final group kill, so that report is not proof of complete cleanup. Processes that
leave the group, Docker daemon resources, SIGKILL, host failure and
interrupted downloads cannot be guaranteed cleaned up; inspect private logs and
the named Compose project on interruption. This is not a sandbox and concurrent
checkout changes are unsupported.

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

After Code changes, run `task quality:full` or `make quality-full`. The earlier `task quality:gate` and `make quality-gate` commands remain aliases for the full gate. `task quality:fast` / `make quality-fast` runs only the offline subset; it is not a full gate pass. The full gate runs the Git diff whitespace check, patch verifier, all root tests, all discovered schematic tests (including the generic-pack replay), and the mandatory live schematic CI. Checks continue after failures and any failure makes the gate fail. The live cases remain sequential in a fresh Compose world.

Check identifiers use scope-first hyphenated names: `schematics-live`,
`schematics-tests`, and `schematics-generic-isolation`. Their per-run log
filenames use the same identifiers. Executable filenames use the separate
action_scope convention described in [the scripts guide](../scripts/README.md).

The gate prints worker count, start/completion and elapsed seconds for each check, total elapsed time, and a private temporary log directory. Inspect each failed check's log and review all logs before sharing; they can contain sensitive output. Remove the printed log directory when no longer needed. Each run creates and removes its own private workspaces. It snapshots tracked and non-ignored untracked files, including working-tree changes and deletions; the existing root `package-lock.json` is also copied because offline tests inspect it, while offline copies read the existing `node_modules` through a shared symlink. Other ignored files and Git metadata are excluded. A missing lock is not synthesized. Dependencies must already be installed and must not be modified while a gate runs. Git is required, checkout symlinks are rejected rather than followed, and changes to the checkout during snapshot creation are unsupported. The diff check runs against the original checkout and, like `git diff --check`, does not check staged-only or untracked files. Review those separately. Do not use the snapshot as a substitute for reviewing the original diff. No test result, world, or pass is cached.

By default the coordinator selects three workers only when it detects at least 12 available logical CPUs, 48 GiB total/limited memory and 16 GiB free memory/headroom; otherwise it selects two with at least two CPUs and 6 GiB total/limited memory, or one. On Linux, available parallelism reflects process affinity and effective cpuset; the coordinator also reads cgroup v1 or v2 CPU quotas at the process's cgroup and each visible ancestor. Fractional quotas round down, with a minimum of one worker. Missing, malformed, ambiguous or partially mounted CPU hierarchies and non-Linux platforms fall back to one worker; a cgroup namespace may nevertheless hide ancestors even when its mount appears to have a root of `/`. Free memory is the host's conservative free-memory figure, further bounded by current cgroup headroom when a finite limit is detected at the standard root files. Nested/ancestor memory limits, hidden CPU limits, other container or Docker-daemon limits, and competing workloads may not be visible. These thresholds are conservative heuristics, not reservations or guarantees. Explicit worker counts override the heuristic: assess headroom first, and use fewer workers on constrained or busy systems. This bounds gate checks, not subprocesses, Docker, Java threads, or Node's concurrent root test runner. The live server's 2 GiB Java heap is not a container memory limit; native memory and other services add to it. Concurrent gates multiply resource demand even though they do not share workspaces or worlds.

The schematic suite stays serial within each isolated copy; its generic-pack isolation replay and remaining files use separate copies so neither can race the other or the live build. Some schematic tests and helpers write fixed paths, so simply enabling file-level Node concurrency in one copy is unsafe. The live Compose project, network, and world are unique per invocation, and source mounts use the live snapshot read-only. SIGINT and SIGTERM stop running process groups and allow Compose cleanup; forced termination or host failure can require manual cleanup of the reported Compose project.

For explicit comparisons use `task quality:full:serial`, `task quality:full:2`, or `task quality:full:3` (Make: `quality-full-serial`, `quality-full-2`, `quality-full-3`); corresponding fast targets exist. The underlying command accepts only `fast` or `full` and `--jobs 1`, `--jobs 2`, or `--jobs 3`; it does not accept external check configurations or executable snippets. Both schematic selections invoke the same Node runner as the npm script directly, so npm configuration, including script-shell overrides in any casing, cannot replace those production checks. Known test-control environment variables, including `NODE_OPTIONS` and `NODE_PATH`, are rejected; select Python through PATH instead. This is not a sandbox: use a trusted Node executable, PATH, environment, checkout and Docker daemon. In particular Node processes startup options before the coordinator can reject them. Test fixtures use checked-in case data and dependency injection only in the test harness. Docker's existing dependency layers use `ci/npm-lock.json` and are reused by Docker when valid; there is no added server-download cache or global pruning. Benchmark matching coverage and warm/cold cache conditions separately, recording wall time, worker count, per-check timings, failures, and machine limits.

On 2026-11-26, a disposable CI-lock checkout on a Ryzen 5 5600 (6 cores/12 threads, 62 GiB RAM, no root cgroup CPU or memory cap) ran the same warm full gate with two workers in 300.07 s and three in 192.58 s. Two-worker stages: live 153.66 s, schematic 186.91 s, generic replay 146.02 s, diff 0.01 s, patches 0.15 s, root 12.01 s. Three-worker stages: live 151.22 s, schematic 192.20 s, generic replay 152.75 s, diff 0.01 s, patches 0.18 s, root 12.08 s. Each passed 527 schematic tests, the replay's 56 files/491 nested tests and one outer test, 125 root tests, and three live cases, with zero failed or skipped tests. A prior two-worker warm-up passed in 302.77 s. Sampling every two seconds during the three-worker run saw at most 39 host-wide Node processes (including unrelated processes), approximately 4.66 GiB summed Node RSS and 2.57 GiB Java RSS; minimum host available memory was approximately 50.9 GiB, and cgroup memory events did not increase. Summed RSS can double-count shared pages, and sampling misses peaks. The live logs also contained transient server-discovery errors before each successful case; negative-path tests intentionally log errors. These are measurements, not capacity guarantees; a fourth worker was not tested because the remaining short checks would contend with the critical schematic lane.

Python dependencies must be available on PATH for offline schematic tests. When using a separate checkout, it must contain the complete proposed changes; diff review remains necessary in the original checkout.

### Explicit timing and dependency experiments

For a timed run of the same mandatory live suite, create a private directory
and provide a new log path explicitly (existing files are never replaced):

```sh
mkdir -m 700 /tmp/my-mindcraft-run
python3 scripts/time_schematics.py --runner make --log /tmp/my-mindcraft-run/live.log
```

Use `--runner task` to run the equivalent Task target. The command prints
monotonic wall time and the actual exit status; output is in the private log.
It needs the same Docker, Compose and network prerequisites as the live suite.
It does not use or create a `/tmp/mindcraft-qa-current` marker. Remove only the
directory you created after reviewing its potentially sensitive log.

To evaluate a node-gyp candidate without touching the checkout's manifest,
lockfile or modules, use an existing private directory outside the checkout:

```sh
python3 scripts/experiment_nodegyp.py --workspace-parent /tmp/my-mindcraft-run --node-gyp 12.3.0
```

This creates and prints a new owner-only workspace, snapshots tracked and
non-ignored untracked working files (including modifications and deletions),
rejects symlinks, copies the CI lock, and changes only the copy. Do not change
the checkout during snapshotting; review untracked files before running, as
they are copied and may contain sensitive information. It uses a private npm
cache and empty npm config files, generates a candidate lock, performs a clean
install, forces source builds of both native modules, loads them, records the
dependency tree, and runs audit. A valid audit with findings is reported
separately from a malformed or failed audit; findings are not a clean audit.
Node, npm, Git, network and native build dependencies listed above are needed.
Logs, the copy and generated lock remain in the printed workspace, including
on failure. Review them and delete only that workspace when no longer needed.
The experiment uses the same caller-ignore-aware snapshot and the same PATH/locale
allowlist and private HOME, npm, Git, Python and Docker settings as the isolated
wrapper. Proxy and other caller variables are not passed to npm lifecycle scripts.
The documented direct host `npm install` and direct gate commands are not isolated:
they inherit the caller's environment and configuration. This is not a sandbox:
use a trusted checkout, tools, environment and npm registry. It neither uses nor
creates a `/tmp/mindcraft-review-current` marker.
It does not establish runtime or live CI compatibility on its own.

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

Compose waits for server and mock health, runs each case sequentially in a fresh Mindcraft process, then removes its uniquely named network, world volume and locally built tester image even on failure or interruption. A task must emit a matching successful result with score 1; timeouts, missing results and process errors fail the batch. Logs show requests, commands, builder output and mismatches. The fixture builds use strict provenance and normal delicate safety checks, not a test-only builder. The independent world validator checks every voxel, including air and state properties, after the builder reports completion. The rotation case covers geometry with stateless blocks; arbitrary directional block placement is not implied.

For a schematic task, specify `type`, `schem_path` (a production resolver selector), integer `origin`, `orientation`, `goal`, `agent_count`, `human_count`, and `timeout`. Inventory is derived from selected non-air blocks whose block names have corresponding item names; unsupported mappings fail rather than guessing. The task teleports the bot just outside the target. `prepare_test_platform` explicitly fills an 11-by-11 stone layer below the origin and is destructive to that layer: use it only in disposable worlds. The bot needs operator permissions for task inventory, teleport and optional platform commands. Without the option, prepare a safe, loaded site yourself. The builder still decides whether the site and each placement are safe and reachable.

Fixtures and sidecars in `schematics/ci/` are compiled from `schematics/blueprints/ci/` with the repository's strict compiler. Regenerate into a new location following `schematics/tooling/BLUEPRINT_TOOLING.md`; never overwrite provenance casually. Strict content validation is not proof of live placement on other versions or servers. The image uses a separate CI dependency lock rather than the developer's ignored root lockfile. The upstream image tags and server artifacts can still change.

**Mineflayer patch compatibility:** postinstall fails if any patch fails or if either the schematic cancellation checks or exact patched Mineflayer 4.39.0 digging source is missing. The inherited item-use rotation is already upstream. Upstream eye-level water calculation and its Aqua Affinity handling are retained rather than disabling the water penalty; waterlogged and unloaded eye-level blocks remain subject to upstream limitations. Placement keeps the upstream five-second timeout and reference/destination acknowledgement logic: an acknowledged refusal fails promptly, while a 500 ms timeout would misclassify slow replies. The material correction applies only to direct members of the Java 1.21.4 pickaxe tag that the locked data labels `incorrect_for_wooden_tool`, without mutating the block. The pinned tag source is [misode/mcmeta at 277751c76153ac1a084813188ac7ceea2028b625](https://github.com/misode/mcmeta/blob/277751c76153ac1a084813188ac7ceea2028b625/data/minecraft/tags/block/mineable/pickaxe.json). Other versions and unknown names use upstream estimates; they may be slower or inaccurate until independently reviewed. This does not change harvestability. Re-review the tag, patch and verifier digest when upgrading Mineflayer or supported versions.

**Minecraft protocol compatibility:** the inherited `minecraft-data` 3.97.0 patch was a no-op against the unmodified 3.119.0 CI package: both 1.21.6 serverbound chat checksum fields are already `u8` upstream. It was removed rather than renamed. Postinstall now verifies the exact 1.21.6 data and both unsigned checksum fields; tests also round-trip checksum values 0, 127, 128 and 255 through the protocol serializer and parser. This checks only those fields, not every registry or protocol behavior. Re-review upstream data if verification fails after an upgrade; do not silently change protocol versions or signedness to pass it.

## Dependency audit limitations

On 2026-11-25, the CI lock audit changed from 22 affected packages (17 moderate, 4 high, 1 critical) to 21 (19 moderate, 2 high, 0 critical) after a clean install. Counts are affected packages, including propagated findings, not individual advisory counts, and change with the advisory database. The remaining high finding is Zod's oversized-collection memory exhaustion, propagated to OpenAI; moderate findings include UUID through Minecraft authentication and glob through the build cache. Audit fixability alone does not establish compatibility.

The `gl` install script invokes the `node-gyp` CLI. Its scoped override moves the CLI from 10.3.1 to 11.5.0, outside `gl`'s declared 10.x range; the latter supports Node ^18.17 or >=20.5, including the Node 22 CI runtime. It brings both build-tool `tar` consumers onto locked 7.5.23, which is outside the reported vulnerable ranges, instead of blindly replacing their declared tar 6 APIs. npm hoists this CLI in the tested install, so the `canvas` source-build fallback also uses it. A clean forced source build compiled both native modules, and the full gate passed. This is still an override across a declared major boundary, not an upstream compatibility promise: retest native compilation, header downloading, the CI image and supported Node versions when upgrading `gl`, `node-gyp` or the lock, and remove the override when upstream supplies a safe compatible toolchain. The existing locked Minecraft protocol dependency itself requires Node >=22.

OpenAI 4's optional Zod peer requires 3.x, while the Mistral SDK also uses Zod and imports its `zod/v3` API. The fixed advisory version is 4.6.6; forcing it underneath those consumers would violate OpenAI's peer range and does not establish that the embedded v3 API is fixed. A safe remediation requires an independently tested OpenAI/SDK and schema migration, including all configured providers and actual schema usage, rather than a cosmetic audit reduction. UUID fixes similarly require compatible authentication upstream changes. Avoid untrusted archives and inputs, use isolated builds and least privilege, and re-run the audit as upstream versions change; these precautions do not eliminate remaining vulnerabilities. Do not use `--force` as a substitute for a tested migration.

Normal startup uses the root settings file and both profiles with one MindServer. `MINECRAFT_HOST`, `MINECRAFT_PORT`, JSON `PROFILES`, CLI `--profiles`, and `SETTINGS_JSON` support test overrides; `SETTINGS_JSON` is applied last. The unified Compose launcher shares the same server instead of starting two competing instances.
