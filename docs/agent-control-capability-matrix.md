# Agent Miki Capability Audit and Control Matrix

**Audit status:** Source-level audit completed for the current repository snapshot. Runtime/provider claims remain marked as verified, configuration-dependent, or unverified unless existing documentation or tests provide evidence.

## Architecture summary

Agent Miki is a Node.js/TypeScript monorepo with a Go launcher and React dashboard. `packages/core/src/agent.ts` owns orchestration, tools, scheduling, heartbeat, memory, skills, model selection, and runtime reload. `packages/core/src/api/index.ts` assembles authenticated HTTP/WebSocket routes, the orchestrator, approval inbox, persistent jobs, channels, skills, search, memory, voice, and launcher compatibility routes. `packages/core/src/api/launcher-compat.ts` owns the dashboard-facing compatibility API and already provides a `LauncherAdminController` with sanitized config reads, validation, patch application, tool-state changes, runtime apply status, provider/model catalogs, search settings, channels, skills, memory, and health flows.

The dashboard is under `packages/ui/frontend` and has existing API clients/pages for models, credentials, tools, channels, skills, config, memory, health, logs, gateway, runs, automations, and voice. The current repository also contains persistent scheduler/job infrastructure, memory databases, MCP session/control paths, approval inboxes, plugin/skill governance, local runtime helpers, and cross-platform launcher scripts.

## Capability matrix

| Capability | Existing implementation/evidence | Current control surface | Operation class | Verification | Status / limitation |
|---|---|---|---|---|---|
| Agent chat/orchestration | `packages/core/src/agent.ts` and `AgentOrchestrator.runAgentLoop` | Authenticated `/api/chat`, WebSocket routes, channels | Read/write execution | Stream completion and tool events | Verified in repository documentation; provider response depends on credentials |
| Tool catalog and tool execution | `packages/core/src/tools/`, MCP server, tool auth middleware | Dashboard tools API and core tool execution | Read; execution varies by tool | Tool definitions, guarded execution result | Existing catalog is broad; generic remote mutation remains restricted |
| Tool enable/disable | `LauncherAdminController.setToolState`, config-backed tools state, and shared control service | Dashboard Tools page and Agent Control | Reversible configuration write | Reload/apply status and state read-back | Implemented through the typed control wrapper; tool permission policy still applies |
| Runtime configuration read/validate/patch | `launcher-compat.ts`, `validateRuntimeConfig`, secret vault, and shared control allowlist | Dashboard Config page and Agent Control | Read/validated write | Schema validation, reload status, read-back | Implemented for the documented reversible prefixes; secrets and destructive fields remain excluded |
| Provider/model catalog | Provider registry, stored model catalog, launcher model routes | Dashboard models/credentials pages | Read | Catalog/readiness and completion probe | Existing provider options include cloud and local entries; live credential health is environment-dependent |
| Active model selection | Launcher model state, settings, and `LauncherAdminController.setActiveModel` | Models page, config/model APIs, and Agent Control | Reversible configuration write | Selected model read-back, provider synchronization, and local-runtime synchronization | Implemented through the existing launcher path; provider credentials and model readiness remain environment-dependent |
| Local model runtime | `packages/core/src/llm/local/local-runtime.ts`; `packages/core/src/control/model-adapters.ts`; llama.cpp build/release scripts | Local model configuration, control API, and runtime health paths | Inspect/activate/health; install/remove only when a dedicated adapter is supplied | Runtime detection and bounded probe | llama.cpp inspection/activation adapter is wired; runtime files/dependencies are operator-provided and unattended download/install is not implemented |
| Model download/installation | Release/build support and runtime paths exist | No verified general autonomous installer | Install side effect | Requires adapter-specific integrity/license/runtime checks | Must remain approval-gated and adapter-driven |
| Web search | `packages/core/src/search/local-first-search.ts`, config schema, launcher search settings | Search API, tools page, config-backed settings | Read/reversible write | Search result normalization and citations | Local/API/Auto modes exist; credentials remain vault-only |
| Speech-to-text | Voice router and `SpeechToTextSchema`; Whisper.cpp endpoint/CLI | Voice upload/microphone flow and settings | Configure/health | Endpoint/CLI validation and transcription probe | Opt-in; no implicit binary/model download; Telegram TTS/voice is not claimed |
| Memory | Memory bridge, memory router, SQLite stores, governance | Memory page and memory API | Read/configuration write | Search/reindex/status and DB readiness | Existing selective memory and retrieval traces are documented |
| Skills/plugins | Skill loader, governance, installer, plugin registry | Skills API/page and agent skill tools | Read/install/create/delete | Manifest validation, approval inbox, registry/readiness | Third-party acquisition remains approval-gated and untrusted code is not silently activated |
| MCP | In-process MCP server, discovery, sessions, config validation | MCP/API and tool discovery surfaces | Read/configuration write/external execution | Protocol responses, schema validation, remote-origin guard | External servers are untrusted; stdio/HTTP mutation requires explicit approval |
| Channels | Built-in channel adapters, plugin channel runtime, launcher catalog | Channel pages, config routes, probes | Configure/start/stop/reload | Provider probe, runtime status, reload result | Many adapters exist; live delivery is not universally tested |
| Runtime reload/restart | Orchestrator reload, launcher process management, `miki-24-7.mjs`, PowerShell supervisor | Gateway/runtime pages and endpoints | Service/process control | Health endpoint, restart state, graceful shutdown | Process-bound settings may require full restart; arbitrary OS service control is not exposed |
| Scheduler/automations | Task scheduler, persistent job queue, automation runtime | Automations/runs pages and APIs | Read/create/update/run/pause/cancel | Execution history and step evidence | Existing infrastructure should be reused for management workflows |
| Health/logs/inspector | Health, logs, metrics, execution tracing, Inspector | Dashboard pages and runtime APIs | Read | Health response, structured logs, evidence | Existing observability is reusable; secrets must remain redacted |
| Filesystem/shell/browser/computer | Guarded file/shell/browser/computer tools and approval-aware workers | Tool catalog and execution APIs | External side effect | Tool result, policy decision, approval/audit record | Must not be used as a shortcut for dashboard management; remote/destructive access remains restricted |
| Authentication/permissions | Dashboard sessions, API keys, CIDR/CORS, call origin, approval inbox | Middleware and approval routes | Security boundary | Authenticated request, audit record, context-bound approval | Preserve existing policy; management tools require separate risk metadata |
| 24/7 readiness | `runtime:24-7`, scheduler/heartbeat, launcher supervisor | Readiness script and gateway health | Runtime status | Readiness report, restart/recovery checks | Current docs record readiness success but native runtime/provider may be incomplete in a sandbox |

