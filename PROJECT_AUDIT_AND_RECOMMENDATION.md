# Agent Miki — Project Audit and Improvement Recommendation

**Audit scope:** Core runtime, Automation Center, scheduler, linked Runs, frontend, gateway, persistence, security defaults, tests, build scripts, and release workflow.

**Audit status:** The main Automation Center workflow is operational for internal and research tasks. A live manual execution and recurring scheduled executions reached `completed` and appeared in the linked execution history. The project is usable for local development, but it is not yet production-ready for unattended external publishing or 24/7 deployment.

## Executive assessment

> **Agent Miki is now automation-capable, but the next major improvement should be reliability and control of side effects rather than adding more UI features.**

The current implementation has a sound foundation: persistent automation definitions, recurring schedules, one-time execution, retry-aware scheduler persistence, linked Agent Runs, execution history, pause/resume/disable actions, and a working Automation Center. The scheduler now survives restarts through a persistent SQLite task store, and fresh manual and recurring tasks were verified in the live dashboard.

The most important remaining gap is that the product surface suggests more capability than the implementation currently guarantees. Facebook Page and YouTube are available as target choices, and automatic publishing is exposed as an approval mode, but no complete platform adapter, OAuth lifecycle, external receipt, idempotency key, or publish-state machine was found. Those controls should therefore remain explicitly draft/review-oriented until real adapters are implemented.

## Findings by area

| Area | Assessment | Evidence / implication |
|---|---|---|
| Automation definitions | **Working** | Definitions can be created, listed, paused, resumed, disabled, and run immediately through the authenticated API and Automation Center. |
| Recurring scheduling | **Working after runtime fixes** | Recurring expressions are persisted, recovered, and produce separate linked executions for each firing. |
| One-time execution | **Working** | `Run now` creates a scheduled task and a linked Agent Run; a live smoke test reached `completed`. |
| Runs integration | **Working** | Automation executions retain `runId` values and appear in the Automation Center history; the Runs page can serve as the execution evidence layer. |
| Research automation | **Usable** | Internal/research prompts can be scheduled and recorded. Source-quality policy and structured report outputs should be strengthened next. |
| Facebook / YouTube | **Not implemented as real adapters** | Target types and UI labels exist, but a platform API adapter, OAuth, token refresh, upload/publish receipt, and failure recovery flow are not yet present. |
| Approval workflow | **Partially implemented** | Approval mode is persisted and displayed, but an external publish state machine and explicit approval action are not yet enforced end-to-end. |
| 24/7 operation | **Foundation exists** | Persistent scheduler state and restart recovery exist, but health monitoring, worker supervision, dead-letter operations, and deployment documentation need hardening. |
| Frontend localization | **Incomplete** | The new Automation Center contains substantial hardcoded English copy instead of using the existing locale system. |
| Automation-to-Runs navigation | **Incomplete** | Linked execution rows show shortened Run IDs but do not provide a direct deep link to the selected Run detail. |
| Test suite | **Blocking quality gap** | `npm test` exits with failure because 17 installer suites cannot be parsed; Jest reports zero executed tests for those suites. |
| Build reliability | **Needs hardening** | Core and gateway build scripts use `tsc ... || exit 0`, which can hide compiler failures. |
| Verification workflow | **Disconnected** | `scripts/run-verify.mjs` describes an `npm run verify` workflow, but the root package scripts do not expose a `verify` command. |
| Model configuration | **Stale default risk** | `.env.example` still contains the retired-style `google/gemini-2.0-flash-001` default while the live test used `gemini-3.6-flash`. |
| Security defaults | **Safe for isolated development only** | `config/agent.yaml` enables full system access, bypass restrictions, risk acceptance, and unrestricted filesystem scope by default. These defaults are unsuitable for a shared or internet-exposed deployment. |

## Highest-impact recommendation

### Build an Automation Execution Contract and Verification Gate

The next major feature should be a unified **Automation Execution Contract**. It should be the only path through which an automation can perform an external side effect. This contract would combine typed platform adapters, explicit approval states, idempotent execution, linked evidence, and mandatory verification tests.

The goal is not simply to add Facebook or YouTube buttons. The goal is to make every automation action explainable, reversible where possible, and safe to retry.

