#!/bin/sh
# Sourced by the start-*.sh scripts. Sets $APP_ENV and loads .env.$1 (falling back to the
# committed .env.$1.example placeholder) into the current shell.
set -eu

ROOT_DIR="$1"
ENV_NAME="$2"

real="$ROOT_DIR/.env.$ENV_NAME"
example="$ROOT_DIR/.env.$ENV_NAME.example"

if [ -f "$real" ]; then
  set -a
  . "$real"
  set +a
elif [ -f "$example" ]; then
  echo "WARN: $real not found, using $example (placeholder values)" >&2
  set -a
  . "$example"
  set +a
else
  echo "WARN: no env file for ENV=$ENV_NAME, running with no extra env vars" >&2
fi

export APP_ENV="$ENV_NAME"
