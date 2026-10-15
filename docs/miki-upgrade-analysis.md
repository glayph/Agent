# Miki Upgrade Analysis

**Date:** 2026-10-15  
**Scope:** `miki_upgrade_drafts.zip` reviewed against the `agent` repository (`main`).

## Draft files reviewed

- `PRD.md` — product requirements for reliability, autonomy, durability, memory, verification, scheduling, and operations.
- `TRD.md` — proposed runtime architecture, state machine, budgets, retries, tool governance, memory, verification, and testing.
- `TODO.md` — phased implementation roadmap from baseline/hang prevention through operations.
- `PROMPT.md` — coding-agent workflow, reliability constraints, security boundaries, and required validation format.

These documents are proposals, not proof of current repository defects. Each item was checked against source, tests, and build behavior before implementation.

## Repository findings

### Confirmed existing capabilities

- `packages/core/src/engine/agent-engine.ts` already enforces model-turn, tool-call, and tool-iteration caps.
- Tool execution already propagates cancellation, applies per-tool timeouts, blocks repeated identical calls, and emits lifecycle events.
- `packages/core/src/engine/llm-client.ts` already implements bounded retries, exponential backoff with jitter, `Retry-After`, provider error classification, and request timeouts.
- Dynamic budget extension is progress-aware and bounded; self-check verification is available for tool-using runs.
- Gateway restart handling, stream checkpoints, memory persistence, approvals, and structured metrics already exist in the current codebase.

### Confirmed gap addressed in this change

The engine had no single run-level wall-clock budget covering context recall, model calls, approvals, tool execution, verification, and wrap-up. A run could be bounded by turns/tool calls while still exceeding an operator-selected elapsed-time limit.

### Partially confirmed / not yet implemented

- Durable task state is now unified for gateway agent runs, including persisted run creation, worker claim, terminal result/error writeback, and startup recovery of expired leases; autonomous queue orchestration still needs to adopt the same claim loop.
- Persistent memory, approval, observability, and recovery features exist, but a full cross-feature acceptance benchmark and restart/fault-injection matrix are still needed.
- Performance targets remain unmeasured; no blanket latency claim is made.

### Hypotheses requiring later measurement

- Retrieval precision/recall and stale-memory rates.
- End-to-end p50/p95 latency split by queue, model, tool, memory, and verification.
- Long-running task success and restart-resume rates under representative workloads.
- Provider-specific circuit-breaker value under sustained outage conditions.

## Implemented in this phase

- Added `AgentEngineOptions.maxWallTimeMs` and `RunRequest.maxWallTimeMs`.
- Added a run-level abort deadline that covers all engine phases and preserves user cancellation semantics.
- Deadline expiry returns `limit_reached` with the explicit error `Run wall-time budget of <N> ms reached.` and emits a diagnostic logger event.
- Wired the gateway to `agents.defaults.max_wall_time_ms` and `MIKI_AGENT_MAX_WALL_TIME_MS`.
- Kept the default at `0` (disabled) to avoid breaking intentionally long-running terminal workflows.
- Added regression tests and updated the environment/example and engine architecture documentation.
- Added a structured `run.budget` engine event plus `agent_run` latency, terminal-outcome, and wall-time-exceeded metrics.
- Added fault-injection coverage for deadline cancellation during model execution, tool execution, and approval wait.
- Added a public deterministic task lifecycle state machine with versioned transitions, reasons, terminal-state checks, and invalid-transition errors.
- Added `DurableTaskStore` backed by SQLite with task records, transactional transition history, optimistic version checks, worker leases, claim, and expired-lease recovery.
- Activated the durable task schema during gateway startup so production runtime databases create the persistence boundary without changing existing chat behavior.
- Wired gateway agent runs to create a durable task, claim it with a lease, persist completed/cancelled/failed/limit terminal states and output/error details, and recover expired leases on restart.
- Added `DurableTaskWorker` with deterministic claim polling, expired-lease recovery, heartbeat renewal, verifying/completed transitions, retry-on-handler-failure, and clean shutdown.
- Added a supervisor bridge so legacy scheduled autonomous tasks mirror into `miki_tasks`/`miki_task_events` with unified queued, running, retrying, verifying, completed, and failed lifecycle records; recurring task occurrences receive fresh durable IDs.

## Validation

- Core engine loop regression: passed, including telemetry and hanging-model/tool/approval deadline fixtures.
- Task lifecycle tests: passed, including valid paths, invalid transitions, version increments, terminal states, and transition reasons.
- Durable task store tests: passed, including restart reload, transactional history, lease claim/recovery, and invalid-transition rollback behavior.
- Gateway runtime settings regression: passed.
- Core typecheck: passed.
- Core and gateway production builds: passed.
- Durable worker tests: passed, including lease heartbeat renewal, retry/reclaim, and polling-loop shutdown.
- Autonomous supervisor durable-bridge test: passed, including persisted lifecycle event history for a scheduled task.
- Full core suite: **100 suites passed; 687 tests passed**.
- `git diff --check`: passed.

## Next small, testable item

Replace the remaining legacy queue status writes with direct `DurableTaskWorker` claims where safe, then add cross-table restart/recovery integration tests before expanding the queue.
