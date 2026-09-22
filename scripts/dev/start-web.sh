#!/bin/sh
set -eu

ROOT_DIR="$1"
ENV_NAME="$2"

. "$ROOT_DIR/scripts/dev/load-env.sh" "$ROOT_DIR" "$ENV_NAME"

mkdir -p "$ROOT_DIR/.taskpids" "$ROOT_DIR/logs"
cd "$ROOT_DIR/apps/web"

nohup pnpm dev < /dev/null > "$ROOT_DIR/logs/web.log" 2>&1 &
echo $! > "$ROOT_DIR/.taskpids/web.pid"
echo "web starting (ENV=$ENV_NAME, pid $!) — http://localhost:3000, log: logs/web.log"
