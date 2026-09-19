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

render_file() {
  local source="$1" target="$2"
  sed "s#@MIKI_ROOT@#$ROOT_DIR#g; s#@MIKI_NODE@#$NODE_BIN#g" "$source" > "$target"
}

install_stack() {
  require_root
  install -d -m 0750 "$ROOT_DIR/data" "$ROOT_DIR/logs" "$ROOT_DIR/config"
  chown -R "${SUDO_USER:-ubuntu}:${SUDO_USER:-ubuntu}" "$ROOT_DIR/data" "$ROOT_DIR/logs" "$ROOT_DIR/config" 2>/dev/null || true
  install -d -m 0755 "$UNIT_DIR" "$INSTALL_DIR" "$ENV_DIR"
  if [[ ! -e "$ENV_FILE" ]]; then
    sed "s#/home/ubuntu/miki-final-2026-09-19#$ROOT_DIR#g; s#MIKI_NODE=/usr/bin/node#MIKI_NODE=$NODE_BIN#g" "$SYSTEMD_DIR/miki.env.example" > "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
    echo "Created $ENV_FILE; review model paths before starting."
  elif grep -q '^MIKI_NODE=/usr/bin/node$' "$ENV_FILE"; then
    sed -i "s#^MIKI_NODE=.*#MIKI_NODE=$NODE_BIN#" "$ENV_FILE"
  fi

  for unit in miki.target miki-memory.service miki-llama.service miki-core.service miki-gateway.service miki-health.service miki-health.timer; do
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
  status) systemctl --no-pager --full status miki.target miki-health.timer miki-memory.service miki-llama.service miki-core.service miki-gateway.service ;;
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
