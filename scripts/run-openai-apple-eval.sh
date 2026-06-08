#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SECRET_FILE="/Users/richardgentry/.codex/secrets/openai-apple-assistant-eval.env"

if [ ! -f "$SECRET_FILE" ]; then
  echo "Missing OpenAI eval key file: $SECRET_FILE" >&2
  exit 1
fi

set -a
. "$SECRET_FILE"
set +a

cd "$REPO_ROOT"
exec node scripts/openai-apple-eval.mjs "$@"
