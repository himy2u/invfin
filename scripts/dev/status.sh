#!/bin/sh
set -eu

ROOT_DIR="$1"

for svc in web agent mobile mobile-web; do
  f="$ROOT_DIR/.taskpids/$svc.pid"
  if [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null; then
    echo "$svc: RUNNING (pid $(cat "$f"))"
  else
    echo "$svc: stopped"
  fi
done
