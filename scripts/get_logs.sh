#!/bin/sh

set -e

case ${1-} in
    --help|-h)
        printf '%s\n' 'Usage: get_logs.sh' 'Show Compose status and the last 100 log lines for bot-andy and bot-alice.'
        exit 0
        ;;
esac

docker compose ps bot-andy bot-alice
docker compose logs --tail=100 bot-andy bot-alice
