#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${MIKI_SERVICE_NAME:-agent-miki}"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
KEEP_DATA=1
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: uninstall-systemd.sh [--remove-data] [--dry-run]

Stops and disables the Agent Miki systemd unit and removes its unit file.
Data is preserved by default. --remove-data is destructive and must be
explicitly selected.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --remove-data) KEEP_DATA=0 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if (( ! DRY_RUN )) && [[ "$(id -u)" != "0" ]]; then
  echo "Run as root or use --dry-run." >&2
  exit 1
fi

run() {
  printf '+ '
  printf '%q ' "$@"
  printf '\n'
  if (( ! DRY_RUN )); then "$@"; fi
}

run systemctl disable --now "$SERVICE_NAME.service"
if [[ -e "$UNIT_FILE" ]]; then run rm -f "$UNIT_FILE"; fi
run systemctl daemon-reload

if (( KEEP_DATA == 0 )); then
  DATA_ROOT="${MIKI_DATA_ROOT:-/var/lib/agent-miki}"
  echo "Data removal requested for: $DATA_ROOT"
  run rm -rf -- "$DATA_ROOT"
fi

if (( DRY_RUN )); then
  echo "Dry run passed. No services or files were changed."
else
  echo "Uninstalled $SERVICE_NAME. Data was $([[ $KEEP_DATA -eq 1 ]] && echo preserved || echo removed)."
fi
