#!/usr/bin/env bash
set -euo pipefail

KEYFILE="$HOME/.voice-pr/cursor-api-key"
[ -s "$KEYFILE" ] || {
  printf 'CURSOR_API_KEY file missing: %s\n' "$KEYFILE" >&2
  exit 1
}
chmod 600 "$KEYFILE"
export CURSOR_API_KEY
CURSOR_API_KEY="$(tr -d '\n' < "$KEYFILE")"

exec "$1" "$2"
