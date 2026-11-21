#!/bin/sh

set -e

docker compose ps bot-andy bot-alice
docker compose logs --tail=100 bot-andy bot-alice