## Proposed shared control contract

The implementation should add a typed control service under `packages/core/src/control/`. Each capability descriptor should contain a stable ID, label, supported platforms, read-state function, input schema, risk class, mutation function, verification function, restart requirement, and sanitized formatter. A control operation should carry an operation ID, caller/origin, capability, action, validated input, plan steps, approval state, checkpoints, and final verification evidence. A control result must report `ok`, `status`, `changed`, `approval_required`, `pending_restart`, sanitized state, and user-safe error text.

The service must be workspace-aware and call existing typed functions rather than shell commands when an API already exists. It should persist only non-secret operation metadata and sanitized checkpoints in the runtime data directory. Approval requests should use the existing context-bound, single-use approval inbox and never persist raw worker tokens.

## Explicit unsupported or restricted areas

The agent must not receive a generic dashboard macro, arbitrary configuration path write, unrestricted shell/file/delete capability, secret readback, credential deletion, factory reset, or unattended third-party code/model/runtime acquisition. These may be represented as a planned operation requiring an authenticated owner approval and a supported adapter, but they must not execute by default.

## Remaining audit items for implementation

Before final verification, inspect the exact frontend API/page implementations for models, tools, config, runtime, skills, and health; inspect provider registry/local-runtime signatures; inspect the concrete ToolRegistry registration path; and inspect launcher process-management tests. These file-level details determine the smallest compatible edits and test seams.
