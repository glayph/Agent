#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
workspace_dir="${MIKI_WORKSPACE_DIR:-$repo_dir}"
min_free_mb="${MIKI_MIN_FREE_MB:-512}"
service_name="${MIKI_SYSTEMD_UNIT:-agent-miki}"
service_drill=0

usage() {
  cat <<'EOF'
Usage: validate-host.sh [--repo DIR] [--workspace DIR] [--service-drill]

Runs safe checks on a real Linux host. Reboot and multi-hour soak evidence are
reported separately; this script does not pretend to prove them.
EOF
}
while (($#)); do
  case "$1" in
    --repo) repo_dir=$(CDPATH= cd -- "$2" && pwd); shift 2 ;;
    --workspace) workspace_dir=$(CDPATH= cd -- "$2" && pwd); shift 2 ;;
    --service-drill) service_drill=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

command -v node >/dev/null 2>&1 && pass "node is available" || fail "node is missing"
command -v systemctl >/dev/null 2>&1 && pass "systemctl is available" || fail "systemctl is missing"
[[ -f "$repo_dir/scripts/miki-24-7.mjs" ]] && pass "24/7 runtime entrypoint exists" || fail "runtime entrypoint missing"
[[ -f "$repo_dir/packages/gateway/dist/index.js" ]] && pass "gateway build exists" || fail "gateway build missing"
if node --check "$repo_dir/scripts/miki-24-7.mjs" >/dev/null 2>&1; then pass "runtime JavaScript parses"; else fail "runtime JavaScript parse failed"; fi
if bash -n "$repo_dir/deploy/linux/install-systemd.sh" && bash -n "$repo_dir/deploy/linux/validate-host.sh"; then pass "deployment shell scripts parse"; else fail "deployment shell script parse failed"; fi

mkdir -p "$workspace_dir/data"
probe="$workspace_dir/data/.host-validation-$$"
if printf '%s\n' "$(date -Is)" > "$probe"; then
  rm -f "$probe"
  pass "workspace is writable"
else
  fail "workspace is not writable"
fi

free_mb=$(df -Pm "$workspace_dir" | awk 'NR==2 {print $4}')
if [[ "$free_mb" =~ ^[0-9]+$ ]] && (( free_mb >= min_free_mb )); then
  pass "disk headroom ${free_mb}MB >= ${min_free_mb}MB"
else
  fail "disk headroom ${free_mb:-unknown}MB is below ${min_free_mb}MB"
fi

perm_tmp=$(mktemp -d)
chmod 0555 "$perm_tmp"
if [[ "$(id -u)" -eq 0 ]]; then
  warn "permission-failure drill skipped under root; run as the service account"
elif (printf x > "$perm_tmp/should-fail") 2>/dev/null; then
  fail "permission-failure drill unexpectedly succeeded"
else
  pass "permission-failure drill rejected write"
fi
chmod 0755 "$perm_tmp"
rmdir "$perm_tmp"

if (( service_drill )); then
  if systemctl --user is-enabled "$service_name.service" >/dev/null 2>&1; then
    systemctl --user restart "$service_name.service"
    sleep 2
    if systemctl --user is-active "$service_name.service" >/dev/null 2>&1; then
      pass "systemd service restart/active drill"
    else
      fail "systemd service did not become active"
    fi
  else
    fail "$service_name.service is not enabled for this user"
  fi
else
  warn "systemd boot/restart drill not run; rerun with --service-drill on the target host"
fi

warn "reboot recovery, crash recovery, disk-full under the service account, and multi-hour soak require target-host evidence"
if (( failures > 0 )); then exit 1; fi
