# Adaptive Unlimited Autonomy Engine — implementation report

This report records the source-level AUAE work completed in this update. It distinguishes existing architecture, changes made here, and checks that still require a fully provisioned runtime.

## Changes made

### Model routing and provider recovery

- `model_router.max_attempts` remains readable for configuration compatibility but no longer truncates explicitly configured model fallback routes.
- Credential fallback profiles are no longer sliced by the legacy model-route attempt counter.
- A model explicitly classified as unavailable/unsupported can move to the next configured model route. A generic HTTP 400 remains a permanent `invalid_request`; Miki does not blindly retry malformed requests or repeatedly send the same invalid payload to every model.
- Provider rate-limit errors now preserve a parsed `retryAfterMs` value. Both a provider response's `Retry-After` header and supported provider-body `retryDelay` text are considered. The engine waits at least that long before retrying.
- Long waits are split into timer-safe intervals so Node's maximum `setTimeout` delay does not overflow.

### Terminal evidence

- Terminal tool results continue to expose incremental `new_stdout`/`new_stderr` during polling.
- Running and final results also expose retained cumulative `stdout_tail`/`stderr_tail`, total character counts, delivered character counts, and `output_was_empty`.
- Final `stdout`/`stderr` remain incremental deltas for compatibility. The cumulative tail makes a final result auditable even if an earlier poll already delivered all output.

### Computer capability and observation recovery

- Added the read-only `computer_capabilities` tool so the agent can inspect the actual runtime's screenshot, process-listing, window-observation, and semantic UI capabilities before planning desktop work.
- First-run environment discovery now probes actual capabilities before adding screenshot evidence to its acceptance contract. A registered screenshot tool alone is no longer treated as proof that the current OS/display can capture a screen.
- Ambient observation timeout is configurable through `heartbeat.proactive.observation_timeout_ms` (default 15 seconds), increases after repeated slow calls, and returns to the configured value after a successful observation.
- If an observer ignores cancellation and remains unresolved after a timeout, the supervisor does not start another duplicate observer call. The slot is released only when the original call settles.

### Legacy durable task migration

- Startup upgrades still-active legacy `background_agent` and `background_goal` rows to `max_attempts=-1`. This includes queued, running, retrying, verifying, waiting-approval, blocked, and reconciliation-needed tasks.

## Important architecture already present and retained

The supplied source already had several AUAE foundations; they were retained rather than rewritten:

- The agent engine defaults tool iterations, calls, and turns to unbounded values unless a caller explicitly supplies a per-run override.
- Agent engine goal execution has no default wall-clock deadline (`0` means no overall timeout); cancellation remains available.
- Durable autonomous tasks use `maxAttempts=-1`, persisted checkpoints, leases, idempotency keys, and recovery/reconciliation paths.
- The autonomous supervisor continues to monitor/replan durable work and uses provider backoff rather than ending a goal solely because it has taken a long time.
- The host resource manager samples CPU/load, memory, and disk pressure. It adjusts admission of new work and does not kill work already running.
- The terminal process manager persists process metadata and bounded output logs when configured with the database/data directory, reattaches to verifiably live processes after restart, and marks uncertain processes interrupted instead of risking a signal to a reused PID.
- Context/history compaction and memory retrieval are already present.

## Limits deliberately retained

These are not goal-lifetime or autonomous-iteration ceilings; they protect system integrity or represent real external constraints:

- In-memory output tails and persisted process logs remain bounded. Full logs are persisted separately where configured; the agent receives a tail plus byte/character counters.
- Context compaction bounds each model request to the provider's context window. Task objectives, checkpoints, and relevant memory are used to reconstruct later requests.
- A single provider request/stream has a liveness timeout (the OpenAI-compatible adapter defaults to 120 seconds). A timed-out provider call can be retried at the same engine step; it does not impose a total goal deadline. Provider timeout settings and actual long-thinking behavior still need live-provider validation.
- Shared desktop/browser resource leases and host resource admission remain in place to prevent conflicting actions and resource exhaustion.
- Explicit `timeout_seconds` on terminal commands still means the owner/model deliberately requested a hard stop. It is unset by default; long-running commands are polled and can remain active.
- Provider rate limits, billing entitlements, operating-system capabilities, and external service outages are not bypassed.

## Validation performed in this environment

- TypeScript syntax transpilation: passed for all 15 changed TypeScript files. This checks parsing/transpilation, not full cross-package type correctness.
- YAML parse: passed for `config/agent.yaml`.
- `package.json` and `package-lock.json` JSON parse: passed.
- Targeted runtime smoke checks: passed for complete model fallback-chain handling, provider retry metadata, model-unavailable diagnostics, and `Retry-After` parsing.
- Terminal process smoke check: passed; output delivered by an earlier poll remains available in the final cumulative output tail.

## Validation not completed

- `npm ci` could not complete because the npm registry was unreachable from the execution environment (`EAI_AGAIN`). The partially created `node_modules` directory was not included in the deliverable archive.
- The available Node runtime was `v22.16.0`; the project requires Node `>=22.19.0`.
- Jest/Vitest unit suites, full TypeScript type checking, linting, `npm run build:all`, browser integration, live Gemini/API tests, desktop UI automation, crash-chaos tests, and the 24-hour soak test were therefore not run. No pass result is claimed for them.

## Remaining platform/runtime work

1. Capture the actual Gemini 400 response body, provider code/type, model identifier, and sanitized request shape from a live request. The source can distinguish `model_not_found` from generic `invalid_request`, but cannot infer which one caused an earlier run without that evidence.
2. Linux X11 observation in the supplied backend reports window metadata but does not provide semantic UI controls. The new capability probe prevents Miki from assuming otherwise. A full Linux semantic UI implementation (for example, an AT-SPI backend) remains platform integration work; existing screenshot/coordinate functionality is not removed.
3. The ZIP did not include the runtime SQLite database, chat history, execution trace, recovery log, or crash stack traces. The two reported process restarts cannot be root-caused from source alone.
4. Full build/test verification requires Node `>=22.19.0` and restored npm dependencies.

## Run commands

From the project root, using Node `>=22.19.0`:

```bash
npm install
npm run build:all
npm run dev
```

## Maintenance and status note

This is a dated investigation, plan, or implementation snapshot. Its findings and status labels describe the code and test evidence available when it was written; they are not a live assertion that every item remains current. Preserve this report as historical context. For present behavior, check the current source, the adjacent tests, and [Agent-Miki Operating Model](AGENT_MIKI_OPERATING_MODEL.md) where applicable. Do not treat an unverified recommendation or an old checklist as proof of an enabled capability.
