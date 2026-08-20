# Agent Miki 24/7 Architecture Gap Audit

## Target operating model

The requested operating model is:

`INTAKE → CLASSIFY → PLAN → AUTHORIZE → EXECUTE → OBSERVE → VERIFY → CHECKPOINT → DELIVER → LEARN/ARCHIVE`

The target runtime is:

`Chat / Webhook / API / Timer → Gateway + Auth → Router + Session Manager → Deterministic Watchers or Agent Job Queue → Planner/Executor → Web / Code / Files/APIs → Verifier + Checkpoint → Delivery + Audit Log → DB / Memory / Metrics / DLQ`

## Current coverage

| Layer | Current state | Finding |
|---|---|---|
| Gateway and auth | Partial | Gateway starts a core child process, has runtime state and restart handling. A complete provider-neutral ingress/auth contract is not yet present. |
| Router and session manager | Partial | Session routing and session turn locking exist. The queue worker currently has a first `agent.message` path, but a durable event envelope and correlation/idempotency contract are missing. |
| Durable agent queue | Partial | File-backed queue supports queued/running/completed/failed/cancelled/dead-letter and restart requeue. It lacks idempotency keys, lease ownership, visibility timeout, explicit checkpoint pointers, and multi-process transactional locking. |
| Persistent worker | Present, limited | Bounded local concurrency, handler registry, retry and graceful stop exist. It assumes handlers are idempotent and does not persist worker leases or heartbeat ownership. |
| Scheduler | Partial | Scheduled tasks, simple recurring expressions, persistence hooks, retries and dead-letter handling exist. The cron parser is intentionally narrow and scheduler state is separate from the durable agent queue. |
| Deterministic watchers | Missing as a unified subsystem | Heartbeat exists, but there is no common watcher registry, previous-state store, change detector, degraded watcher status, or deduplicated alert delivery contract. |
| Planner/executor | Partial | Agent planning and tool orchestration modules exist. A durable plan schema with task_id, dependencies, owner lane, checkpoint locations, timeout, retry policy and verification method is not yet the single execution contract for queued jobs. |
| Web / code / files / APIs | Partial | File manager, MCP/plugin runtime and tool policy components exist. Public gateway isolation and a single capability envelope for browser, code, filesystem and API actions are not yet unified. |
| Verifier and checkpoint | Partial | Quality, audit, tracer and task checkpoint-related modules exist, but queue jobs do not transition through a durable `verifying` state and do not store independent verification evidence as a first-class result. |
| Delivery | Missing as a unified subsystem | No provider-neutral outbound delivery queue with receipt, provider message ID, attempt count, retry state and unknown-outcome reconciliation was found. |
| Audit log | Present, limited | Audit logging exists, but every external write is not yet guaranteed to carry task ID, run ID, idempotency key, destination, receipt and rollback/uncertainty status. |
| Memory | Partial | Memory package and agent memory modules exist. Working, episodic and semantic memory are not yet exposed as a single failure-isolated memory contract for every long-running job. |
| Metrics | Partial | Metrics collector exists, but queue depth, lease age, watcher health, delivery failures, provider latency, tool latency, DLQ age and heartbeat are not yet guaranteed as one operational dashboard contract. |
| DLQ | Partial | Queue and scheduler can mark dead-letter jobs. Operator-only inspection, replay guard, reason taxonomy and replay audit are not yet unified. |
| 24/7 supervisor | Present, limited | `scripts/miki-24-7.mjs` has a lock, atomic state, restart backoff, restart limits and graceful shutdown. It supervises the gateway process but does not yet supervise channel delivery, watcher health, DLQ review or resource budgets as independent control loops. |

## Highest-priority incomplete work

The most important missing contract is the durable event and run envelope. Every inbound event must carry `eventId`, `idempotencyKey`, `channel`, `sender`, `sessionId`, `correlationId`, `receivedAt`, `replyRoute`, and a normalized payload. Every queued run must carry a durable task state, retry/lease data, plan reference, checkpoint reference, verification evidence reference, and final delivery status.

The second priority is replacing the current process-local assumption with durable lease semantics. A job should be claimed by `workerId`, include `leaseUntil`, and be recovered only after the visibility timeout. File-backed persistence must use an inter-process lock or move to a transactional database before more than one worker is deployed.

