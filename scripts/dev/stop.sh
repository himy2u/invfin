#!/bin/sh
set -eu

ROOT_DIR="$1"
SVC="$2"

f="$ROOT_DIR/.taskpids/$SVC.pid"

if [ ! -f "$f" ]; then
  echo "$SVC: not running (no pidfile)"
  exit 0
fi

pid=$(cat "$f")

if ! kill -0 "$pid" 2>/dev/null; then
  echo "$SVC: not running (stale pidfile)"
  rm -f "$f"
  exit 0
fi

# Dev tooling (expo/npm, uvicorn --reload) spawns children, and reload wrappers can spawn
# grandchildren pkill -P alone won't reach — walk the whole tree, not just one level, or a
# leftover process holds the port and the next start fails with "address already in use".
kill_tree() {
  for child in $(pgrep -P "$1" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$1" 2>/dev/null || true
}
kill_tree "$pid"

rm -f "$f"
echo "$SVC: stopped (pid $pid)"
