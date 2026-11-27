#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec node ci/quality_gate.mjs "$@"
