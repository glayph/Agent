# MEMORY

Curated long-term facts and decisions.

## Decisions

- 2026-10-26 — Retry loop time limits: minimum 2 seconds, maximum 12 seconds. Model-call retries wait 2s, 4s, 8s, 12s (then repeat in the chat gateway, or stay at 12s in the engine's in-place retry). Applies to chat turns and Cron/autonomous goal runs. Goal-level re-planning backoff (`failure_backoff_*`, `retry_backoff_seconds`) uses the same 2–12 second window.
- 2026-10-26 — Chat UI: live progress lines (`WorkStartStatus`, `RunActivityLine`) are rendered at the end of the message list. Tool-call and plan messages stay hidden unless "Response details" is set to `all`.
- 2026-10-26 — Idle loop: there is no "do nothing" outcome any more. Every idle decision ends with one piece of work at a fixed interval (`decision_interval_seconds` +-20%), runs in the background, and self-proposed goals always have priority 9 so scheduled (cron) work goes first.
- 2026-10-26 — Telling the user about discoveries goes through `autonomy_share_discovery`; the server decides by importance (`share_min_importance`), duplicates (7 days), `share_max_per_day` and `share_min_gap_minutes`. Quiet findings are saved in `autonomy_discoveries` and memory.
- 2026-10-26 — Free time is `idle_after_minutes` without chat. Curiosity and drive goals start only then. First run on an empty install creates the goal "Explore my environment" (`identity/memory/environment.md`).

- [2026-10-26] Heartbeat cycle health snapshot: System OK, Linux 6.18.38+, 6 processors, 23.8 GB total memory, node runtime active.
- [2026-10-26] Heartbeat cycle health snapshot: System OK, Linux 6.18.38+, 6 processors, 23.8 GB total memory, node runtime active (verified via system inspection).
- [2026-10-26] [2026-10-26] Heartbeat cycle health snapshot: System OK, Linux 6.18.38+, 6 processors, 23.8 GB total memory, node runtime active, llama-server running on port 39200.
- [2026-10-26] [2026-10-26] Heartbeat probe: local model / gateway health checked — http://localhost:39200/health returned status ok. llama-server is running normally.
- [2026-10-26] [2026-10-26] Heartbeat cycle health snapshot: System OK, Linux 6.18.38+, 6 processors, 23.8 GB total memory, node runtime active, uptime 19 min, disk usage 34%. Local gateway http://localhost:39200/health status OK.
- [2026-10-26] [2026-10-26] Heartbeat cycle health snapshot: System OK, Linux 6.18.38+, 6 processors, 23.8 GB total memory, node runtime active, uptime 20 min, disk usage 34%. Local gateway http://localhost:39200/health status OK.
- [2026-10-26] [2026-10-26] Heartbeat cycle health snapshot & gateway check verified: System memory 23Gi total, 17Gi available, disk root 34% used. Local model gateway at http://localhost:39200/health is responsive (status ok).
- [2026-10-27] [2026-10-26] Heartbeat Health Snapshot: System memory 23.8GB total, disk root '/' 23% used (38G available). Local gateway curl exited 7 (not active on port 39200).
- [2026-10-27] Heartbeat Cycle Health Snapshot — 2026-10-27 · **Gateway Health:** `http://localhost:39200/gateway/health` reports status `ok` (`coreHealthy: true`, model reachable, event loop healthy, zero pending outbox items, zero degraded reasons, uptime 407s). · **System Resources:** Memory total 24413MB, available 21558MB. Root disk usage 23% (38G available).
- [2026-10-27] Heartbeat Cycle Health Snapshot — 2026-10-27 · Gateway Health: http://localhost:18800/gateway/health reports status ok (coreHealthy: true, model reachable, event loop healthy, zero pending outbox items, zero degraded reasons, uptime 628s). · System Resources: Memory total 24413MB, available 21531MB. Root disk usage 23% (38G available).
- [2026-10-27] [2026-10-27] Heartbeat Cycle Health Snapshot — Gateway health OK (status ok, coreHealthy: true, model reachable, uptime 662s).
- [2026-10-27] Heartbeat Cycle Health Snapshot — 2026-10-27 · Gateway Health: http://localhost:18800/gateway/health reports status ok (coreHealthy: true, model reachable, event loop healthy, zero pending outbox items, zero degraded reasons, uptime 662s). · System Resources: Memory total 24413MB, available 21585MB. Root disk usage 23% (38G available).
- [2026-10-27] [2026-10-27] Heartbeat Cycle Health Snapshot — Gateway health OK (status ok, coreHealthy: true, model reachable, uptime 776s, zero degraded reasons). System resources: Memory total 24413MB, available 21564MB. Root disk usage 23% (38G available).
- [2026-10-27] Heartbeat Cycle Health Snapshot — 2026-10-27 · **Gateway Health:** `http://localhost:18800/gateway/health` reports status `ok` (`coreHealthy: true`, model reachable, event loop healthy, zero pending outbox items, zero degraded reasons, uptime 814s). · **System Resources:** Memory total 24413MB, available 21550MB. Root disk usage 23% (38G available).
- [2026-10-27] Heartbeat Cycle Health Snapshot — 2026-10-27 · Gateway Health: http://localhost:18800/gateway/health reports status ok (coreHealthy: true, model reachable, event loop healthy, zero pending outbox items, zero degraded reasons, uptime 845s). · System Resources: Memory total 24413MB, available 21534MB. Root disk usage 23% (38G available).
- [2026-10-27] Heartbeat Cycle Health Snapshot — 2026-10-27 · Gateway Health: http://localhost:18800/gateway/health reports status ok (coreHealthy: true, model reachable, event loop healthy, zero pending outbox items, zero degraded reasons, uptime 879s). · System Resources: Memory total 24413MB, available 21547MB. Root disk usage 23% (38G available).
- [2026-10-27] [2026-10-27] Heartbeat Cycle Health Snapshot — Gateway health OK (status ok, coreHealthy: true, model reachable, uptime 914s, zero degraded reasons). System resources: Memory total 24413MB, available 21565MB. Root disk usage 23% (38G available).
