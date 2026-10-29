#!/usr/bin/env bash
# Starts the 24/7 supervisor (scripts/miki-24-7.mjs) for launchd on macOS.
# launchd runs with a minimal environment, so this wrapper loads the optional
# env file (provider keys live there, never in the plist) and uses the Node path
# the installer recorded.
set -euo pipefail

APP_ROOT="${MIKI_APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ENV_FILE="${MIKI_ENV_FILE:-$HOME/.config/agent-miki/env}"
NODE_BIN="${MIKI_NODE:-$(command -v node || true)}"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "agent-miki: Node.js not found. Set MIKI_NODE to the node binary." >&2
  exit 1
fi
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

cd "$APP_ROOT"
exec "$NODE_BIN" scripts/miki-24-7.mjs
