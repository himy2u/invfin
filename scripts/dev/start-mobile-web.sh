#!/bin/sh
set -eu

ROOT_DIR="$1"
ENV_NAME="$2"

. "$ROOT_DIR/scripts/dev/load-env.sh" "$ROOT_DIR" "$ENV_NAME"

mkdir -p "$ROOT_DIR/.taskpids" "$ROOT_DIR/logs"
cd "$ROOT_DIR/apps/mobile"

nohup npx expo start --web --port 19006 < /dev/null > "$ROOT_DIR/logs/mobile-web.log" 2>&1 &
echo $! > "$ROOT_DIR/.taskpids/mobile-web.pid"
echo "mobile-web starting (ENV=$ENV_NAME, pid $!) — http://localhost:19006, log: logs/mobile-web.log"
