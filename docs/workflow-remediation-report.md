# Workflow Pipeline Remediation Report

**Date:** 2026-09-23

## Scope

This remediation addresses the highest-confidence workflow reliability defects found in the Miki pipeline audit. The changes focus on durable state, retry identity, scheduler timeout reporting, queue corruption handling, supervisor shutdown behavior, and workflow artifact gates.

## Implemented changes

### Durable workflow state

The workflow engine now persists a planning checkpoint before invoking context, memory, or planner providers. Context and memory are checkpointed separately, so an interruption during planning remains discoverable. A persisted workflow with no planned steps is re-entered through planning rather than being incorrectly marked completed.

Each workflow execution context now carries a stable step-level idempotency key in the form `taskId:stepId`. Executors can use this key to deduplicate external side effects across retries and resume operations. The production global workflow engine now uses a durable JSON store at `data/workflows.json`, configurable through `MIKI_WORKFLOW_STATE_PATH`.

### Queue persistence

Corrupt JSON queue snapshots no longer cause the queue to silently start empty. The corrupt snapshot is preserved with a timestamped `.corrupt.*` suffix and startup fails with an actionable error.

### Scheduler

Per-task timeout values are normalized to a positive minimum and timeout errors now report the actual timeout budget rather than an unrelated global setting. Existing retry, persistence, and dead-letter behavior remains covered by regression tests.

### 24/7 supervisor

The supervisor now checks `exitCode` and `signalCode` to determine whether a child really exited. It waits for graceful exit after readiness failure and shutdown, then uses `SIGKILL` only as a bounded fallback. This avoids relying on `child.killed`, which only indicates that a kill request was sent.

### Workflow artifact gate

A new `npm run verify:workflow` gate validates declared output files and gate scripts from `workflow.json`. Gate commands were corrected to reference `miki-agent-test/scripts/verify.mjs` relative to the declared scaffold root.

The gate currently fails because the manifest declares artifacts under `/home/ubuntu/miki-project/Miki-final`, but those artifacts are not present. This is intentional: the pipeline now reports the stale/missing artifact instead of falsely claiming success.

## Validation evidence

| Check | Result |
|---|---|
| Core TypeScript typecheck | Passed |
| Workflow engine tests | 7 passed |
| Scheduler and queue tests | 28 passed |
| Supervisor syntax check | Passed |
| Supervisor configuration check | Passed |
| Gateway health endpoint | Passed |
| Remediation files and JSON syntax | Passed |
| Workflow manifest integrity gate | Fails honestly on missing declared artifacts |

## Remaining work before production-grade 24/7 operation

The stable step idempotency key is now available, but each side-effecting executor must still enforce deduplication and persist effect receipts. Multi-process ownership still requires a transactional store or lease/fencing mechanism; the JSON store is durable for single-process crash recovery, not a multi-process coordinator.

The scheduler still needs explicit `catch_up` occurrence accounting if the intended contract is to execute every missed recurring occurrence rather than one recovery run. The supervisor also needs process-level crash/restart integration tests and a long-duration soak test rather than only policy tests and short smoke checks.

Finally, the missing `/home/ubuntu/miki-project/Miki-final` artifact must either be regenerated from the manifest or the manifest must be retired/repointed to the correct output. Until that is resolved, the workflow should remain blocked by the integrity gate.

## Second hardening batch

The production global workflow store now uses SQLite with WAL mode, busy timeout, atomic workflow claims, lease expiry, heartbeat renewal, and owner-checked release. A second worker cannot start the same active workflow while another worker holds its lease.

Scheduler recovery now supports bounded `catch_up` replay for missed recurring interval and cron runs. Catch-up state is persisted in SQLite and capped at 100 occurrences to prevent an outage from creating an unbounded recovery storm.

A real supervisor integration test now covers both healthy shutdown and repeated gateway crashes until the restart limit is reached. It is available through `npm run test:supervisor`.

The missing `/home/ubuntu/miki-project/Miki-final` artifact was regenerated with the declared scaffold, five numbered capability examples, a runnable verification script, and package metadata. The workflow manifest gate now passes.

## Second-batch validation

| Check | Result |
|---|---|
| Core TypeScript typecheck | Passed |
| Workflow engine tests | 8 passed |
| Scheduler and queue tests | 29 passed |
| Supervisor integration scenarios | Passed |
| Workflow manifest validation | Passed |
| Scaffold test/build/smoke gates | Passed |
| Live gateway health | Passed |

The workflow engine now supplies a stable step idempotency key to executors. Enforcing effect receipts in every individual side-effecting adapter remains a follow-up integration task; the key is available and persisted at the orchestration boundary, but adapters must still use it to deduplicate external effects.

## Clean-room verification

A final clean-room audit found two stale test expectations left behind by the reliability fixes. The scheduler test expected the old minute-based timeout text even though the implementation correctly reports the effective `60ms` task budget. The queue persistence test expected corrupt snapshots to be silently ignored even though the new contract intentionally fails visibly and preserves a `.corrupt.<timestamp>` recovery copy. Both tests were updated to assert the current production contract.

After those corrections, verification completed successfully:

| Check | Result |
|---|---|
| Complete core Jest suite | 113 suites passed, 726 tests passed |
| Full workspace `npm test` | Exit code 0 |
| Installer tests | Passed, 51 tests |
| Memory integration tests | Passed |
| Frontend Vitest suite | 18 files passed, 124 tests passed |
| Core build | Passed |
| TypeScript CLI build | Passed |
| Supervisor integration | Passed |
| Workflow manifest and scaffold gates | Passed |
| Live gateway health | Passed |

The workspace still prints expected non-fatal diagnostic output during tests, including provider-key warnings, simulated chat transport errors, and a Vite `__dirname` future-compatibility warning. None caused test failure or runtime health failure.

A final startup edge case was also fixed: the parent directory for the SQLite workflow database is now created before the global engine opens the database, so a fresh workspace can start without a pre-existing `data/` directory.

## Follow-up hardening and soak validation

The Vite frontend configuration was updated to use ESM-safe `import.meta.url` path resolution instead of `__dirname`. The frontend test suite and production build both passed after the change, and the previous Vite `configLoader: native` compatibility warning no longer appears in the build output.

Recovery-focused verification passed with **5 suites and 43 tests**, covering workflow leases and resume behavior, JSON queue persistence and corrupt-snapshot recovery, SQLite queue behavior, scheduler timeout/catch-up behavior, and agent scheduling paths.

A first six-second soak recorded 5 successful health checks and 1 failed probe while all six metrics checks passed. The original soak report did not retain failed samples, so the monitor was improved to record `errorSamples` and `errorCounts`. A repeat twelve-second soak then passed cleanly: **12/12 health checks**, **12/12 metrics checks**, zero errors, stable RSS at approximately 134.3 MB, stable open file descriptors at 333, and 11 active resources. The transient first-run probe failure did not reproduce.
