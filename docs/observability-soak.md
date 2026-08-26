# Observability, Soak Testing, and Production Alerts

Agent Miki now samples process resource health from the core lifecycle. The monitor records RSS, heap, external memory, array-buffer memory, open file descriptors on Linux, and active Node resources. Node’s process API exposes memory usage in bytes and active resource information for this type of process-level telemetry.[1] The values are exported through the existing authenticated `/metrics/prometheus` endpoint as `miki_process_*` gauges.

## Resource thresholds

The monitor reads these environment variables and uses the listed defaults:

| Variable | Default | Meaning |
|---|---:|---|
| `MIKI_RESOURCE_SAMPLE_MS` | `30000` | Resource sample interval in milliseconds. |
| `MIKI_RSS_WARNING_MB` | `512` | Warning RSS threshold. |
| `MIKI_RSS_CRITICAL_MB` | `1024` | Critical RSS threshold. |
| `MIKI_FD_WARNING` | `1024` | Warning open-file-descriptor threshold on Linux. |
| `MIKI_FD_CRITICAL` | `4096` | Critical open-file-descriptor threshold on Linux. |
| `MIKI_RSS_GROWTH_WARNING_MB` | `256` | Warning growth above the soak baseline. |

Thresholds are deduplicated by alert state. A single alert is emitted when a state is entered, and a recovery event is emitted when the value returns below the threshold. The monitor does not kill or restart the service; the supervisor remains responsible for bounded restart and recovery policy.

## Running a bounded soak

The repository includes `scripts/soak-agent.mjs`. It polls `/health` and the authenticated `/metrics/prometheus` endpoint, keeps a bounded sample ring, and writes a mode-`0600` JSON report. It never prints or stores the API key.

```bash
# Local loopback smoke soak; the default API key is read only from the process environment.
API_KEY_SECRET='use-a-protected-key-here' \
  node scripts/soak-agent.mjs \
  --url http://127.0.0.1:18800 \
  --duration-minutes 10 \
  --interval-ms 10000 \
  --output /var/lib/agent-miki/soak-report.json
```

For a real qualification run, execute the harness for at least several hours and preferably for a full day on a clean target host. Store reports outside Git. A useful pass criterion is zero unexpected health failures, stable or explainable RSS after warm-up, no monotonic file-descriptor increase, and no unbounded active-resource growth. A short sandbox run proves the harness and endpoint contract only; it does not prove a day-long absence of leaks.

The harness exits non-zero if any health check fails. Metrics authentication failure is counted separately so that a missing key is not misreported as a healthy resource sample. Do not put an API key in a command that is recorded by shell history; use a protected environment file or service manager secret mechanism instead.

## HTTPS alert backend

Set `MIKI_ALERT_WEBHOOK_URL` only to an HTTPS URL without embedded credentials, query parameters, or fragments. The optional `MIKI_ALERT_WEBHOOK_TOKEN` is sent as a Bearer header and is not included in the JSON body. Configure `MIKI_ALERT_TIMEOUT_MS`, `MIKI_ALERT_MAX_ATTEMPTS`, and `MIKI_ALERT_MIN_INTERVAL_MS` to bound timeout, retry, and duplicate delivery. The default retry limit is two attempts and the default duplicate suppression interval is one minute.

The payload contains a stable alert ID, source, severity, code, message, timestamp, threshold, and resource snapshot. It is intentionally not a generic arbitrary outbound webhook or a replacement for an incident queue. Resource alert delivery is best-effort: the process records delivery and failure counters and logs only a secret-free failure classification. If the webhook is down, the application remains available and does not block the core request path.

The stable alert ID allows a downstream alert system to deduplicate repeated deliveries. It does not provide exactly-once delivery. Consumers must treat the payload as at-least-once and deduplicate by `id`.

## Prometheus and alert rules

The existing authenticated endpoint is suitable for a Prometheus-compatible scraper. Example conceptual rules are:

```promql
miki_process_rss_bytes > 512 * 1024 * 1024
miki_process_open_file_descriptors > 1024
increase(miki_alerts_failed_total[10m]) > 0
```

Adapt thresholds to the target host’s memory limit, workload, and file-descriptor limit. Keep `/metrics/prometheus` behind API-key authentication or an identity-aware reverse proxy; do not expose it anonymously on a public interface.

## Target-host evidence still required

The sandbox can run deterministic resource and alert tests and a short local HTTP soak, but it cannot prove multi-hour/day behavior under the user’s real workload, Windows handle behavior, clean-host service restarts, or delivery to the user’s real incident platform. Those require a target machine, protected alert endpoint, and an operator-approved test window. No external alert was sent during repository validation.

## References

[1]: https://nodejs.org/api/process.html — Node.js Process API documentation.
