# Project scripts

Scripts in this directory use `<action>_<scope>.<extension>`: the first component
is a verb, the second identifies what it acts on, and the extension identifies
the interpreter. Shell, Python, and Node entry points are executable and have shebangs.

| Previous name | Current name | Purpose |
| --- | --- | --- |
| `build.sh` | [`build_bots.sh`](build_bots.sh) | Build the two bot Compose images. |
| `get-logs.sh` | [`get_logs.sh`](get_logs.sh) | Show bot Compose status and recent logs. |
| `collect_bot_diagnostics.sh`, `collect_diagnostics.sh` | [`collect_diagnostics.py`](collect_diagnostics.py) | Collect Compose logs, selected metadata, and sensitive bot history and prompt logs. |
| `start.sh` | [`start_bots.sh`](start_bots.sh) | Recreate and start the two bot services in the foreground. |
| `update.sh` | [`update_project.sh`](update_project.sh) | Safely check or fast-forward a checkout; see the [deployment guide](../schematics/README.md#safe-code-updates-and-docker-redeployment). |
| `verify-schematic-patch.js` | [`verify_patch.js`](verify_patch.js) | Verify the installed mineflayer-schem cancellation-safety patch. |

Update external shell aliases, automation, and direct invocations to the current
names. Old paths are removed rather than retained as nonconforming wrappers; an
updater running from the old path can finish its current fast-forward, but the
next invocation must use the new path. The `npm run postinstall`, `npm start`,
and test command names remain unchanged. The verifier remains runnable with
Node and is also executable directly; run it from the project root so it checks
that checkout's installed dependencies. The shell helpers provide `--help`
without invoking Docker or changing the checkout. Normal Docker helper calls
still operate on the Compose project selected by the caller's working directory.

## Collect bot incident diagnostics on the Docker host

Copy `collect_diagnostics.py` into the project's `scripts/` directory on the
external host, or use an accessible checkout there. Run it **on the host whose
Docker daemon contains the stopped containers**, from any working directory:

```sh
/path/to/mindcraft/scripts/collect_diagnostics.py
# Select another project and an optional separate output directory:
python3 /path/to/mindcraft/scripts/collect_diagnostics.py --project-directory '/path/to/compose project' --output-directory '/path/to/private output'
```

By default the project directory is the parent of the resolved script's
`scripts/` directory, independent of the working directory. If the script is
copied elsewhere, use `--project-directory DIR` to select the Compose project.
The default output directory is `tmp/` inside the selected project, including
when the project is overridden. `--output-directory DIR` selects a different
bundle parent. Both relative overrides are resolved against the invocation
working directory, not against the script or the selected project. Missing
output directories are created with owner-only permissions; existing directory
permissions are not changed. The output directory itself must not be a symlink;
symlinked ancestor directories are resolved. The collector reports an error if
the directory or a private bundle cannot be created.

If you previously copied `collect_bot_diagnostics.sh` or `collect_diagnostics.sh`
to the host, replace that copy with the current Python script and update any aliases
or automation to the new name. Neither old shell path is retained as a wrapper.

Use the same Docker context, Compose project name, Compose file selection and
other Compose configuration as the original deployment (for example,
`COMPOSE_PROJECT_NAME` or `COMPOSE_FILE` if used). Python 3, Docker CLI with
the Compose plugin, and permission to access the daemon and relevant mount
sources are required. This does not start, stop, or modify containers. It
discovers configured services (including enabled profiles), requests all
retained Compose logs with timestamps per service, and records IDs, image IDs,
configured image references, state and selected mount metadata for retained
running or stopped containers. The existing per-service log, ID, and metadata
filenames are preserved. It does not capture environment variables, credential
files, full inspect output, or interpolated Compose configuration. Docker
errors are shown on the terminal, not saved, as they too may be sensitive.

For each inspected `/app/bots` bind or named-volume mount, or a mount of a
parent such as `/app`, the collector reads the daemon-reported source on the
local host rather than assuming `./bots`. Under each bot name it collects only
`memory.json`, `histories/*.json`, and regular files recursively under `logs/`,
including nested task prompt logs. Shared sources are collected once; different
sources have separate numbered directories under `bot-data/`, preserving bot
and log paths. Symlinks and special files are not followed. Profiles, keys,
action code, schematics, dependencies, and Git objects outside the selected
diagnostic paths are not copied. Anything placed inside `logs/` is collected,
regardless of its name, so it still requires review. Sources must be locally
accessible: inaccessible volumes, remote or unverifiable Docker contexts,
container-only data, and nested mounts below `/app/bots` are reported as
incomplete rather than copied. In particular, run on the daemon host with a
local Unix-socket context and appropriate read permissions; Docker Desktop's
VM-managed paths may not be accessible even with a local socket. The collector
does not use privileged helper containers or copy entire container directories.

The printed output directory is a newly created, owner-only
`mindcraft-bot-diagnostics.XXXXXXXX` directory inside the selected output
directory; it is never reused, and existing outputs are not moved or modified.
**Bot memory, histories,
prompts and service logs can contain highly sensitive conversations, personal
data and credentials.** Review and redact every file before sharing, use
private encrypted transfer/storage, and never commit the bundle. The collector
uses owner-only permissions. It makes no size guarantee: retained service logs
and bot history may themselves be large. The status file inventories sources,
each copied file, shared mounts, missing optional data and errors; nonzero exit
means incomplete collection, with partial files retained. Optional services
without containers are noted without failing. Unmounted bot data in a service
not named with the `bot-` prefix cannot be identified automatically. Removed
or orphaned containers, rotated/deleted logs, and logs unavailable from the
configured logging driver cannot be recovered. Files can also change during
collection; this is not an atomic snapshot.

To make reviewed evidence accessible in `github.com/mindcraft-bots/mindcraft/tmp`,
copy only the reviewed output directory from the external host using your
normal secure transfer or shared mount, not the working environment. If an
archive is useful, create a private compressed archive of that reviewed output
directory only, verify its contents and permissions, and transfer it securely.
For example, after transferring it to the machine hosting that checkout, copy
the reviewed directory into
`github.com/mindcraft-bots/mindcraft/tmp` from the workspace root. Verify the
destination is visible in the devcontainer; the host Docker daemon and host
filesystem are not automatically available there. Keep the evidence uncommitted.
The collector tests can be run from the main checkout with
`node --test test/collect-bot-diagnostics.test.js`; they use a mock rather than
the host Docker daemon. If the Docker CLI is available, one test also uses it
with a local fake Engine API to check inspect template rendering.

The separate executable [`compile_pack.sh`](../schematics/tooling/compile_pack.sh)
uses the same action/scope convention. From the project root, invoke it as
`schematics/tooling/compile_pack.sh pack1 26.1`; it stages versioned outputs,
never overwrites an existing variant or report, and does not modify the original
assets. See the [compiler guide](../schematics/tooling/BLUEPRINT_TOOLING.md) for
dependencies, 1.21.4, collision handling, and partial-publication limitations.
