#!/bin/sh
# Resolve the helper relative to this script, not the caller's working directory.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec python3 "$script_dir/compile_pack.py" "$@"
