#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# A distinct project isolates concurrent runs and makes down -v safe.
export COMPOSE_PROJECT_NAME="mindcraft-schematics-$$"
cleanup() {
    status=$?
    trap - EXIT
    if ! docker compose -f ci/docker-compose.test.yml down -v --remove-orphans; then
        echo "Cleanup failed for Compose project $COMPOSE_PROJECT_NAME; inspect it manually." >&2
        [ "$status" -ne 0 ] || status=1
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker compose -f ci/docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from bot-tester
