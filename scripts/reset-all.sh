#!/bin/bash
# Development helper: removes EVERY container on this machine, the unused Docker networks,
# and the runtime data of all sessions.
# Uses DATA_DIR from .env (the same setting the runner uses), or ./data in the repository.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$ROOT_DIR/.env" ]; then
    set -a
    . "$ROOT_DIR/.env"
    set +a
fi

DATA_DIR="${DATA_DIR:-$ROOT_DIR/data}"

docker rm -f $(docker ps -aq) 2>/dev/null
docker network prune -f
rm -rf "$DATA_DIR"/sessions/* "$DATA_DIR"/state/*
echo "Clean slate."
