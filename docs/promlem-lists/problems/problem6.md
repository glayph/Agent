
### 46. Tool Feedback settings are persisted but the backend never emits configured feedback

- Evidence:
  - `packages/ui/frontend/src/components/config/config-sections.tsx:192-216` exposes Tool Feedback, separate feedback messages, and max args preview controls.
  - `packages/ui/frontend/src/components/config/config-page.tsx:586-589` saves `tool_feedback.enabled`, `max_args_length`, and `separate_messages`.
  - `packages/ui/frontend/src/components/config/form-model.ts:319-346` reloads those saved settings into the form.
  - `packages/core/src/api/launcher-compat.ts:1757-1760` includes `tool_feedback` defaults in the runtime config.
  - `packages/core/src/agent.ts:1150-1224` emits `tool_execution_plan`, `tool_call`, retries, results, and metrics without reading `tool_feedback`.
  - `packages/core/src/agent.ts:1724-1824` executes tools and emits only `tool_result`; it never builds feedback text, max-arg previews, separate messages, or `tool_feedback_explanation`.
  - `packages/ui/frontend/src/features/chat/tool-calls.ts:83-84` can display `tool_feedback_explanation` if it arrives, but `rg -n "tool_feedback|tool_feedback_explanation|separate_messages|max_args_length" packages/core/src` finds no runtime use beyond the default config.
- Impact: the dashboard promises a short execution note before each tool runs, but enabling/disabling Tool Feedback and changing preview/separate-message settings has no effect on backend output.
- Recommended fix: implement feedback generation in the hiro/WebSocket bridge or agent tool loop, honoring `enabled`, `separate_messages`, and `max_args_length`; include `tool_feedback_explanation` metadata when appropriate. Otherwise remove the setting.

### 47. Context window, max tool iterations, and summarization controls are inert

- Evidence:
  - `packages/ui/frontend/src/components/config/config-sections.tsx:244-296` exposes Context Window, Max Tool Iterations, Summarize Message Threshold, and Summarize Token Percent.
  - `packages/ui/frontend/src/components/config/config-page.tsx:592-595` saves those values under `agents.defaults`.
  - `packages/core/src/api/launcher-compat.ts:1753-1756` includes defaults for `context_window`, `max_tool_iterations`, `summarize_message_threshold`, and `summarize_token_percent`.
  - `packages/core/src/agent.ts:67-68` hardcodes `MAX_AGENT_TURNS = 50` and `MAX_AGENT_TURNS_NO_OUTPUT = 12`.
  - `packages/core/src/agent.ts:922-947` uses `agent.max_tokens_per_cycle`, resource profile history/context settings, and the pruned tool schema; it does not read the saved `agents.defaults.context_window` or summarization settings.
  - `packages/core/src/agent.ts:986` loops against the hardcoded `MAX_AGENT_TURNS`, not the saved `max_tool_iterations`.
  - `packages/core/src/agent-token-budget.ts:35-52` calculates available context from model-profile limits, not the saved `context_window`.
  - `packages/core/src/token-budget-manager.ts:176-185` reports `compress_at_tokens` as a fixed 85 percent of model context, not the saved `summarize_token_percent`.
- Impact: users can tune context and summarization limits in Config, but the running agent still follows resource profiles, hardcoded turn caps, model-profile context windows, and fixed compression percentages.
- Recommended fix: map these UI settings into the actual agent resource/token-budget/memory summarization configuration, or replace them with the existing `agent.resource` controls that are actually honored.

### 48. Chatty Mode is a dead toggle

- Evidence:
  - `packages/ui/frontend/src/i18n/locales/en.json:1231-1232` describes Chatty Mode as splitting long messages into short human-like messages.
  - `packages/ui/frontend/src/components/config/config-sections.tsx:184-188` exposes the `splitOnMarker` switch.
  - `packages/ui/frontend/src/components/config/config-page.tsx:583-585` saves `split_on_marker` under `agents.defaults`.
  - `packages/core/src/api/launcher-compat.ts:1750-1751` includes `split_on_marker: false` in defaults.
  - `rg -n "split_on_marker|splitOnMarker" packages/core/src packages/gateway/src packages/config/src` finds no runtime parser, streamer, or message-splitting use outside defaults/config sync.
