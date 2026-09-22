#!/bin/sh
set -eu

ROOT_DIR="$1"
ENV_NAME="$2"

. "$ROOT_DIR/scripts/dev/load-env.sh" "$ROOT_DIR" "$ENV_NAME"

mkdir -p "$ROOT_DIR/.taskpids" "$ROOT_DIR/logs"
cd "$ROOT_DIR/apps/mobile"

nohup npx expo start < /dev/null > "$ROOT_DIR/logs/mobile.log" 2>&1 &
echo $! > "$ROOT_DIR/.taskpids/mobile.pid"
echo "mobile/Metro starting (ENV=$ENV_NAME, pid $!) — logs/mobile.log (QR/URL appear there once Metro is ready)"
