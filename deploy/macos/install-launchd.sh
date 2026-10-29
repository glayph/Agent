#!/usr/bin/env bash
# Installs Agent Miki as a per-user launchd agent on macOS (always on, restarted by launchd after any exit).
# Usage: install-launchd.sh [--dry-run] [--uninstall]
set -euo pipefail

APP_ROOT="${MIKI_APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
LABEL="${MIKI_LAUNCHD_LABEL:-com.miki.agent-24-7}"
LOG_DIR="${MIKI_LOG_DIR:-$HOME/Library/Logs/agent-miki}"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"
TEMPLATE="$APP_ROOT/deploy/macos/com.miki.agent-24-7.plist.template"
DRY_RUN=0
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --help|-h) sed -n '2,3p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

run() {
  printf '+ %s\n' "$*"
  if (( ! DRY_RUN )); then "$@"; fi
}

if (( UNINSTALL )); then
  run launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  run rm -f "$PLIST"
  echo "Agent Miki launchd agent removed. Your workspace and data were not touched."
  exit 0
fi

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "Node.js is required (node not found on PATH)." >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "Template missing: $TEMPLATE" >&2; exit 1; }

# Render the template with XML-escaped values. Node is already a requirement, so no other tool is needed.
RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT
node -e '
const fs = require("fs");
const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const values = { LABEL: process.argv[2], APP_ROOT: process.argv[3], NODE: process.argv[4], PATH: process.env.PATH || "/usr/bin:/bin", LOG_DIR: process.argv[5] };
let text = fs.readFileSync(process.argv[1], "utf8");
for (const [key, value] of Object.entries(values)) text = text.split("@" + key + "@").join(esc(value));
fs.writeFileSync(process.argv[6], text);
' "$TEMPLATE" "$LABEL" "$APP_ROOT" "$NODE_BIN" "$LOG_DIR" "$RENDERED"

if (( DRY_RUN )); then
  echo "Dry run: rendered agent (not installed):"
  cat "$RENDERED"
  exit 0
fi

mkdir -p "$AGENT_DIR" "$LOG_DIR"
cp "$RENDERED" "$PLIST"
chmod 644 "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
echo "Agent Miki is installed as $LABEL and starts at login. Logs: $LOG_DIR"
