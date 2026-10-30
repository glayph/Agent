#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="$ROOT_DIR/deploy/systemd"
INSTALL_DIR="/usr/local/libexec"
UNIT_DIR="/etc/systemd/system"
ENV_DIR="/etc/miki"
ENV_FILE="$ENV_DIR/miki.env"
NODE_BIN="${MIKI_NODE:-}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$NODE_BIN" && -n "${SUDO_USER:-}" ]]; then
  NODE_BIN="$(sudo -u "$SUDO_USER" -H bash -lc 'command -v node' 2>/dev/null || true)"
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Unable to locate an executable Node.js binary. Set MIKI_NODE=/absolute/path/to/node." >&2
  exit 1
fi

usage() {
  cat <<'USAGE'
Usage: sudo scripts/install-systemd.sh [install|start|stop|restart|status|uninstall]

install   Install units and health checker, but do not start services.
start     Enable and start the Miki target and health timer.
stop      Stop the target and health timer.
restart   Restart the target without deleting state or logs.
status    Show target, timer, and service status.
uninstall Stop and remove installed units; keep /etc/miki/miki.env and project data.
USAGE
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Run this script with sudo." >&2
    exit 1
  fi
}

# Escape a value for use as a sed replacement (with # as the delimiter).
sed_escape() { printf '%s' "$1" | sed -e 's/[\\#&]/\\&/g'; }

render_file() {
  local source="$1" target="$2"
  sed \
    -e "s#@MIKI_ROOT@#$(sed_escape "$ROOT_DIR")#g" \
    -e "s#@MIKI_NODE@#$(sed_escape "$NODE_BIN")#g" \
    -e "s#@MIKI_NODE_BIN_DIR@#$(sed_escape "$NODE_BIN_DIR")#g" \
    -e "s#@MIKI_USER@#$(sed_escape "$SERVICE_USER")#g" \
    -e "s#@MIKI_GROUP@#$(sed_escape "$SERVICE_GROUP")#g" \
    -e "s#@MIKI_HOME@#$(sed_escape "$SERVICE_HOME")#g" \
    "$source" > "$target"
}

# The units run as the desktop user that invoked sudo (Miki drives that user's session).
resolve_service_identity() {
  SERVICE_USER="${MIKI_SERVICE_USER:-${SUDO_USER:-}}"
  if [[ -z "$SERVICE_USER" || "$SERVICE_USER" == "root" ]]; then
    echo "Run with sudo from the desktop user's account, or set MIKI_SERVICE_USER=<user>; refusing to run Miki as root." >&2
    exit 1
  fi
  id -u "$SERVICE_USER" >/dev/null 2>&1 || { echo "Unknown user: $SERVICE_USER" >&2; exit 1; }
  SERVICE_GROUP="${MIKI_SERVICE_GROUP:-$(id -gn "$SERVICE_USER")}"
  SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
  SERVICE_HOME="${SERVICE_HOME:-/home/$SERVICE_USER}"
  NODE_BIN_DIR="$(dirname "$NODE_BIN")"
}

install_stack() {
  require_root
  resolve_service_identity
  install -d -m 0750 "$ROOT_DIR/data" "$ROOT_DIR/logs" "$ROOT_DIR/config"
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$ROOT_DIR/data" "$ROOT_DIR/logs" "$ROOT_DIR/config" 2>/dev/null || true
  install -d -m 0755 "$UNIT_DIR" "$INSTALL_DIR" "$ENV_DIR"
  # Memory is hosted in-process by the gateway; retire the former health-only stub unit.
  systemctl disable --now miki-memory.service 2>/dev/null || true
  rm -f "$UNIT_DIR/miki-memory.service"
  if [[ ! -e "$ENV_FILE" ]]; then
    render_file "$SYSTEMD_DIR/miki.env.example" "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    echo "Created $ENV_FILE; review model paths before starting."
  elif grep -q '^MIKI_NODE=/usr/bin/node$' "$ENV_FILE"; then
    sed -i "s#^MIKI_NODE=.*#MIKI_NODE=$NODE_BIN#" "$ENV_FILE"
  fi

  for unit in miki.target miki-llama.service miki-core.service miki-gateway.service miki-health.service miki-health.timer; do
    render_file "$SYSTEMD_DIR/$unit" "$UNIT_DIR/$unit"
  done
  install -m 0755 "$SYSTEMD_DIR/miki-healthcheck.sh" "$INSTALL_DIR/miki-healthcheck"
  systemctl daemon-reload
  systemctl enable miki.target miki-health.timer
  echo "Miki systemd stack installed. Use: sudo systemctl start miki.target"
}

stop_stack() {
  require_root
  systemctl stop miki-health.timer miki.target 2>/dev/null || true
}

case "${1:-install}" in
  install) install_stack ;;
  start) install_stack; systemctl start miki.target miki-health.timer ;;
  stop) stop_stack ;;
  restart) stop_stack; systemctl start miki.target miki-health.timer ;;
  status) systemctl --no-pager --full status miki.target miki-health.timer miki-llama.service miki-core.service miki-gateway.service ;;
  uninstall)
    stop_stack
    require_root
    for unit in miki.target miki-memory.service miki-llama.service miki-core.service miki-gateway.service miki-health.service miki-health.timer; do
      systemctl disable "$unit" 2>/dev/null || true
      rm -f "$UNIT_DIR/$unit"
    done
    rm -f "$INSTALL_DIR/miki-healthcheck"
    systemctl daemon-reload
    echo "Units removed; project data, logs, and $ENV_FILE were retained."
    ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