### Recommended execution state machine

```text
DRAFT
  ↓
SCHEDULED
  ↓
RUNNING
  ↓
REVIEW_REQUIRED ── reject ──→ CANCELLED
  │
  approve
  ↓
EXECUTING_SIDE_EFFECT
  ↓
SUCCEEDED ──→ VERIFIED
  │
  retry policy
  ↓
FAILED ──→ RETRY_WAIT / DEAD_LETTER
```

### Implementation sequence

| Phase | Work | Completion signal |
|---|---|---|
| 1. Contract | Define `AutomationAction`, `TargetAdapter`, `ApprovalState`, `ExternalReceipt`, idempotency key, and structured action result types. | TypeScript contracts compile and invalid target/action combinations are rejected. |
| 2. Adapter registry | Register only implemented adapters. Keep Facebook and YouTube hidden or marked unavailable until OAuth and API support exist. | The UI cannot offer an action that has no executable adapter. |
| 3. Approval | Add explicit `Review required`, `Approve`, `Reject`, and `Cancel` operations. Persist the approver, timestamp, reason, and policy decision. | A publish-mode automation cannot execute a side effect without an approval record unless an explicit trusted policy allows it. |
| 4. Idempotency | Create one idempotency key per automation execution and store external platform receipts. | Retrying a task cannot create duplicate posts or uploads. |
| 5. Run evidence | Attach adapter request summary, sanitized response, external ID/URL, approval event, and verification result to the linked Run. | `/runs` explains what happened without exposing credentials or raw secrets. |
| 6. Verification gate | Add scheduler restart, run-now, recurring, failure, retry, approval, and adapter-mock tests. | A single verification command fails fast when any quality gate fails. |
| 7. Deployment | Add worker health, heartbeat, stale-task recovery metrics, dead-letter inspection, and 24/7 startup documentation. | A restart or transient API failure is observable and recoverable without manual database repair. |

## Immediate hardening tasks

The following should be completed before external publishing is enabled:

1. Configure Jest with `ts-jest` or an equivalent ESM-compatible transformer for the installer package, remove or explicitly exclude duplicate test trees, and make `npm test` execute real tests rather than failing during parsing.

2. Remove `|| exit 0` from the core and gateway build scripts. A compiler error must produce a nonzero exit code. Add strict typechecking to the root verification command.

3. Add the missing root `verify` script and make it run lint, tests, strict builds, frontend build, and `miki doctor` in a deterministic order.

4. Replace the stale model default with a provider/model discovery strategy. A configured model should be validated at startup and surfaced clearly when retired or unavailable.

5. Change the production configuration profile to deny-by-default: workspace-scoped filesystem access, restricted system access, `risk_acceptance: false`, API-key authentication enabled for non-local binding, and MCP disabled unless explicitly configured.

6. Add a direct Automation Center → Runs link for every execution, and move all new Automation Center copy into the existing locale files.

7. Keep Facebook and YouTube in `coming soon` or `review-only` state until real OAuth-backed adapters and mocked integration tests exist.

## Suggested product direction

Agent Miki should become a **trusted personal automation operating system**, not merely a collection of agent tools. The differentiator should be that every scheduled action has a clear objective, a durable Run, evidence, approval history, retry policy, and an understandable outcome. Research tasks can be the first production-grade automation category; external publishing should follow only after the execution contract and approval model are complete.

## References

[1]: `packages/core/src/automation.ts` — Automation definitions, executions, schedule validation, linked Runs, and lifecycle transitions.

[2]: `packages/core/src/scheduler.ts` — Recurring schedule parsing, persistence recovery, retry, and task execution.

[3]: `packages/core/src/agent.ts` — Agent runtime, scheduler startup, task execution, and automation lifecycle integration.

[4]: `packages/ui/frontend/src/features/agent/automations/automations-page.tsx` — Automation Center UI, target choices, approval controls, and linked execution history.

[5]: `packages/installer/package.json`, `packages/installer/tsconfig.json` — Installer test command and TypeScript test exclusion/configuration gap.

[6]: `scripts/run-verify.mjs` and `package.json` — Intended verification flow and missing root `verify` script.

[7]: `config/agent.yaml` and `.env.example` — Runtime security defaults and provider/model configuration.
