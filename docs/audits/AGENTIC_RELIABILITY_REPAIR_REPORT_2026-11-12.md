# Miki Agentic Reliability Repair Report

**Date:** 2026-11-12  
**Base:** `miki-source-implemented.zip` supplied in this conversation  
**Scope:** Confirmed source-level agentic reliability defects and regression coverage. This is not a live deployment verification.

## Summary

Four confirmed defects were patched:

1. `heartbeat.proactive.curiosity.enabled: false` was not enforced by the ambient prompt and goal-proposal tool.
2. `max_poll_seconds` was parsed and exposed in status, but the idle supervisor loop did not use it as its sleep ceiling.
3. A detached process could finish after its originating model turn without waking the autonomy supervisor to consume its durable completion notice.
4. The `computer_observe` tool accepted an execution `AbortSignal` but dropped it before the desktop subprocess layer, so timed-out Linux/Windows observation processes could remain alive and keep the observation slot occupied.

The source already had fixed 3-second gateway model retry behavior and provider `Retry-After` floor handling. That part was audited and left unchanged.

## Changes

### 1. Enforce the curiosity opt-out

**Files**
- `packages/core/src/autonomy/autonomous-supervisor.ts`
- `packages/core/src/autonomy/autonomous-supervisor.test.ts`

The supervisor now treats curiosity as enabled only when `heartbeat.proactive.curiosity.enabled === true`. The ambient prompt reflects the setting. The server-side `autonomy_propose_goal` tool rejects proposals marked as curiosity when the setting is disabled. Ordinary user-requested, scheduled, and operational autonomy remains available.

Regression coverage checks both the prompt and the server-side rejection path, and confirms that no curiosity goal is persisted.

### 2. Apply `max_poll_seconds` to idle polling

**Files**
- `packages/core/src/autonomy/autonomous-supervisor.ts`
- `packages/core/src/autonomy/autonomous-supervisor.test.ts`
- `config/agent.yaml`

Active work continues to use `min_poll_seconds`. When idle, the supervisor sleeps no longer than `max_poll_seconds`, and shortens the wait when the next scheduled task or ambient decision is due earlier. This avoids both unnecessarily frequent idle polling and sleeping past a due event.

Regression coverage checks the configured 20-second idle ceiling, the 5-second active cadence, and earlier scheduled wake deadlines.

### 3. Wake autonomy when a detached process finishes

**Files**
- `packages/gateway/src/runtime/process-manager.ts`
- `packages/gateway/src/runtime/process-manager.test.ts`
- `packages/core/src/autonomy/autonomous-supervisor.ts`
- `packages/core/src/autonomy/autonomous-supervisor.test.ts`

`ProcessManager.onFinished()` exposes a completion subscription. It fires after process completion has been persisted, including completions detected by the durable process poller. The supervisor subscribes and wakes the ambient loop for detached processes only. The model's next turn can then consume the existing durable completion notice and inspect the result.

The existing process start/exit API and durable completion-notice mechanism remain unchanged.

### 4. Propagate desktop observation cancellation

**Files**
- `packages/gateway/src/agent/agent-runtime.ts`
- `packages/core/src/plugins/computer-use/runtime.ts`
- `packages/core/src/plugins/computer-use/runtime.test.ts`

The tool execution signal now reaches `ComputerAgent.observe()`, the platform backend, and the spawned subprocess. Linux X11 commands and Windows PowerShell execution receive the signal. If observation is aborted, the agent rethrows the abort instead of converting it into a normal formatted observation result. Linux window-enumeration catches also rethrow cancellation instead of treating it as a missing/stale window.

A Linux regression test creates a deliberately hanging fake `xdotool` executable and checks that abort terminates the observation promptly.

## Re-audit corrections and items deliberately not changed

