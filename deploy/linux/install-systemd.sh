#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: install-systemd.sh [options]

Install and enable Agent Miki as a systemd user service.

Options:
  --repo DIR       Agent Miki repository/runtime root (default: script parent)
  --workspace DIR  Runtime data directory (default: repo)
  --unit NAME      Unit name (default: agent-miki)
  --no-start       Enable at boot but do not start now
  --enable-linger  Request user services to start at boot without an interactive login
  -h, --help       Show this help
EOF
}

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
workspace_dir="$repo_dir"
unit_name="agent-miki"
start_now=1
enable_linger=0

while (($#)); do
  case "$1" in
    --repo) [[ $# -ge 2 ]] || { echo "--repo requires a value" >&2; exit 2; }; repo_dir=$(CDPATH= cd -- "$2" && pwd); shift 2 ;;
    --workspace) [[ $# -ge 2 ]] || { echo "--workspace requires a value" >&2; exit 2; }; mkdir -p "$2"; workspace_dir=$(CDPATH= cd -- "$2" && pwd); shift 2 ;;
    --unit) [[ $# -ge 2 ]] || { echo "--unit requires a value" >&2; exit 2; }; unit_name="$2"; shift 2 ;;
    --no-start) start_now=0; shift ;;
    --enable-linger) enable_linger=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v systemctl >/dev/null 2>&1 || { echo "systemctl is required" >&2; exit 1; }
[[ "$(systemctl --user is-system-running 2>/dev/null || true)" != "" ]] || {
  echo "The systemd user manager is unavailable for $USER." >&2
  echo "Log in through a systemd session first, or use a system service with an explicit service account." >&2
  exit 1
}
[[ -f "$repo_dir/scripts/miki-24-7.mjs" ]] || { echo "Missing runtime: $repo_dir/scripts/miki-24-7.mjs" >&2; exit 1; }
[[ -f "$repo_dir/packages/gateway/dist/index.js" ]] || { echo "Gateway is not built. Run npm run build:all first." >&2; exit 1; }
node_path=$(command -v node || true)
[[ -n "$node_path" ]] || { echo "node is required on PATH" >&2; exit 1; }

escape_systemd() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//"/\\"}
  value=${value//%/%%}
  printf '%s' "$value"
}

repo_escaped=$(escape_systemd "$repo_dir")
workspace_escaped=$(escape_systemd "$workspace_dir")
node_escaped=$(escape_systemd "$node_path")
unit_dir="$HOME/.config/systemd/user"
unit_path="$unit_dir/$unit_name.service"
mkdir -p "$unit_dir"

cat > "$unit_path" <<EOF
[Unit]
Description=Agent Miki 24/7 agentic runtime
After=default.target

[Service]
Type=simple
WorkingDirectory="$repo_escaped"
ExecStart="$node_escaped" "$repo_escaped/scripts/miki-24-7.mjs"
Restart=always
RestartSec=5s
TimeoutStopSec=30s
KillMode=control-group
Environment="NODE_ENV=production"
Environment="MIKI_SOURCE_ROOT=$repo_escaped"
Environment="MIKI_RUNTIME_ROOT=$repo_escaped"
Environment="MIKI_WORKSPACE_DIR=$workspace_escaped"
Environment="MIKI_24_7_MAX_RESTARTS=0"

[Install]
WantedBy=default.target
EOF

chmod 600 "$unit_path"
systemctl --user daemon-reload
systemctl --user enable "$unit_name.service"
if (( start_now )); then
  systemctl --user restart "$unit_name.service"
fi
if (( enable_linger )); then
  command -v loginctl >/dev/null 2>&1 || { echo "loginctl is required for --enable-linger" >&2; exit 1; }
  loginctl enable-linger "$USER"
fi

echo "Installed: $unit_path"
echo "Status: systemctl --user status $unit_name.service"
echo "Logs: journalctl --user -u $unit_name.service -f"
if (( enable_linger )); then
  echo "User lingering enabled for $USER. Confirm this is acceptable on the host."
fi
