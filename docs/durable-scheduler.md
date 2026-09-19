# Durable scheduler and heartbeat

The background scheduler is persisted in `scheduled-tasks.db` and is started by the agent background lifecycle. The heartbeat engine now calls the scheduler heartbeat on every pulse, so scheduler health and execution continue independently of whether the dashboard is open.

## Supported policies

Schedules support one-time execution, interval execution through `intervalMs`, and standard five-field cron expressions. Standard cron expressions are evaluated in the task `timezone` using `Intl.DateTimeFormat`; legacy aliases such as `@hourly`, `@daily`, and `@weekly` retain their existing relative behavior.

Each task can persist `missedRunPolicy` (`run_once`, `skip`, or `catch_up`), `timeoutMs`, `maxAttempts`, `quietHours`, and `concurrencyLimit`. A missed task is recovered from SQLite after restart. `skip` advances to the next occurrence, while the default `run_once` executes the missed occurrence once. A task transitions to `dead_letter` after its retry budget is exhausted. Retry delay uses bounded exponential backoff.

Example scheduler defaults:

```yaml
tools:
  cron:
    timezone: Asia/Dhaka
    missed_run_policy: run_once
    exec_timeout_minutes: 5
    per_task_concurrency_limit: 1
    quiet_hours:
      start: "23:00"
      end: "07:00"
      timezone: Asia/Dhaka
```

Per-task options are persisted with the task, so process restart does not lose policy state. The scheduler writes the task to SQLite before starting execution, which prevents two scheduler ticks from claiming the same pending task. Session turn locking additionally prevents overlapping turns for one canonical session.

`getHealthMetrics()` exposes heartbeat freshness, running state, missed-run count, active and queued work, scheduled task count, dead-letter count, and the latest persisted error. These metrics are included in the Agent task-queue status response under `scheduler.health`.
