
### 25. Extra Skill API routes are shadowed by the compatibility router

- **Status:** ✅ Fixed
- Evidence:
  - `packages/core/src/api/index.ts:505` mounts `launcherCompatRouter` at `/api` before `packages/core/src/api/index.ts:1419` mounts `skillsRouter` at `/api/skills`.
  - `packages/core/src/api/launcher-compat.ts:5663-5671` defines `GET /skills/:name` and returns `404` for unknown names instead of passing through.
  - `packages/core/src/skill-api.ts:213-228` defines `GET /api/skills/categories`.
  - `packages/core/src/skill-api.ts:234-249` defines `GET /api/skills/tags`.
  - `packages/core/src/skill-api.ts:294-323` defines `GET /api/skills/plugin-contracts`.
- Impact: exact single-segment Skill API routes such as `/api/skills/categories`, `/api/skills/tags`, and `/api/skills/plugin-contracts` are interpreted as skill names by the earlier compatibility router. Clients receive "Skill not found" instead of the intended metadata route.
- **Fix:** Mounted skills router before the broad `/api` compatibility router in `packages/core/src/api/index.ts:490-493` to prevent route shadowing.

### 26. Header Stop Gateway action calls an endpoint that always returns 501

- Evidence:
  - `packages/ui/frontend/src/api/gateway.ts:81-84` posts `stopGateway()` to `/api/gateway/stop`.
  - `packages/ui/frontend/src/hooks/use-gateway.ts:52-62` enters a stopping transition and surfaces the request error.
  - `packages/ui/frontend/src/components/global-header-actions.tsx:88-95` opens the stop dialog when the gateway is running.
  - `packages/ui/frontend/src/components/global-header-actions.tsx:113-115` confirms by calling `stop()`.
  - `packages/core/src/api/launcher-compat.ts:4462-4470` returns `501` for `/gateway/stop` in the in-process Node runtime.
- Impact: the visible Stop Gateway control is not functional in the bundled Node runtime. Users can confirm the dialog, see the UI enter a stopping state, then receive an API error while the runtime remains running.
- Recommended fix: either implement a real parent-process stop handoff for the packaged runtime, or hide/disable the stop action when status says the gateway is managed by the running Hiro process.

### 27. Python plugin entrypoints depend on a plain `python` executable

- Evidence:
  - `packages/core/src/plugins/plugin-contract-runtime.ts:646-651` maps Python plugin tool entrypoints to `{ command: "python" }`.
  - `packages/core/src/plugins/plugin-contract-runtime.ts:708-714` spawns that command directly with the plugin entrypoint.
  - `packages/core/src/plugins/plugin-channel-runtime.ts:85-93` maps Python channel entrypoints to the same plain `python` command.
  - `packages/core/src/plugins/plugin-channel-runtime.ts:360-363` spawns the channel runtime with that command.
  - `scripts/assert-pack-contents.mjs:36-55` checks the packaged runtime for Node/Go/runtime artifacts but does not include or validate a Python runtime.
- Impact: installed `.py` plugin tools or channels can be reported as supported by extension, but fail at execution on systems where `python` is missing, named `python3`, or not on `PATH`.
- Recommended fix: add configurable Python executable resolution, validate it in plugin readiness, support `python3`/Windows `py` fallback where appropriate, and show a clear blocked readiness reason before execution.

### 28. Plugin sandbox state is advisory, not process-enforced

- **Status:** ✅ Fixed
- Evidence:
  - `packages/core/src/plugins/plugin-contract-runtime.ts:453-487` derives sandbox flags from declared permissions and policy.
  - `packages/core/src/plugins/plugin-contract-runtime.ts:654-673` only sets environment variables and forwards host `PATH`, temp, home, and profile paths.
  - `packages/core/src/plugins/plugin-contract-runtime.ts:708-714` spawns the entrypoint as a normal child process.
  - `packages/core/src/plugins/plugin-contract-runtime.ts:923-930` sends `runtime.sandbox: true` to the plugin payload.
  - `packages/core/src/plugins/plugin-marketplace-readiness.ts:518-524` tells users to verify policy and sandbox settings before publication.
- Impact: after policy allows execution, plugin code still runs as the same OS user without filesystem or network isolation enforced by the runtime. The `sandbox: true` payload and readiness wording can give a stronger security signal than the implementation provides.
- **Fix:** Added environment variables for sandbox configuration (`Hiro_SANDBOX_FILESYSTEM`, `Hiro_SANDBOX_NETWORK`, `Hiro_SANDBOX_SECRETS`, `Hiro_SANDBOX_SHELL`) in `buildPluginEnvironment()` and passed sandbox configuration through plugin execution flow in `plugin-contract-runtime.ts:655-689, 708-734, 934-971`.

