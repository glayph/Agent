# Miki: Self-Activation, Long-Running Autonomy & Self-Recovery Audit

**Reviewed source:** `Miki-Autonomous-AI-Agent-deep-debug-fixed.zip`  
**Review date:** 2026-11-08  
**Scope:** startup without user messages; unattended operation over 1–2 days or longer; persistence, restart supervision, retries, self-replanning, and limits of self-repair.

## Executive conclusion

1. **Self-activation without a user message: implemented in source.** When the Gateway starts, `configureRuntimeLoop()` starts the `AutonomousSupervisor` unless the autonomy setting or `MIKI_AUTONOMY_ENABLED` explicitly disables it. With the shipped defaults (`heartbeat.proactive.enabled`, `llm_when_idle`, `startup_decision` all true), the supervisor schedules a startup ambient LLM decision. No chat message or activation prompt is required.
2. **Unattended operation for days: supported by the design, conditionally.** There is no configured goal lifetime or ambient-loop lifetime ceiling in this path. Goals/tasks are persisted in SQLite; stale leases can be recovered; the supervisor loop restarts after unexpected loop exit; the outer 24/7 wrapper restarts a crashed or unresponsive Gateway. This only works while the host is powered, awake, the OS service/task remains enabled, storage is usable, and required providers/network/model remain available.
3. **Self-repair: partial, not general-purpose.** Miki can retry transient provider/network failures, replan a failed goal, recover stale goal/task claims, replay interrupted chat messages, and restart a crashed/hung Gateway. It cannot reliably fix invalid credentials, depleted provider entitlement, missing OS permissions, hardware faults, persistent network outages, disk exhaustion, database corruption, or every defective tool/plugin. Such cases require configuration changes, system-level remediation, or owner action.
4. **Not verified for an actual 24–48-hour run.** The source contains tests for no-message self-start and wrapper crash recovery, but the real AgentEngine + SQLite autonomy E2E Jest suite could not be executed in this environment. A true multi-day soak on the target machine remains required.

## 1. Evidence that Miki can activate without a message

### Configuration defaults

`config/agent.yaml`:

- `heartbeat.proactive.enabled: true`
- `heartbeat.proactive.llm_when_idle: true`
- `heartbeat.proactive.startup_decision: true`
- `heartbeat.proactive.idle_after_seconds: 0` (no user-inactivity countdown)
- `heartbeat.proactive.decision_interval_seconds: 5`
- `heartbeat.proactive.curiosity.enabled: true`
- `autonomy.enabled: true`
- `autonomy.unlimited_budgets: true`

### Startup path

- `packages/gateway/src/index.ts:3168-3184` defines `configureRuntimeLoop()`. It checks `MIKI_AUTONOMY_ENABLED=false` and `autonomy.enabled=false`, otherwise calls `autonomy.start()`.
- `packages/gateway/src/index.ts:3230` invokes `configureRuntimeLoop()` as part of Gateway startup.
- `packages/core/src/autonomy/autonomous-supervisor.ts:3153-3175` starts the supervisor and requests an immediate ambient decision when proactive + idle LLM + startup decision are enabled.
- `packages/core/src/autonomy/autonomous-supervisor.ts:3261-3341` is a persistent host-side loop. It does not depend on the language model calling itself again.
- `packages/core/src/autonomy/autonomous-supervisor.ts:2923-3024` builds the autonomous decision prompt from environment observation, pending work, identity files, user preferences, interests, drives, heartbeat checklist, recent discoveries, memory and recent conversation.
- On a first, empty install, `maybeCreateBootstrapGoal()` creates an environment-exploration goal without waiting for a user message (`autonomous-supervisor.ts:2700-2762`).

The project also includes an explicit no-user-message integration test in `packages/core/src/autonomy/autonomy-e2e.test.ts:11-14,79-106`; it expects `supervisor.start()` to initiate an ambient LLM request and execute a tool without a user message. This test was inspected but not executed here because the Jest/SQLite dependencies are absent.

## 2. What Miki does while idle

Idle mode is a decision-and-work scheduler, not a guarantee that Miki continuously performs useful operations every second.

- It makes a startup decision, then performs additional ambient decisions on the configured quiet-environment cadence (minimum 5 seconds; shipped default 5 seconds).
- Events and completed goals can wake the decision loop earlier.
- An ambient decision can inspect/research/decide and propose a durable goal. The ambient lane is intentionally read-only for arbitrary workspace mutations and shell/external side effects (`autonomous-supervisor.ts:3022-3037`).
- A separate durable goal-execution lane performs the approved work and checks completion.
- When there is no useful work, the prompt explicitly tells Miki not to invent tasks and to wait for the next observation/event.
- Routine heartbeat activity is silent; owner messages are intended for meaningful discoveries or updates, not every heartbeat.

