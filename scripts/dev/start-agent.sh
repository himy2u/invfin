#!/bin/sh
set -eu

ROOT_DIR="$1"
ENV_NAME="$2"

. "$ROOT_DIR/scripts/dev/load-env.sh" "$ROOT_DIR" "$ENV_NAME"

mkdir -p "$ROOT_DIR/.taskpids" "$ROOT_DIR/logs"
cd "$ROOT_DIR/services/agent"

nohup uv run uvicorn main:app --host 0.0.0.0 --port 8000 --reload < /dev/null > "$ROOT_DIR/logs/agent.log" 2>&1 &
echo $! > "$ROOT_DIR/.taskpids/agent.pid"
echo "agent starting (ENV=$ENV_NAME, pid $!) — http://localhost:8000, log: logs/agent.log"
