#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${MIKI_APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
INSTALL_ROOT="${MIKI_INSTALL_ROOT:-/opt/agent-miki}"
WORKSPACE_DIR="${MIKI_WORKSPACE_DIR:-$INSTALL_ROOT/workspace}"
RUNTIME_ROOT="${MIKI_RUNTIME_ROOT:-$INSTALL_ROOT/runtime}"
DATA_DIR="${MIKI_DATA_DIR:-$RUNTIME_ROOT/data}"
LOG_DIR="${MIKI_LOG_DIR:-/var/log/agent-miki}"
ENV_FILE="${MIKI_ENV_FILE:-/etc/agent-miki/agent-miki.env}"
SERVICE_USER="${MIKI_SERVICE_USER:-agent-miki}"
SERVICE_GROUP="${MIKI_SERVICE_GROUP:-agent-miki}"
SERVICE_NAME="${MIKI_SERVICE_NAME:-agent-miki}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: install-systemd.sh [--dry-run]

Installs Agent Miki under systemd without storing provider credentials in the
unit or repository. Set MIKI_* environment variables to customize paths.
The normal mode creates the service user/directories, renders the unit, reloads
systemd, enables the service, and starts it.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

fail() { echo "agent-miki install: $*" >&2; exit 1; }
run() {
  printf '+ '
  printf '%q ' "$@"
  printf '\n'
  if (( ! DRY_RUN )); then "$@"; fi
}

if (( ! DRY_RUN )); then
  [[ "$(id -u)" == "0" ]] || fail "run as root or use --dry-run for inspection"
fi
[[ -f "$APP_ROOT/bin/miki.js" ]] || fail "missing launcher: $APP_ROOT/bin/miki.js"
[[ -f "$APP_ROOT/package.json" ]] || fail "missing package manifest: $APP_ROOT/package.json"
command -v node >/dev/null || fail "node is required"

UNIT_TEMPLATE="$APP_ROOT/deploy/linux/systemd/agent-miki.service.in"
[[ -f "$UNIT_TEMPLATE" ]] || fail "missing unit template: $UNIT_TEMPLATE"

run install -d -m 0755 "$INSTALL_ROOT" "$WORKSPACE_DIR" "$RUNTIME_ROOT" "$DATA_DIR" "$LOG_DIR" "$(dirname "$ENV_FILE")"
run getent group "$SERVICE_GROUP" || groupadd --system "$SERVICE_GROUP"
run id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --gid "$SERVICE_GROUP" --home-dir "$INSTALL_ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
run chown -R "$SERVICE_USER:$SERVICE_GROUP" "$WORKSPACE_DIR" "$RUNTIME_ROOT" "$LOG_DIR"
run chmod 0750 "$WORKSPACE_DIR" "$RUNTIME_ROOT" "$DATA_DIR" "$LOG_DIR"

if (( DRY_RUN )); then
  echo "Would copy application from $APP_ROOT to $INSTALL_ROOT/app"
  echo "Would create protected environment file at $ENV_FILE without credentials"
else
  install -d -m 0755 "$INSTALL_ROOT/app"
  cp -a "$APP_ROOT/." "$INSTALL_ROOT/app/"
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_ROOT/app"
  chmod 0750 "$INSTALL_ROOT/app"
  if [[ ! -e "$ENV_FILE" ]]; then
    umask 077
    cat > "$ENV_FILE" <<EOF
MIKI_SOURCE_ROOT=$INSTALL_ROOT/app
MIKI_WORKSPACE_DIR=$WORKSPACE_DIR
MIKI_RUNTIME_ROOT=$RUNTIME_ROOT
MIKI_24_7_MAX_RESTARTS=5
MIKI_24_7_ALLOW_UNLIMITED_RESTARTS=false
MIKI_24_7_READY_TIMEOUT_MS=45000
EOF
  fi
  chmod 0600 "$ENV_FILE"
fi

UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"
if (( DRY_RUN )); then
  echo "Would render $UNIT_FILE from $UNIT_TEMPLATE"
else
  sed \
    -e "s|@MIKI_USER@|$SERVICE_USER|g" \
    -e "s|@MIKI_GROUP@|$SERVICE_GROUP|g" \
    -e "s|@MIKI_APP_ROOT@|$INSTALL_ROOT/app|g" \
    -e "s|@MIKI_ENV_FILE@|$ENV_FILE|g" \
    -e "s|@MIKI_WORKSPACE_DIR@|$WORKSPACE_DIR|g" \
    -e "s|@MIKI_RUNTIME_ROOT@|$RUNTIME_ROOT|g" \
    -e "s|@MIKI_LOG_DIR@|$LOG_DIR|g" \
    "$UNIT_TEMPLATE" > "$UNIT_FILE"
  chmod 0644 "$UNIT_FILE"
fi

run systemctl daemon-reload
run systemctl enable "$SERVICE_NAME.service"
run systemctl start "$SERVICE_NAME.service"

if (( DRY_RUN )); then
  echo "Dry run passed. No files or services were changed."
else
  echo "Installed $SERVICE_NAME. Verify with: systemctl status $SERVICE_NAME --no-pager"
fi