- Impact: toggling Chatty Mode changes saved config but does not affect assistant message streaming or message splitting.
- Recommended fix: implement response splitting in the chat/hiro bridge or agent stream based on `split_on_marker`, or remove the toggle until the behavior exists.

### 49. Workspace Directory setting does not change the runtime workspace

- Evidence:
  - `packages/ui/frontend/src/i18n/locales/en.json:1225-1226` labels the field as the base directory for agent file operations.
  - `packages/ui/frontend/src/components/config/config-sections.tsx:152-159` lets users edit the workspace path.
  - `packages/ui/frontend/src/components/config/config-page.tsx:308-311` validates the field and `packages/ui/frontend/src/components/config/config-page.tsx:581-584` saves it as `agents.defaults.workspace`.
  - `packages/core/src/api/index.ts:229-236` derives the actual `workspaceDir` once from `Hiro_WORKSPACE_DIR` or the inferred repo root, then constructs `new AgentOrchestrator(workspaceDir)`.
  - `packages/core/src/agent.ts:462-477` stores that constructor `workspaceDir` and uses it for `config`, `data`, memory, and tools.
  - `packages/core/src/api/launcher-compat.ts:4314-4319` mounts System Index and File Manager with the same fixed `workspaceDir`, not `agents.defaults.workspace`.
- Impact: changing Workspace Directory in the dashboard saves a string but does not rebase Drive, tools, memory, system index, skills, logs, secrets, or the agent config path. Users can believe file operations moved to a new workspace while the backend keeps operating in the old one.
- Recommended fix: make the field read-only as the current runtime workspace, or implement a real workspace switch that updates the process workspace, restarts gateway/core, remounts routers, and reinitializes storage safely.

### 50. Tool-call details are overwritten and disappear from the chat message

- Evidence:
  - `packages/core/src/agent.ts:1171-1177` emits one `tool_call` event per invocation.
  - `packages/core/src/api/index.ts:895-912` converts each `tool_call` into a `message.update` for the same `assistantMessageId` with a one-item `tool_calls` array.
  - `packages/core/src/api/index.ts:877-891` later sends normal `stream_chunk` updates for the same `assistantMessageId` without `kind` or `tool_calls`.
  - `packages/ui/frontend/src/features/chat/assistant-message-state.ts:79-90` replaces the message state with the explicit one-item tool-call payload.
  - `packages/ui/frontend/src/features/chat/assistant-message-state.ts:102-108` clears existing `tool_calls` when a later update has no explicit kind/tool-call payload.
- Impact: multiple tool calls collapse to the latest one, and final assistant text updates remove tool-call details from the same message. The UI can briefly show tool activity, then lose it once normal content streams in, making tool feedback and history unreliable.
- Recommended fix: accumulate tool calls in the hiro bridge or frontend store, preserve existing tool-call metadata on normal content updates unless explicitly cleared, and include tool results/status in durable message metadata.

### 51. Exec allow/deny pattern settings are saved but not enforced

- Evidence:
  - `packages/ui/frontend/src/components/config/config-sections.tsx:1029-1064` exposes Enable Deny Patterns plus custom deny and custom allow pattern fields.
  - `packages/ui/frontend/src/components/config/config-page.tsx:558-569` saves `execConfigPatch.enable_deny_patterns`, `custom_allow_patterns`, and `custom_deny_patterns`.
  - `packages/core/src/api/launcher-compat.ts:1723-1725` persists the exec config under `runtime.exec` in `config/tools.yaml`.
  - `packages/config/src/schema.ts:101-105` validates `allow_remote`, `enable_deny_patterns`, `custom_allow_patterns`, and `custom_deny_patterns`.
  - `packages/core/src/tools/executor/shell.ts:16-23` defines shell permission config with only `allowed_prefixes` and `allowed_commands`.
  - `packages/core/src/tools/executor/shell.ts:119-133` authorizes commands using unsafe syntax, `allowed_commands`, and `allowed_prefixes` only.
  - `packages/core/src/tools/registry/handlers.ts:39-49` invokes `this.executor.runShell(cmd, workingDir, timeout)` without passing runtime exec pattern settings.
