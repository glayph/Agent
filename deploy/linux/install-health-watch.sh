#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
unit_name="agent-miki-health-watch"
alert_file=""
health_url="http://127.0.0.1:18800/gateway/health"
start_now=1

usage() {
  cat <<'EOF'
Usage: install-health-watch.sh [options]
  --repo DIR       Agent Miki repository (default: script parent)
  --unit NAME      User unit name (default: agent-miki-health-watch)
  --alert-file FILE JSONL alert file (default: repo/data/alerts.jsonl)
  --health-url URL Health endpoint
  --no-start       Enable at boot but do not start now
EOF
}
while (($#)); do
  case "$1" in
    --repo) [[ $# -ge 2 ]] || exit 2; repo_dir=$(CDPATH= cd -- "$2" && pwd); shift 2 ;;
    --unit) [[ $# -ge 2 ]] || exit 2; unit_name="$2"; shift 2 ;;
    --alert-file) [[ $# -ge 2 ]] || exit 2; alert_file="$2"; shift 2 ;;
    --health-url) [[ $# -ge 2 ]] || exit 2; health_url="$2"; shift 2 ;;
    --no-start) start_now=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
command -v systemctl >/dev/null || { echo "systemctl is required" >&2; exit 1; }
node_path=$(command -v node || true)
[[ -n "$node_path" ]] || { echo "node is required" >&2; exit 1; }
[[ -f "$repo_dir/scripts/health-watch.mjs" ]] || { echo "Missing health-watch.mjs" >&2; exit 1; }
alert_file=${alert_file:-$repo_dir/data/alerts.jsonl}
unit_dir="$HOME/.config/systemd/user"
unit_path="$unit_dir/$unit_name.service"
mkdir -p "$unit_dir"
cat > "$unit_path" <<EOF
[Unit]
Description=Agent Miki health watcher
After=default.target

[Service]
Type=simple
WorkingDirectory=$repo_dir
ExecStart=$node_path $repo_dir/scripts/health-watch.mjs
Restart=always
RestartSec=10s
Environment=MIKI_HEALTH_URL=$health_url
Environment=MIKI_ALERT_FILE=$alert_file

[Install]
WantedBy=default.target
EOF
chmod 600 "$unit_path"
systemctl --user daemon-reload
systemctl --user enable "$unit_name.service"
if (( start_now )); then systemctl --user restart "$unit_name.service"; fi
echo "Installed: $unit_path"
echo "Logs: journalctl --user -u $unit_name.service -f"
