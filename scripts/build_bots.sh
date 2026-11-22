#!/bin/sh

set -e

case ${1-} in
    --help|-h)
        printf '%s\n' 'Usage: build_bots.sh' 'Build the bot-andy and bot-alice Compose images.'
        exit 0
        ;;
esac

docker compose build bot-andy bot-alice
