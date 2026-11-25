#!/bin/sh

set -e

case ${1-} in
    --help|-h)
        printf '%s\n' 'Usage: get_logs.sh' 'Show Compose status and the last 100 log lines for bots.'
        exit 0
        ;;
esac

docker compose ps bots
docker compose logs --tail=100 bots
