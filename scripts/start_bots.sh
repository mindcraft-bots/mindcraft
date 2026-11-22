#!/bin/sh

set -e

case ${1-} in
    --help|-h)
        printf '%s\n' 'Usage: start_bots.sh' 'Recreate and start the bot-andy and bot-alice Compose services in the foreground.'
        exit 0
        ;;
esac

docker compose up --force-recreate bot-andy bot-alice
