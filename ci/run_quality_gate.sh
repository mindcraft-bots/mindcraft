#!/bin/sh
# Logs may contain sensitive test output; keep the newly created directory private.
set -u
cd "$(dirname "$0")/.." || exit 1
mode=${1:-full}
if [ "$#" -gt 1 ] || { [ "$mode" != fast ] && [ "$mode" != full ]; }; then
    echo 'Usage: ci/run_quality_gate.sh [fast|full]' >&2
    exit 2
fi
umask 077
logs=$(mktemp -d "${TMPDIR:-/tmp}/mindcraft-quality-gate.XXXXXXXX") || exit 1
printf 'Private logs: %s\n' "$logs"
failed=0
run_check() {
    name=$1
    shift
    printf '\n--- %s ---\n' "$name"
    if "$@" > "$logs/$name.log" 2>&1; then
        printf 'PASS: %s\n' "$name"
    else
        status=$?
        printf 'FAIL: %s (exit %s)\n' "$name" "$status"
        failed=1
    fi
    tail -n 15 "$logs/$name.log"
}
trap 'echo "Interrupted; logs: $logs" >&2; exit 130' INT
trap 'echo "Interrupted; logs: $logs" >&2; exit 143' TERM
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    run_check diff-check git diff --check
else
    echo 'SKIP: diff-check (not a Git checkout)'
fi
run_check patches node scripts/verify_patch.js
run_check root-tests node --test test/*.test.js
run_check schematic-tests npm run test:schematic
if [ "$mode" = full ]; then
    if command -v task >/dev/null 2>&1; then
        run_check live-schematics task test:schematics
    else
        run_check live-schematics make test-schematics
    fi
else
    echo 'FAST ONLY: live schematic CI was not run; this is not the mandatory full gate.'
fi
printf '\nLogs: %s\n' "$logs"
if [ "$failed" -ne 0 ]; then
    echo 'Quality gate FAILED.' >&2
    exit 1
fi
if [ "$mode" = full ]; then echo 'Full quality gate PASSED.'; else echo 'Fast checks PASSED (full gate still required).'; fi