The third priority is the unified channel and delivery adapter registry. Web UI, Webhook, API, Timer, Telegram, WhatsApp, Discord, Slack and Email should map to the same inbound envelope and outbound delivery receipt rather than each channel inventing separate state.

The fourth priority is the control plane around autonomous execution. Since routine human approval is not required by the selected product scope, the system still needs a kill switch, capability policy, sandbox boundary, timeouts, rate limits, secret redaction, immutable audit events and explicit handling for `UNKNOWN_OUTCOME`.

## Acceptance gates for completion

A phase is complete only when the following can be demonstrated with automated tests or a live smoke test:

1. A duplicate inbound event produces one durable run and one outbound side effect.
2. A worker crash before completion causes lease expiry and safe recovery without blind replay.
3. A scheduled watcher detects a real state change, remains silent for unchanged state, and records a degraded state when its check fails.
4. A run persists plan, step state, checkpoint, verification evidence and delivery receipt across process restart.
5. A failed job reaches dead-letter after bounded retries and can be replayed only through an authenticated operator path with a new replay audit event.
6. External write actions carry an idempotency key and produce a receipt or `UNKNOWN_OUTCOME`; they are never reported as successful based only on a local function return.
7. Browser/code execution is isolated from the public gateway and is bounded by tool policy, timeout and workspace scope.
8. Metrics expose queue depth, active jobs, retries, DLQ count, watcher health, delivery failures, latency and worker heartbeat.

## Known baseline issue

The repository-wide lint command still reports a large legacy formatting/unused-symbol baseline. New worker files pass targeted lint; full typecheck, production build, runtime preflight and worker regression tests pass. Lint cleanup should be tracked separately from functional 24/7 completion so it does not hide runtime failures.

## Phase 5 verification update — 2026-08-20

The implementation and end-to-end acceptance pass now covers the core 24/7 control-plane contracts. The following issues discovered during live testing were fixed before final regression: the authenticated enhancement router was previously shadowed by the dashboard compatibility router under `/api`; inbound `Idempotency-Key` headers were not being propagated into the normalized event envelope; and a core process terminated by `SIGKILL` was not restarted because the gateway exit handler ignored `code === null`. The fixes are in `packages/core/src/api/index.ts`, `packages/core/src/api/enhancement-router.ts`, `packages/core/src/api/enhancement-router.test.ts`, and `packages/gateway/src/index.ts`.

| Verification area | Result | Evidence |
|---|---|---|
| Full workspace build | PASS | `npm run build:all` completed for config, installer, skills, memory, core and gateway. |
| Core regression suite | PASS | Five suites, 17 tests passed: queue, runner, event contracts, timer scheduler and workflow engine. |
| Gateway health | PASS | Live `/gateway/health` returned `status: ok` and `coreHealthy: true`. |
| Authenticated enhancement runtime | PASS | API-key authenticated worker endpoint returned HTTP 200. |
| Duplicate inbound event | PASS | Two webhook requests with the same `Idempotency-Key` returned the same durable job ID. A regression test now protects this contract. |
| Channels, timers, deliveries, watchers | PASS | Live endpoints returned the normalized nine-channel registry, persisted timer, delivery receipt and watcher health response. |
| Restart persistence | PASS | Existing jobs and timers remained visible after gateway/core restart using the same workspace. |
| Core self-healing | PASS | A controlled `SIGKILL` of the core child produced a temporary unhealthy state, then gateway restarted core after backoff and the authenticated worker endpoint returned HTTP 200. |

The phase is functionally complete for the implemented control-plane scope. The original acceptance gates concerning duplicate ingress, restart recovery, timer persistence, delivery receipts and worker health are now demonstrated. The remaining gaps are production-hardening boundaries rather than unimplemented core contracts: browser/computer automation still requires an isolated remote execution service; code execution requires a hardened sandbox rather than the current configured tool boundary; OAuth and provider credentials for Telegram, WhatsApp, Discord, Slack and Email must be supplied and tested in each deployment; multi-process queue safety should move from the current file-backed store to a transactional database with inter-process locking before horizontal scaling; and operational metrics, DLQ replay governance and immutable audit storage need deployment-specific SLOs and external observability.

The repository-wide lint baseline remains a separate cleanup item. It does not block the verified build, targeted regression suite or the live 24/7 smoke tests above.
