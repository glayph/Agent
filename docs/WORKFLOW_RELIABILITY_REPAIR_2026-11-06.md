# Miki Workflow Reliability Repair

Date: 2026-11-06
Base: Miki Autonomous AI Agent v1.3.14 source archive supplied in this conversation.

## Changes made

1. **Removed the engine-imposed LLM request timeout.** The engine no longer calculates a timeout that doubles after each transient retry and no longer passes `timeoutMs` to the provider. A request is allowed to settle naturally. The owning run's AbortSignal still supports explicit cancellation/shutdown. Retry/backoff begins only after the provider call rejects.
2. **Updated the retry regression test.** The test now asserts that no per-request timeout is passed on the initial request or after a transient failure.
3. **Added independent autonomous goal/task lease renewal.** Goal and task leases are now renewed every 60 seconds while an autonomous goal run is executing, independently of streamed/model/tool events. The timer is unref'ed and cleared when the run ends. This prevents a quiet-but-live provider request from losing its five-minute lease solely because no event was emitted.
4. **Updated the LLM completion option documentation** to state that `timeoutMs` is optional and omitted by the engine so calls can finish naturally.

## Existing mechanisms confirmed in source

- Transient provider errors can retry indefinitely when no finite `maxRetries` ceiling is supplied; cancellation remains available.
- Terminal processes are tracked by stable process IDs and their status/output are persisted. The process manager can restore running process records after restart.
- Finished terminal commands are collected as notices and injected into the next model turn; the runtime also lists previously running commands at the beginning of a run.
- Shared interactive-resource waits are cancellation-aware and use renewable leases, but intentionally have no elapsed-time deadline.

## Important remaining limitation

The terminal completion notice is currently delivered on the **next model turn**. The source does not yet contain a verified event path that automatically wakes a fully idle agent at the exact moment a detached/background terminal command exits. This repair does not claim to have implemented that wake-up behavior. It preserves the existing process tracking and next-turn notice mechanism.

Also, removing the LLM timeout means a provider request that never resolves and never rejects will remain pending until the run is explicitly cancelled or the provider/runtime resolves it. This is the requested no-time-limit behavior; automatic retry cannot begin until the current call actually settles.

## Verification

- TypeScript transpile/syntax checks passed for all four changed TypeScript files.
- Full typecheck and test suite were not run: dependencies are not installed in this extracted source tree, the runtime Node version is 22.16.0 while package.json requires >=22.19.0, and prior install attempts in this environment encountered npm registry DNS errors.
- No live LLM/provider or terminal process end-to-end test was possible here.
