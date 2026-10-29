#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE="/etc/miki/miki.env"
if [[ -r "$ENV_FILE" ]]; then
  # shellcheck disable=SC1091
  source "$ENV_FILE"
fi

LOCK_FILE="/run/lock/miki-healthcheck.lock"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

curl_ok() {
  local url="$1"
  if [[ -n "${MIKI_HEALTH_API_KEY:-}" ]]; then
    curl --silent --show-error --fail --max-time 4 -H "x-api-key: ${MIKI_HEALTH_API_KEY}" "$url" >/dev/null
  else
    curl --silent --show-error --fail --max-time 4 "$url" >/dev/null
  fi
}

# A unit is restarted only after this many failed checks in a row (the timer runs every 30 s), so one slow
# answer or a brief network blip does not restart anything. Set MIKI_HEALTH_FAILURE_LIMIT to change it.
failure_limit="${MIKI_HEALTH_FAILURE_LIMIT:-3}"
# A local llama server answers 503 "loading" while it reads the model. That is not a failure for this long.
llama_load_grace="${MIKI_LLAMA_LOAD_GRACE_SECONDS:-600}"
state_dir="${MIKI_HEALTH_STATE_DIR:-/run/miki-healthcheck}"
mkdir -p "$state_dir" 2>/dev/null || state_dir="/tmp"

failure_count() { cat "${state_dir}/$1.failures" 2>/dev/null || echo 0; }
reset_failures() { rm -f "${state_dir}/$1.failures"; }

restart_if_active() {
  local unit="$1"
  if systemctl is-active --quiet "$unit"; then
    logger -t miki-healthcheck "${unit} failed ${failure_limit} health checks in a row; restarting only this unit"
    systemctl restart "$unit"
  else
    logger -t miki-healthcheck "${unit} is inactive; systemd target will recover it"
    systemctl start "$unit"
  fi
}

# check <unit> <url>: counts consecutive failures and restarts at the limit.
check() {
  local unit="$1" url="$2"
  if curl_ok "$url"; then
    reset_failures "$unit"
    return 0
  fi
  local n
  n=$(( $(failure_count "$unit") + 1 ))
  echo "$n" > "${state_dir}/${unit}.failures"
  logger -t miki-healthcheck "${unit} health check failed (${n}/${failure_limit})"
  if (( n >= failure_limit )); then
    reset_failures "$unit"
    restart_if_active "$unit"
  fi
}

# Seconds the unit has been active (0 when unknown).
unit_active_seconds() {
  local since
  since="$(systemctl show -p ActiveEnterTimestamp --value "$1" 2>/dev/null || true)"
  [[ -z "$since" ]] && { echo 0; return; }
  local start
  start="$(date -d "$since" +%s 2>/dev/null || echo 0)"
  (( start == 0 )) && { echo 0; return; }
  echo $(( $(date +%s) - start ))
}

# llama: while the model is loading (HTTP 503 with a "loading" body) and the unit is young, do not count a failure.
check_llama() {
  local url="http://127.0.0.1:${llama_port}/v1/models"
  if curl_ok "$url"; then reset_failures miki-llama.service; return 0; fi
  local body
  body="$(curl --silent --max-time 4 "http://127.0.0.1:${llama_port}/health" 2>/dev/null || true)"
  if [[ "$body" == *[Ll]oading* ]] && (( $(unit_active_seconds miki-llama.service) < llama_load_grace )); then
    logger -t miki-healthcheck "miki-llama.service is still loading the model; not counted as a failure"
    return 0
  fi
  check miki-llama.service "$url"
}

memory_port="${MEMORY_PORT:-${MIKI_MEMORY_PORT:-18700}}"
llama_port="${MIKI_LLAMA_PORT:-39200}"
core_port="${CORE_PORT:-8000}"
gateway_port="${GATEWAY_PORT:-18800}"

check miki-memory.service "http://127.0.0.1:${memory_port}/health"
check_llama
check miki-core.service "http://127.0.0.1:${core_port}/health"

# /gateway/live answers whenever the gateway's event loop runs, so a hung gateway fails here. /gateway/health
# also answers 200 when the gateway is only degraded (model or network trouble), which a restart would not fix.
check miki-gateway.service "http://127.0.0.1:${gateway_port}/gateway/live"
