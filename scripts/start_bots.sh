#!/bin/sh

set -e

case ${1-} in
    --help|-h)
        printf '%s\n' 'Usage: start_bots.sh' 'Recreate and start the unified bots Compose service in the foreground.'
        exit 0
        ;;
    '') ;;
    *) printf '%s\n' 'Usage: start_bots.sh' >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."
exec docker compose up --force-recreate bots