- Impact: users can configure custom allow and deny command patterns, but shell execution still follows only the older permission allowlists plus unsafe-syntax checks. Commands that should be denied can still pass if an old prefix allows them, and commands that should be allowed by a custom pattern can still fail.
- Recommended fix: implement a real pattern matcher in `ShellExecutor` that reads `runtime.exec.*`, with deny precedence and tests, or map the UI fields into `permissions.shell_execute` and remove unused controls.

### 52. Cron execution timeout setting is saved but never applied

- Evidence:
  - `packages/ui/frontend/src/components/config/config-sections.tsx:1220-1241` exposes `cronExecTimeoutMinutes` in the Cron settings section.
  - `packages/ui/frontend/src/components/config/config-page.tsx:362-366` parses the field and `packages/ui/frontend/src/components/config/config-page.tsx:617-619` saves it as `tools.cron.exec_timeout_minutes`.
  - `packages/core/src/api/launcher-compat.ts:1792-1794` includes `tools.cron.exec_timeout_minutes: 5` in defaults.
  - `packages/config/src/schema.ts:91-94` validates `exec_timeout_minutes`.
  - `packages/core/src/heartbeat.ts:191-193` only reads `cron.allow_command` before checking scheduled tasks.
  - `packages/core/src/api/index.ts:1609-1642` creates scheduled tasks with session, message, cron/run time, and attempts only.
  - `packages/core/src/scheduler.ts:175-205` stores run timing and attempts, but no timeout field.
  - `packages/core/src/scheduler.ts:279-299` awaits `_executeTask(...)` without an abort signal or configured timeout.
- Impact: the dashboard suggests scheduled jobs can be capped by a cron timeout, but scheduled agent runs can continue until their own internal loop completes or hangs. The saved timeout does not bound scheduled execution.
- Recommended fix: load `tools.cron.exec_timeout_minutes` in the scheduler, pass an `AbortSignal` through scheduled agent execution, and cancel overdue tasks with clear status/logging.

### 53. Evolution settings are config-only and have no runtime engine

- Evidence:
  - `packages/ui/frontend/src/i18n/locales/en.json:1330-1350` describes Evolution as learning from completed turns, recording data, drafting/applying skill updates, and running cold-path processing.
  - `packages/ui/frontend/src/components/config/config-sections.tsx:497-621` exposes Evolution enabled, mode, state directory, task thresholds, trigger, and scheduled times.
  - `packages/ui/frontend/src/components/config/config-page.tsx:602-613` saves all Evolution fields.
  - `packages/ui/frontend/src/components/config/form-model.ts:440-458` loads those fields back into the form.
  - `packages/core/src/api/launcher-compat.ts:1587` reads `agentYaml.evolution`, `packages/core/src/api/launcher-compat.ts:1622` writes it back, and `packages/core/src/api/launcher-compat.ts:1782-1789` defines defaults.
  - `packages/config/src/schema.ts:308` accepts `evolution` as a generic JSON record.
  - `rg -n "\\bevolution\\b|cold_path|min_task_count|min_success_ratio|state_dir" packages/core/src packages/config/src` finds no core runtime that consumes these fields outside config compatibility.
- Impact: turning Evolution on, switching Draft/Apply mode, setting thresholds, or scheduling cold-path times does not create learning records, draft skill updates, apply changes, or start any background processor.
- Recommended fix: wire `evolution` into the existing self-improvement/skill-governance runtime with durable state, triggers, scheduled processing, and safe apply behavior, or remove the section until implemented.