The workspace ships with useful material for self-directed activity: `identity/HEARTBEAT.md`, `identity/INTERESTS.md`, and `identity/DRIVES.md`.

## 3. Long-running persistence and recovery

Implemented mechanisms found:

- Persistent goals and scheduled tasks in SQLite (`autonomy_goal_runs`, `autonomy_task_queue`, `autonomy_goal_claims`, related tables).
- On supervisor construction, `recoverStaleGoalClaims()` and `recoverPersistentTasks()` run (`autonomous-supervisor.ts:623-624,1368-1491`).
- Goal and task leases are renewed during execution; stale claims/leases are checked on heartbeat.
- Goal failures preserve run/replan history and return non-terminal failures to `retry_wait` with a new retry time (`autonomous-supervisor.ts:3725-3789,3827-3871`).
- Unexpected supervisor-loop exit is restarted with a bounded restart delay; the loop itself does not permanently stop merely because one tick failed (`autonomous-supervisor.ts:3177-3215,3261-3341`).
- The outer Node supervisor restarts a crashed Gateway indefinitely while the supervisor process remains alive; it probes `/gateway/live` and `/gateway/health` and kills/restarts an unresponsive child (`scripts/miki-24-7.mjs`).
- Linux systemd unit uses `Restart=always` and `StartLimitIntervalSec=0` (`deploy/linux/systemd/agent-miki.service.in`). macOS launchd uses `RunAtLoad=true` and `KeepAlive=true` (`deploy/macos/com.miki.agent-24-7.plist.template`). Windows uses a boot-triggered Scheduled Task (`deploy/windows/Install-AgentMiki.ps1`).

## 4. Self-repair: what it can and cannot do

| Failure | Source-supported behavior | Limitation |
|---|---|---|
| Gateway process exits | Outer supervisor restarts it | Does not fix the root cause; repeated restarts can continue indefinitely |
| Gateway event loop hangs | Watchdog probes liveness, kills and restarts it | Only works while outer supervisor/OS supervisor is alive |
| Supervisor loop throws | Loop is relaunched with backoff | A persistent bug can cause a repeated restart cycle |
| Transient LLM/network failure | Retry/backoff and provider health tracking | Cannot create network connectivity or fix remote outage |
| Provider rate limit/quota | Wait/retry behavior is configured | Cannot raise provider quota or entitlement |
| Invalid API key/permission | Classified and retried/recorded; runtime can wake after config changes | Miki cannot infer or generate a valid secret; owner must repair credentials/permissions |
| Goal/tool failure | Replanning, alternate approach instructions, repeated-failure tracking | Does not guarantee a successful alternative exists |
| Stale task/goal lease | Reconcile and resume queued/active persistent work | Non-idempotent external effects must be reconciled before replay |
| Interrupted chat message | Startup replay/recovery paths | Not every unfinished external side effect can be automatically replayed safely |
| DB corruption/disk full/OS/hardware fault | Health reports/logs and process restart may expose/retry | No general database repair, disk provisioning, hardware repair or OS repair engine |
| Owner-action/approval blocker | Goal becomes blocked and notice is sent | It waits for owner to change permission/approve; this is intentional safety behavior |

The autonomous executor's terminal goal failure is deliberately narrow (`isTerminalGoalFailure` returns true for `owner_action` only, `autonomous-supervisor.ts:222-229`). Infrastructure and provider failures are kept retryable. This improves persistence but cannot turn a non-repairable external condition into a repaired system.

## 5. Important operational prerequisites

### To start now

After compatible Node.js and dependencies are installed and the project is built, start the supported long-running development/runtime command:

```bash
npm install
npm run build:all
npm run dev
```

In this repository, `npm run dev` runs `scripts/dev.js`; that script builds the project, then launches `scripts/miki-24-7.mjs` as a child supervisor. It is not a hot-reload-only server. The terminal/session running it must remain alive unless it is managed by an OS service.

The exact archive reviewed here has source but no build artifacts. `node scripts/miki-24-7.mjs --check` returned `ok: false` because `packages/gateway/dist/index.js` is absent. Package engines require Node `>=22.19.0`; this review container has Node `v22.16.0`.

### To start after reboot / keep alive unattended

Install the OS-level service/task as well as configure Miki:

- Linux: install and enable the supplied systemd unit.
- macOS: install the supplied launchd job.
- Windows: install the boot-triggered Scheduled Task.

Power settings must prevent the machine from sleeping/hibernating if uninterrupted work is required. A powered-off or sleeping host cannot execute LLM calls or tools.

Windows-specific caveats found in the installer:

