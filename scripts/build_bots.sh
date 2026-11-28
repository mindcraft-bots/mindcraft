#!/bin/sh

set -e

case ${1-} in
    --help|-h)
        printf '%s\n' 'Usage: build_bots.sh' 'Build the unified bots Compose image.'
        exit 0
        ;;
esac

docker compose build bots
