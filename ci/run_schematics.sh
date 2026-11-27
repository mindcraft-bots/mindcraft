#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Random names also isolate concurrent clients on different hosts sharing a daemon.
token_dir=$(mktemp -d "${TMPDIR:-/tmp}/mindcraft-compose-XXXXXXXX")
token=${token_dir##*/mindcraft-compose-}
export COMPOSE_PROJECT_NAME="mindcraft-schematics-$(printf '%s' "$token" | tr '[:upper:]' '[:lower:]')"
rmdir "$token_dir"
cleanup() {
    status=$?
    trap - EXIT
    if ! docker compose -f ci/docker-compose.test.yml down --rmi local -v --remove-orphans; then
        echo "Cleanup failed for Compose project $COMPOSE_PROJECT_NAME; inspect it manually." >&2
        [ "$status" -ne 0 ] || status=1
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker compose -f ci/docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from bot-tester
