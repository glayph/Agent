# Agent Miki Agent-Control Capability Report

## Implemented in this change

| Capability | Evidence | Verification status |
|---|---|---|
| Capability inventory | `packages/core/src/control/service.ts` and `/api/control/capabilities` | Source-reviewed; focused router test added |
| Sanitized runtime state | `AgentControlService.getState()` and `/api/control/state` | Source-reviewed; focused router test added |
| Narrow configuration preview | `previewConfigPatch()` with allowlisted prefixes and existing config validation | Source-reviewed; service test added |
| Safe configuration patch | `controller.applyPatch()` through the existing dashboard controller | Source-reviewed; service test added; full build not run in this environment |
| Tool enable/disable | `controller.setToolState()` through the existing dashboard controller | Source-reviewed; service test added |
| Runtime reload adapter | `hooks.reload()` delegates to `AgentOrchestrator.reloadConfig()` | Source-reviewed; restart-required result remains runtime-dependent |
| Operation journal | `ControlJournal` stores bounded sanitized JSON under runtime data | Source-reviewed; no secrets or raw approval tokens are written by the control service |
| Model/runtime adapter contract | `ModelRuntimeAdapterLike` and `ModelRuntimeAdapter` | Source-reviewed; adapter interface is reusable |
| llama.cpp inspection/activation | `createLlamaCppAdapter()` delegates to existing local-runtime health and synchronization functions | Source-reviewed; real native runtime probe not run |
| Active model selection | `LauncherAdminController.setActiveModel()` validates configured/supported models, persists provider-facing identity, synchronizes provider/runtime, and reports restart state | Source-reviewed; target provider/runtime probe not run |
| Dashboard control surface | `/control` route, synchronized route manifest, sidebar item, API client, reversible resource/tool controls, pending-approval list, and localized navigation labels | Source-reviewed; browser visual verification not run |

## Approval-gated operations

Remote-origin configuration writes, model/runtime activation, model installation/removal, service control, external MCP/skill acquisition, and other side effects require the persisted approval inbox when the service is wired through `packages/core/src/api/index.ts`. Approved requests are context-bound and consumed once before mutation. Approval tokens are not returned by the control API or stored in the journal.

## Explicitly not claimed as fully autonomous

General model downloads, native runtime/dependency installation, arbitrary provider registration, credential management, destructive deletion, factory reset, arbitrary shell/file mutation, unrestricted service management, and third-party package/code execution are not claimed as autonomous features by this change. These require dedicated adapters, compatibility/integrity checks, and explicit owner approval.

## Tests added

`packages/core/src/control/service.test.ts` covers capability boundaries, secret redaction, unsupported configuration paths, safe tool-state mutation, and remote-origin approval gating. `packages/core/src/control/router.test.ts` covers the capability and sanitized-state HTTP routes.

## Verification limitations

Validation completed in the repository workspace. The core TypeScript build passed, core lint passed, the frontend production build passed, the full frontend lint passed, the frontend suite passed with 53 tests across 13 files, and the repository `npm run verify` workflow completed successfully after rebuilding the native `better-sqlite3` binding. The doctor stage still reports two environment warnings: Go is not installed, and some runtime build artifacts require the production build flow. A real llama.cpp process probe, live provider completion probe, 24/7 supervisor run, and browser screenshot pass remain target-machine checks.

The user-provided credentials and tokens were not copied into source, documentation, operation logs, or deliverables. Any credentials that were exposed in prior messages should be rotated before production use.
