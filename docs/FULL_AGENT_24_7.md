# Miki FULL_AGENT 24/7 Runtime

## Runtime model

Miki now has one reasoning/execution path: `AgentEngine` is the main FULL_AGENT for both interactive chat and autonomous work. The legacy chat-classification/router layer and layered execution path have been removed.

```text
WebSocket / HTTP message
        │
        ▼
   Gateway startRun ───────────────┐
        │                          │
        ▼                          │
   AgentEngine.run()               │
        │                          │
        └──── shared tools/policy ─┘
                                   
Persistent 24/7 loop
        │
        ├─ recover pending goals/tasks
        ├─ heartbeat + durable queue
        ├─ FULL_AGENT ambient decision
        ├─ direct FULL_AGENT goal execution
        └─ proactive.message → WebSocket + durable chat history
```

## Startup and shutdown

`packages/gateway/src/index.ts` starts the autonomous supervisor during gateway initialization. Startup does not depend on an incoming user message. The first cycle recovers durable state, executes any pending work, and can make an immediate proactive decision.

The loop remains alive until the process receives `SIGINT` or `SIGTERM`, at which point the supervisor aborts its active autonomous model call and waits for the loop to exit before the SQLite database and HTTP server close.

`npm run runtime:24-7` remains the outer process supervisor. It restarts the gateway after unexpected exits and provides the VPS-style long-running service boundary.

## Foreground/background concurrency

Interactive chat uses a per-run execution lane (`chat:<runId>`). Autonomous work uses the supervisor's own lane and a durable SQLite goal lease. A foreground request therefore does not cancel, reset, or block an autonomous goal. Both call the same `AgentEngine` instance.

## Event-driven wakeups

The gateway lifecycle bus wakes the autonomous loop on startup, incoming messages, and outgoing messages. Scheduled tasks and event triggers remain persisted in SQLite. A websocket or REST user request does not need to wait for the next polling interval.

## Adaptive resource policy

The heartbeat performs cheap state checks on its configured interval. LLM-backed ambient decisions are gated by `decision_interval_seconds`. When no useful work is found, the loop backs off exponentially between `min_poll_seconds` and `max_poll_seconds`. A new event calls `wake()` and interrupts the current sleep immediately.

Current defaults in `config/agent.yaml` are 15 seconds minimum polling, 5 minutes maximum idle backoff, a 2x idle multiplier, and a 15-minute ambient decision interval.

### Failure handling

- **Provider outages are not "nothing to do".** A failed model run (no provider, 401/403, 429, network, 5xx) is classified, logged, and retried with exponential backoff (`failure_backoff_base_seconds` → `failure_backoff_max_seconds`), never counted as `NO_ACTION`.
- **Circuit + self-healing.** After `failure_threshold` consecutive failures the user gets one warning in chat; when a call succeeds again a single recovery notice is sent. The loop keeps probing, so no manual restart is needed.
- **Goals are not punished for outages.** Infrastructure failures do not consume a goal's retry budget or block it; genuine failures still do.
- **Notifications can't break work.** Delivery errors are logged and ignored; they never mark a finished decision or goal as failed.
- **The loop cannot die.** Config-read errors, DB errors and tick bugs are caught per iteration with escalating sleeps; a bad config at boot still starts the loop.
- **Shutdown always terminates.** `stop()` aborts in-flight model calls; the gateway force-exits after 15 s if anything hangs.

`GET /api/autonomy/status` exposes `failure_streak`, `circuit_open` and `last_failure`.

### State-aware LLM gating

The paid ambient decision is not purely timer-driven. Before each decision the supervisor computes a cheap SQLite fingerprint (chat history, goals, task queue, memory, heartbeat checklist hash):

- If the fingerprint changed since the last `NO_ACTION`, the base `decision_interval_seconds` applies.
- If it is unchanged, each consecutive `NO_ACTION` multiplies the wait by `decision_backoff_multiplier` up to `max_decision_interval_seconds` (default 6 h).
- An actionable decision resets the streak.

So an idle VPS with no new input makes at most a handful of LLM calls per day, while any new message, goal, task, or memory write brings the agent back to the base cadence. `GET /api/autonomy/status` exposes `no_action_streak` and `next_decision_in_seconds`.

## Proactive messaging

Proactive results are stored in the `miki-main-chat` session and broadcast as `proactive.message` websocket events. The frontend appends those messages as assistant messages even when the active chat session is different, so milestone, blocker, and useful-discovery notifications can arrive without a user prompt.

## Ubuntu / VirtualBox operation

The configured operator profile grants autonomous access to the registered terminal, file, skill, and goal tools. The model still operates through Miki's tool registry and `AutonomyPolicy`; execution remains bounded by tool-call/token budgets, retry limits, and deterministic acceptance checks.
