#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# A distinct project isolates concurrent runs and makes down -v safe.
export COMPOSE_PROJECT_NAME="mindcraft-schematics-$$"
cleanup() { docker compose -f ci/docker-compose.test.yml down -v --remove-orphans; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker compose -f ci/docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from bot-tester
