# Autonomous Workflow Replacement

## Removed old workflow

The previous `WorkflowEngine` was removed and replaced in place. It performed a single plan, executed each step once, and stopped on the first executor exception or failed verification. It did not own durable task-flow state, resumable checkpoints, background execution, or single-flight task protection.

No parallel legacy workflow was retained.

## Added workflow

The replacement engine in `packages/core/src/workflow-engine.ts` is the single orchestration path for:

> Input → Context/Memory → Plan → Execute Tools → Observe Result → Verify → Continue/Recover → Final Result.

It adds durable `WorkflowState` checkpoints after planning, each attempt, recovery, heartbeat, and verification. `InMemoryWorkflowStateStore` supports process-local execution and `JsonWorkflowStateStore` provides atomic file-backed persistence. Interrupted states remain resumable through `resume(taskId, input)`; completed and cancelled task identifiers cannot be rerun.

Executor failures and unsuccessful retryable results are diagnosed, passed to the optional recovery hook, retried within a bounded `maxRetries` limit, and then either continue or fail. The loop checks cancellation between phases. `startBackground` provides detached execution with cancellation, while `heartbeatIntervalMs` updates durable liveness timestamps during long-running work. An in-process single-flight map ensures concurrent calls for the same task identifier share one promise and execute only once.

Existing recorder, provider, tool, permission, memory, UI, and sandbox boundaries are preserved. The old engine's public planner/executor/verifier contracts remain compatible, with additional optional context, memory, recovery, progress, retry, heartbeat, task, and background capabilities.

The supplied `plan-capability-analyzer-fix.zip` was also integrated into the updated ZIP source. Its exact registered-tool matching prevents false “unsupported capability” reports when a tool description does not repeat the user's wording, while its planning guidance still requires approval for acquiring genuinely new skills, plugins, libraries, or credentials. The updated analyzer tests pass.

## Verification

| Scenario | Result |
| --- | --- |
| Normal single task | Passed |
| Multi-step autonomous task | Passed |
| Tool failure, recovery, retry, and continuation | Passed |
| Interrupted task and resume | Passed |
| Background task | Passed |
| Duplicate/concurrent task protection | Passed |

Command executed:

```text
NODE_OPTIONS=--experimental-vm-modules packages/installer/node_modules/.bin/jest --config=jest.core.config.cjs --runInBand --forceExit packages/core/src/workflow-engine.test.ts
```

Result: **1 test suite passed, 6 tests passed**.

The plan capability analyzer suite also passed with **1 suite and 3 tests**. The local Gemma 4 E2B Instruct Q4_0 model was downloaded from the pinned catalog source, SHA-256 verified, served by the bundled llama.cpp runtime on `127.0.0.1:39200`, and answered a deterministic chat probe with `GEMMA_LOCAL_OK`.

The repository-wide typecheck was also attempted. It is currently blocked by unrelated baseline dependency/build issues in `@miki/config` (missing `dotenv` and `zod`) and pre-existing unresolved workspace package declarations. The changed files pass ESLint with zero warnings.