### 29. Plugin readiness summary counts metadata-only plugins as Ready

- Evidence:
  - `packages/core/src/plugins/plugin-marketplace-readiness.ts:188-195` keeps separate `ready` and `metadata_only` status counts.
  - `packages/ui/frontend/src/components/agent/skills/plugin-readiness-panel.tsx:312-313` computes `readyCount` as `ready + metadata_only`.
  - `packages/ui/frontend/src/components/agent/skills/plugin-readiness-panel.tsx:385-388` displays that merged value under the "Ready" tile.
- Impact: a plugin candidate with metadata but no executable runtime can inflate the Ready number. Users can think runtime-capable plugin contracts are ready when some are only publishable/catalog metadata.
- Recommended fix: show `ready` and `metadata_only` as separate summary tiles, or label the merged metric as "Marketplace ready" and keep runtime-ready counts distinct.

### 30. System-index realtime mode misses nested changes off Windows

- Evidence:
  - `packages/core/src/system-index/indexer.ts:323-347` creates one `fs.watch` watcher per effective root.
  - `packages/core/src/system-index/indexer.ts:330-333` sets `{ recursive: process.platform === "win32" }`.
  - `packages/ui/frontend/src/components/system-index/system-index-page.tsx:330-335` exposes realtime indexing as a normal toggle.
- Impact: on non-Windows platforms, realtime indexing only watches the configured root directory itself. Changes in nested project folders can be missed even while the UI shows realtime watchers as active.
- Recommended fix: use a proven recursive watcher such as `chokidar`, or install per-directory watchers during the scan and update them as directories are added/removed.

### 31. System-index pause can be bypassed by saving config

- Evidence:
  - `packages/core/src/system-index/indexer.ts:152-155` sets `paused = true` and closes watchers.
  - `packages/core/src/system-index/indexer.ts:111-115` always calls `startWatchers()` from `configure()`.
  - `packages/ui/frontend/src/components/system-index/system-index-page.tsx:356-364` allows Save while the indexer is paused because it only checks `busy !== null`.
  - `packages/core/src/system-index/indexer.ts:323-325` starts watchers without checking `paused`.
  - `packages/core/src/system-index/indexer.ts:350-357` watcher events call `indexPath()`, and `packages/core/src/system-index/indexer.ts:175-190` indexes direct file targets without waiting on `paused`.
- Impact: a paused indexer can start realtime watchers again after a config save, while status still reports `paused`. File updates can continue to be indexed despite the Pause action.
- Recommended fix: make `configure()` respect the paused state, avoid starting watchers until `resume()`, and have `indexPath()` return or wait when paused.

### 32. Model Test can report success for a nonexistent model ID

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:4872-4904` validates the inline model identifier but only fetches provider models when supported.
  - `packages/core/src/api/launcher-compat.ts:4917-4941` tests saved models by validating provider connectivity and fetching `/models`.
  - `packages/core/src/api/launcher-compat.ts:3033-3089` returns the provider model list but no caller checks that the selected model ID is present.
  - `packages/ui/frontend/src/components/models/test-model-dialog.tsx:134-163` presents the result as "Test Connection" and "Connection successful" for the selected model.
- Impact: a typo or removed model can pass the test as long as the provider `/models` endpoint is reachable. The dashboard can mark a bad model as available until chat/inference fails later.
- Recommended fix: compare the selected canonical model ID against the fetched model list, or run a minimal provider-specific inference/metadata request that actually targets that model.

### 33. Reloaded chat history drops model, tool-call, attachment, and detail metadata

- Evidence:
  - `packages/core/src/memory/repositories/session.ts:73-80` stores messages with only `id`, `session_id`, `role`, `content`, `created_at`, and `token_count`.
  - `packages/core/src/memory/repositories/session.ts:265-287` `addMessage()` persists only those fields.
  - `packages/core/src/api/launcher-compat.ts:4551-4558` maps every returned history message to `kind: "normal"` and omits `model_name`, `tool_calls`, media, and attachments.
  - `packages/ui/frontend/src/features/chat/history.ts:46-60` tries to restore `kind`, `model_name`, `tool_calls`, media, and attachments from the history response.
- Impact: live chat can show model names, tool-call panels, assistant detail messages, and attachments, but a session reload loses that structure. Historical conversations become flattened text and cannot faithfully reconstruct the original run.
- Recommended fix: extend message persistence with a JSON metadata column or event table for model name, assistant kind, tool calls, attachments, and media; then return those fields from `/api/sessions/:id`.
