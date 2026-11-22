# Project scripts

Scripts in this directory use `<action>_<scope>.<extension>`: the first component
is a verb, the second identifies what it acts on, and the extension identifies
the interpreter. Shell and Node entry points are executable and have shebangs.

| Previous name | Current name | Purpose |
| --- | --- | --- |
| `build.sh` | [`build_bots.sh`](build_bots.sh) | Build the two bot Compose images. |
| `get-logs.sh` | [`get_logs.sh`](get_logs.sh) | Show bot Compose status and recent logs. |
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

The separate executable [`compile_pack.sh`](../schematics/tooling/compile_pack.sh)
uses the same action/scope convention. From the project root, invoke it as
`schematics/tooling/compile_pack.sh pack1 26.1`; it stages versioned outputs,
never overwrites an existing variant or report, and does not modify the original
assets. See the [compiler guide](../schematics/tooling/BLUEPRINT_TOOLING.md) for
dependencies, 1.21.4, collision handling, and partial-publication limitations.
