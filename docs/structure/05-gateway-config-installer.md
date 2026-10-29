# 05 — Gateway, Config & Installer

## packages/gateway

Lightweight Express gateway that fronts the core agent and serves the UI.

```
packages/gateway/
├── package.json                 # @miki/gateway
├── tsconfig.json
├── __tests__/
└── src/
    ├── index.ts                 # Express app setup, proxy, static, health
    ├── websocket-relay.ts       # WebSocket relay to core
    ├── runtime-utils.ts         # Path rewriting, MCP proxy helpers
    ├── shutdown.ts              # Graceful shutdown & process tree termination
    └── ...
```

**Comments**
- Proxies HTTP and WebSocket traffic to the core API.
- Serves the built frontend static files.
- Handles CORS, API-key / origin / CIDR authentication, health checks.
- Manages clean shutdown of child processes.

### Self-recovery (outbox, health, replay, channel hardening)

Always on:
- `outbox.ts` — durable `channel_inbox` / `channel_outbox` tables. A channel reply is written to the outbox first and sent by a worker, so a failed send is retried (2 s doubling to 5 min, given up after 24 h; `MIKI_OUTBOX_TTL_HOURS`) and never sent twice (key `reply:<message id>:<part>`). Delivery is at-least-once: a crash between a successful send and its bookkeeping can in theory repeat one message. Long replies are split into ordered parts. A failed turn sends the user a short notice built from the recorded failure.
- `health.ts` — `GET /gateway/live` (event loop only; used by the supervisor watchdog) and `GET /gateway/health` (database, event-loop lag, a real model-provider probe, channels, outbox, recovery state, run progress). Status is `ok`, `degraded` (HTTP 200, a restart would not help) or `unhealthy` (HTTP 503, database failed). Details are shown only to authenticated or local callers.
- Discord RESUME + heartbeat-ACK watchdog, Slack stale-connection timeout (`MIKI_CHANNEL_STALE_MS`, default 90 s), and catch-up of messages missed while disconnected (per-conversation cursors in `channel_cursors`).
- `scripts/miki-24-7.mjs` — watchdog probes `/gateway/live` every 10 s (a deep check every third probe); three failures in a row kill and restart the gateway (`MIKI_WATCHDOG_INTERVAL_MS`, `MIKI_WATCHDOG_FAILURES`). A failure to start the gateway is retried with backoff instead of exiting.
- `deploy/systemd/miki-healthcheck.sh` — restarts a unit only after `MIKI_HEALTH_FAILURE_LIMIT` (3) failed checks in a row, and never while a young llama server reports "loading".

Behind `MIKI_RECOVERY_V2=1` (off by default):
- `recovery-manager.ts` — one question every 10 s: are the database, model and channel hosts reachable? Recovery is declared after N consecutive good checks (3, tuned 3–6) and an incident is recorded in `recovery_incidents`.
- `replay-sweeper.ts` — finds unanswered messages (interrupted, or failed for a temporary reason), replays them in order per conversation (2 conversations at once), at startup, after recovery and every 5 minutes. Limits: 3 attempts per message (poison-pill protection), 24 h age (`MIKI_REPLAY_MAX_ATTEMPTS`, `MIKI_REPLAY_TTL_HOURS`). Given-up messages are reported once to the user on their channel.
- `process-safety.ts` — database `quick_check` at startup with restore from the newest backup (damaged file kept), online backups every 6 h (newest 5 kept, `backups/`), crash handlers (reason written, controlled stop, supervisor restarts), unclean-exit detection and crash-loop protection (5 crashes in 10 minutes set aside the messages that were running).
- `recovery-learning.ts` — each incident goes to the learning store and `identity/memory/<date>.md`; the only setting it changes itself (good checks needed) stays within 3–6 and each change is logged.

Verification: `npm run test:recovery-chaos` (kill -9, network cut, send-time block, SIGSTOP hang, poison message, channel disconnects, model loading, corrupted database).

## packages/config

Shared foundation used by almost every other package.

```
packages/config/
├── package.json                 # @miki/config — exports ., ./security, ./schema
├── tsconfig.json
└── src/
    ├── index.ts                 # Main re-exports
    ├── config.ts                # Settings loading & validation
    ├── schema.ts                # Config schema
    ├── types.ts                 # Shared TypeScript types
    ├── security.ts              # CORS, CIDR, API-key helpers, bind policy
    ├── secret-vault.ts          # Secret resolution / vault
    ├── user-config.ts           # User-level overrides
    ├── env-compat.ts            # Environment variable compatibility layer
    ├── default-model.ts         # Default model helpers
    └── *.test.ts                # Unit tests
```

**Comments**
- Single source of truth for runtime configuration shape.
- Security helpers enforce public-bind policy, origin checks and timing-safe comparisons.
- Secret vault supports loading credentials without hard-coding them.

## packages/installer

Workspace and runtime installation helpers.

```
packages/installer/
├── package.json
├── jest.config.cjs
├── __tests__/
└── src/
    └── (installer logic for registering data/logs/config dirs)
```

**Comments**
- Used by `miki install` / `miki uninstall` to create or remove the on-disk workspace layout while optionally preserving user data.