- **Activity UI findings from the previous audit were stale for this source archive.** The current Activity UI already has learned-rule error states, schedule pagination across task types, event-trigger management, background job details/events, and reconciliation controls. No duplicate implementation was added.
- **Gateway `model-retry.ts` was already fixed.** `modelRetryDelayMs()` returns 3,000 ms for every retry index. `Retry-After` remains a minimum delay, and retries stop on cancellation or a non-retryable result. No change was needed.
- **Permanent provider failures:** the current autonomy config has `retry_permanent_provider_errors: true`; the engine supports waiting through provider authentication/quota blocks. This is an intentional always-on policy, not an unimplemented retry bug. Invalid request/model errors remain non-retryable.
- **`double_check_model` remains unset in the default configuration.** The code supports an explicit auditor model, but selecting a model ID without knowing which cloud provider/model is configured would be guesswork. A stronger independent auditor must be selected from the user's actual configured providers/models.
- **Linux X11 semantic UI automation remains a platform limitation.** It can inspect window metadata and perform coordinate/keyboard operations, but does not provide Windows-style UI Automation element discovery/invoke/text-entry. This repair makes observation cancellation safe; it does not claim to add semantic Linux controls.
- **Plugin approval gates remain in place.** They are security controls, not reliability defects. Broadly relaxing them would weaken the user's safety boundary.
- Host sleep/shutdown, unavailable credentials, disk exhaustion, and arbitrary database corruption cannot be safely auto-repaired by these source changes. They still need host-level monitoring and operator recovery procedures.

## Verification performed

| Check | Result | Evidence/limitation |
|---|---|---|
| TypeScript transpile/syntax check for 7 changed `.ts` files | PASS | `ts.transpileModule`; no syntax/transpile diagnostics |
| ProcessManager completion event isolated runtime smoke | PASS | Detached `echo` process emitted one persisted completion event; unsubscribe prevented second notification |
| Linux computer-observer abort isolated runtime smoke | PASS | Hanging fake `xdotool` was aborted; observation rejected in about 102 ms |
| `scripts/architecture-layout-contract.test.mjs` | PASS | Printed `architecture-layout-contract: PASS` |
| Core TypeScript typecheck | BLOCKED | `TS2688`: `@types/jest` and `@types/node` are absent |
| Jest/Vitest suites | BLOCKED | Test runners and required dependencies are not installed in the source workspace; dependency installation could not complete because package registry/cache was unavailable |
| Full build / full test / live gateway E2E | NOT RUN | The current environment uses Node `v22.16.0`, while the repository requires `>=22.19.0`; dependencies and a live configured provider/channel environment are not available |

The transpile check is not a substitute for typechecking. The isolated runtime smokes are not a substitute for the repository's full unit tests or end-to-end tests.

## Remaining work

1. Run the Jest/Vitest suites and typechecks in the actual development environment with Node `>=22.19.0` and all locked dependencies installed.
2. Run a live workflow: start detached build → process exits → supervisor wakes → completion notice is consumed → result is verified → follow-up goal/message is delivered.
3. Configure and validate a genuinely independent `double_check_model` using an available stronger provider/model.
4. The desktop/browser control split is implemented as OS accessibility (Windows UI Automation, Linux AT-SPI, macOS Accessibility) plus a browser-native WebExtensions bridge; do not reintroduce an embedded browser driver.
5. Run a 24–48 hour soak test with provider outage, process restart, scheduler deadlines, and durable outbox recovery.

## Conclusion

This archive contains a source-level repair for four verified defects, regression tests, and the audit report. It is **not yet production-qualified**: full test/typecheck/build and live E2E remain blocked by the current dependency/Node environment and must be run before deployment.

## Maintenance and status note

This is a dated investigation, plan, or implementation snapshot. Its findings and status labels describe the code and test evidence available when it was written; they are not a live assertion that every item remains current. Preserve this report as historical context. For present behavior, check the current source, the adjacent tests, and [Agent-Miki Operating Model](../AGENT_MIKI_OPERATING_MODEL.md) where applicable. Do not treat an unverified recommendation or an old checklist as proof of an enabled capability.
