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

restart_if_active() {
  local unit="$1"
  if systemctl is-active --quiet "$unit"; then
    logger -t miki-healthcheck "${unit} failed health check; restarting only this unit"
    systemctl restart "$unit"
  else
    logger -t miki-healthcheck "${unit} is inactive; systemd target will recover it"
    systemctl start "$unit"
  fi
}

memory_port="${MEMORY_PORT:-${MIKI_MEMORY_PORT:-18700}}"
llama_port="${MIKI_LLAMA_PORT:-39200}"
core_port="${CORE_PORT:-8000}"
gateway_port="${GATEWAY_PORT:-18800}"

curl_ok "http://127.0.0.1:${memory_port}/health" || restart_if_active miki-memory.service
curl_ok "http://127.0.0.1:${llama_port}/v1/models" || restart_if_active miki-llama.service
curl_ok "http://127.0.0.1:${core_port}/health" || restart_if_active miki-core.service

# Gateway health includes coreHealthy; only the gateway is restarted here when
# the HTTP listener itself is unavailable. Core recovery is handled above.
curl_ok "http://127.0.0.1:${gateway_port}/gateway/health" || restart_if_active miki-gateway.service