- The task defaults to `NT AUTHORITY\LOCAL SERVICE`, not the signed-in desktop user. Computer-use tools that need the interactive desktop may therefore be unavailable.
- Task Scheduler is configured with a 3650-day task execution time limit and 999 scheduler restarts. The PowerShell supervisor's inner gateway restart loop is configured for unlimited restarts, but the Task Scheduler wrapper itself is not literally infinite.

## 6. Important findings / remaining defects or risks

1. **`curiosity.enabled` is not consumed by the autonomy runtime.** The config key exists at `config/agent.yaml:215-218`, but code search found no runtime read; the ambient prompt always says to consider curiosity (`autonomous-supervisor.ts:3022`). Setting this flag false may not disable curiosity goal proposals.
2. **Ambient decisions can be expensive/frequent.** The configured minimum/default cadence is 5 seconds (`config/agent.yaml:184-190`; runtime minimum in `autonomous-supervisor.ts:674`). If no task is created, Miki may ask the configured LLM for another ambient decision frequently. Provider backoff and resource admission still apply. This is not a promise of continuous productive work; it is repeated observe/decide cycles.
3. **Permanent provider failures are retried very aggressively by the shipped defaults.** `model_retry_seconds: 3`, `retry_permanent_provider_errors: true`, and `failure_backoff_max_seconds: 3` mean an invalid key, exhausted entitlement, or similar permanent provider error can keep generating retry attempts roughly every 3 seconds (subject to provider `Retry-After`). Retrying cannot repair a revoked key or quota; it can create noisy logs and additional throttling. The owner must restore credentials/entitlement or change provider configuration.
4. **The ambient observer can remain stuck after a timeout.** `observeAmbientEnvironment()` retains the original promise in `ambientObservationInFlight` until that promise actually settles (`autonomous-supervisor.ts:2871-2900`). If a platform observer ignores `AbortSignal` and never settles, later ambient cycles will not start a fresh observation. The loop continues, but its desktop observation may remain stale/unavailable.
5. **`max_poll_seconds` appears informational rather than the actual loop sleep ceiling.** It is parsed and exposed in status, but the main loop sleep uses `minPollSeconds` (`autonomous-supervisor.ts:670,938,3323-3330`). This is configuration/documentation drift, not a hard stop.
6. **A 24/7 wrapper is not protection against host shutdown/sleep.** The service manager can restart processes, not supply power or guarantee network/provider availability.
7. **Windows interactive desktop context needs an explicit owner-session setup.** Default Local Service account is not an interactive user desktop session.
8. **The system has no general self-healing programmer for arbitrary defects.** It can replan task failures and restart services, but there is no guarantee that it can diagnose and patch its own source, repair a corrupt DB, fix every broken package, or restore lost credentials without owner help.

## 7. Verification performed in this review

Executed successfully:

- `node scripts/miki-24-7.integration.test.mjs` — passed. It covers healthy shutdown, repeated Gateway crash/restart, and detection/restart of a hung mock Gateway. It does **not** test real LLM autonomy or a multi-day run.
- `node scripts/miki-24-7-policy.test.mjs` — 4/4 passed.
- `node scripts/miki-model.test.mjs` — 13/13 passed.
- `node scripts/miki-24-7.mjs --check` — correctly reported `ok: false` because the Gateway build artifact is missing from this source archive.

Not executed / not verified:

- `packages/core/src/autonomy/autonomy-e2e.test.ts` (real AgentEngine + supervisor + SQLite, scripted LLM, no user message) — requires Jest and native SQLite dependencies not present in the review environment.
- Full Jest/Vitest suite, semantic TypeScript typecheck, full build and real 24–48-hour soak.
- Real target-machine behavior across sleep/resume, reboot, provider outage, credentials repair, local model restart and interactive desktop integration.

## Final verdict

**Yes:** after Gateway/service startup and valid model configuration, the current code is designed to activate itself without any user chat message.  
**Yes, conditionally:** it is designed to run for multiple days or longer while the host and OS-level supervisor remain active.  
**Partially:** it can self-recover from several software/runtime/provider interruptions and replan some failed work, but it cannot autonomously repair every external/system-level problem.  
**Not yet proven:** no real one-day or two-day soak test was run in this review environment.

## Maintenance and status note

This is a dated investigation, plan, or implementation snapshot. Its findings and status labels describe the code and test evidence available when it was written; they are not a live assertion that every item remains current. Preserve this report as historical context. For present behavior, check the current source, the adjacent tests, and [Agent-Miki Operating Model](../AGENT_MIKI_OPERATING_MODEL.md) where applicable. Do not treat an unverified recommendation or an old checklist as proof of an enabled capability.
