# 24/7 Supervisor Smoke Test

**Date:** 2026-09-23

## Result

The bounded Miki supervisor was started with the stable local LFM2.5 profile. It created `data/24-7-supervisor.json`, reported `status: running`, and passed the gateway readiness check. The gateway returned a healthy response with `coreHealthy: true`.

The managed gateway child was then terminated intentionally to test recovery. The supervisor recorded `restartCount: 1`, started a new gateway process, restored the `running` state, and the dashboard returned `HTTP 200 OK` again. This confirms the bounded child-process recovery path works in the current environment.

## Important limitation

This is a smoke test, not a 24-hour production soak test. The temporary sandbox may hibernate or terminate, so a real 24/7 guarantee still requires deployment to a persistent host with systemd or an equivalent supervisor, persistent storage, backups, and monitoring.

## Evidence

- Supervisor state: `data/24-7-supervisor.json`
- Initial gateway state: `running`, `restartCount: 0`
- Recovered gateway state: `running`, `restartCount: 1`
- Gateway health before failure: `coreHealthy: true`
- Dashboard after recovery: `HTTP 200 OK`
- Standalone health check after correction: core and gateway passed with `--no-memory`
- Metrics-aware soak rerun: 30 seconds, 6/6 health samples passed, 0 metrics failures
- Resource sampling: RSS and open file descriptors were collected from core `/metrics`
- Independent revalidation: supervisor heartbeat timestamp refreshed, gateway crash recovered, and a second 30-second soak passed 6/6 samples

## Next operational test

On a persistent host, run the supervisor for at least 24 hours with representative low-risk tasks. During the soak, observe memory, CPU, model health, queue depth, restart count, dead-letter tasks, and backup success. Do not increase the restart limit or enable unlimited restarts unless the failure cause is understood.

When using the standalone supervisor, run `node scripts/miki-healthcheck.mjs --no-memory` because the core process owns the memory bridge in that mode. When using the full systemd stack, omit `--no-memory` so the separate memory service on port 18700 is checked as well.

The soak collector uses `http://127.0.0.1:8000/metrics` for resource metrics. The gateway path `/metrics/prometheus` is not used because the gateway serves the dashboard shell for that path in this deployment.

The supervisor now refreshes `heartbeatAt` in `data/24-7-supervisor.json` every 30 seconds while the gateway is running. Operators can use this field to detect stale supervisor state instead of relying only on the process PID.
