#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${MIKI_APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
INSTALL_ROOT="${MIKI_INSTALL_ROOT:-/opt/agent-miki}"
WORKSPACE_DIR="${MIKI_WORKSPACE_DIR:-$INSTALL_ROOT/workspace}"
RUNTIME_ROOT="${MIKI_RUNTIME_ROOT:-$INSTALL_ROOT/runtime}"
DATA_DIR="${MIKI_DATA_DIR:-$RUNTIME_ROOT/data}"
LOG_DIR="${MIKI_LOG_DIR:-/var/log/agent-miki}"
ENV_FILE="${MIKI_ENV_FILE:-/etc/agent-miki/agent-miki.env}"
# Miki drives a desktop, so by default it runs as the desktop user that invoked sudo.
DEFAULT_USER="agent-miki"
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then DEFAULT_USER="$SUDO_USER"; fi
SERVICE_USER="${MIKI_SERVICE_USER:-$DEFAULT_USER}"
if [[ -n "${MIKI_SERVICE_GROUP:-}" ]]; then
  SERVICE_GROUP="$MIKI_SERVICE_GROUP"
else
  SERVICE_GROUP="$(id -gn "$SERVICE_USER" 2>/dev/null || echo "$SERVICE_USER")"
fi
SERVICE_HOME="$(getent passwd "$SERVICE_USER" 2>/dev/null | cut -d: -f6 || true)"
SERVICE_HOME="${SERVICE_HOME:-$INSTALL_ROOT}"
DISPLAY_NAME="${MIKI_DISPLAY:-:0}"
XAUTH_FILE="${MIKI_XAUTHORITY:-$SERVICE_HOME/.Xauthority}"
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
for runtime_file in \
  packages/gateway/dist/index.js \
  packages/core/dist/api/index.js \
  packages/config/dist/index.js \
  packages/installer/dist/index.js \
  packages/skills/dist/index.js \
  packages/ui/frontend/dist/index.html; do
  [[ -f "$APP_ROOT/$runtime_file" ]] ||
    fail "missing build artifact: $APP_ROOT/$runtime_file; run npm run build:all first"
done
NODE_BIN="${MIKI_NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail "node is required; set MIKI_NODE_BIN to an absolute executable path"

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

  # The gateway reads config/agent.yaml from MIKI_CONFIG_DIR (and identity files
  # from MIKI_WORKSPACE_DIR). The code lives in app/, while mutable state lives
  # in the separate workspace. Seed these files once without overwriting an
  # existing user's configuration or identity on upgrades.
  install -d -m 0750 "$WORKSPACE_DIR/config" "$WORKSPACE_DIR/identity"
  cp -a -n "$INSTALL_ROOT/app/config/." "$WORKSPACE_DIR/config/"
  cp -a -n "$INSTALL_ROOT/app/identity/." "$WORKSPACE_DIR/identity/"
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$WORKSPACE_DIR/config" "$WORKSPACE_DIR/identity"

  if [[ ! -e "$ENV_FILE" ]]; then
    umask 077
    cat > "$ENV_FILE" <<EOF
MIKI_SOURCE_ROOT=$INSTALL_ROOT/app
MIKI_WORKSPACE_DIR=$WORKSPACE_DIR
MIKI_RUNTIME_ROOT=$INSTALL_ROOT/app
MIKI_CONFIG_DIR=$WORKSPACE_DIR/config
MIKI_DATA_DIR=$WORKSPACE_DIR/data
MIKI_24_7_MAX_RESTARTS=5
MIKI_24_7_ALLOW_UNLIMITED_RESTARTS=true
MIKI_24_7_READY_TIMEOUT_MS=45000
EOF
  else
    # Preserve any custom env values, but repair paths absent from older env files.
    grep -q '^MIKI_SOURCE_ROOT=' "$ENV_FILE" || printf 'MIKI_SOURCE_ROOT=%s/app\n' "$INSTALL_ROOT" >> "$ENV_FILE"
    grep -q '^MIKI_WORKSPACE_DIR=' "$ENV_FILE" || printf 'MIKI_WORKSPACE_DIR=%s\n' "$WORKSPACE_DIR" >> "$ENV_FILE"
    grep -q '^MIKI_RUNTIME_ROOT=' "$ENV_FILE" || printf 'MIKI_RUNTIME_ROOT=%s/app\n' "$INSTALL_ROOT" >> "$ENV_FILE"
    grep -q '^MIKI_CONFIG_DIR=' "$ENV_FILE" || printf 'MIKI_CONFIG_DIR=%s/config\n' "$WORKSPACE_DIR" >> "$ENV_FILE"
    grep -q '^MIKI_DATA_DIR=' "$ENV_FILE" || printf 'MIKI_DATA_DIR=%s/data\n' "$WORKSPACE_DIR" >> "$ENV_FILE"
  fi
  chmod 0600 "$ENV_FILE"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$ENV_FILE"
fi

# computer_* tools on Linux use X11 + xdotool (Wayland is not supported).
if ! command -v xdotool >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    run apt-get install -y xdotool || echo "agent-miki install: could not install xdotool; computer_* UI actions will fail until it is installed" >&2
  else
    echo "agent-miki install: xdotool not found; install it with your package manager for computer_* UI actions" >&2
  fi
fi

UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"
if (( DRY_RUN )); then
  echo "Would render $UNIT_FILE from $UNIT_TEMPLATE"
else
  sed \
    -e "s|@MIKI_NODE_BIN@|$NODE_BIN|g" \
    -e "s|@MIKI_USER@|$SERVICE_USER|g" \
    -e "s|@MIKI_GROUP@|$SERVICE_GROUP|g" \
    -e "s|@MIKI_APP_ROOT@|$INSTALL_ROOT/app|g" \
    -e "s|@MIKI_ENV_FILE@|$ENV_FILE|g" \
    -e "s|@MIKI_WORKSPACE_DIR@|$WORKSPACE_DIR|g" \
    -e "s|@MIKI_RUNTIME_ROOT@|$INSTALL_ROOT/app|g" \
    -e "s|@MIKI_LOG_DIR@|$LOG_DIR|g" \
    -e "s|@MIKI_DISPLAY@|$DISPLAY_NAME|g" \
    -e "s|@MIKI_XAUTHORITY@|$XAUTH_FILE|g" \
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
