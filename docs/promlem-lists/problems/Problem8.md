
### 70. Chat Share link copies a session URL that the app never consumes

- Evidence:
  - `packages/ui/frontend/src/components/chat/session-history-menu.tsx:377-383` copies a share target with `#session=<id>`.
  - `packages/ui/frontend/src/features/chat/state.ts:4-11` reads the initial session only from `Hiro:last-session-id` localStorage.
  - `packages/ui/frontend/src/features/chat/state.ts:53-55` falls back to a newly generated session id when localStorage is empty.
  - `packages/ui/frontend/src/features/chat/controller.ts:255-274` hydrates only `readStoredSessionId()`.
  - Searching for `location.hash`, `hashchange`, and `#session=` in the frontend finds only the share-link writer, not a reader.
- Impact: users can click Share and get a successful copy toast, but opening the copied link does not load the shared conversation. It opens the last local session or a new session instead.
- Recommended fix: parse and validate `#session` or a query param before the localStorage fallback, load that session through `getSessionHistory`, update `activeSessionId`, and clear or replace the URL after successful navigation.

### 71. Drive Run action is shown for browseable files but blocked outside the workspace by write-scope policy

- Evidence:
  - `packages/core/src/api/file-manager-router.ts:808-862` exposes browse roots such as Home, quick access folders, and filesystem drives.
  - `packages/ui/frontend/src/components/drive/drive-page.tsx:1123-1167` renders those roots as clickable Drive locations.
  - `packages/ui/frontend/src/components/drive/drive-page.tsx:1319-1327` shows a Run menu item for every file entry.
  - `packages/ui/frontend/src/components/drive/drive-page.tsx:1964-1972` calls `runFileItem(entry.path)` for that action.
  - `packages/core/src/api/file-manager-router.ts:1154-1163` handles `/api/files/run` by calling `assertCurrentMutableScope(targetPath)` before launching the file.
  - `packages/core/src/api/file-manager-router.ts:196-207` rejects targets outside the workspace when system write access is disabled.
- Impact: Drive can browse files outside the workspace and still offers Run, but the backend rejects the action with a write-scope error. Opening a file with the OS launcher is treated like a write operation, so the visible action fails for many files the UI allowed the user to browse.
- Recommended fix: split OS-open/run permission from write permission, or hide/disable Run for paths outside the allowed execution/open scope. The error copy should explain the actual policy if this restriction is intentional.

### 72. Health Watchdog restart only clears in-memory probe history

- Evidence:
  - `packages/ui/frontend/src/components/health/health-page.tsx:276-284` exposes a Restart watchdog action.
  - `packages/ui/frontend/src/api/safety.ts:163-167` posts that action to `/api/enhancements/safety/watchdog/restart`.
  - `packages/core/src/api/enhancement-router.ts:611-612` maps the route directly to `watchdog.restart()`.
  - `packages/core/src/safety/watchdog.ts:104-111` implements `restart()` by clearing `this.services`, recording an audit event, and returning status.
  - `packages/core/src/api/enhancement-router.ts:478-488` only recreates the built-in probe entries later when `/health/full` is loaded again.
- Impact: the Health page can report the watchdog restart as completed, but no monitored service is restarted and no immediate probe recovery happens. The action mainly erases failure counters/status, which can hide unhealthy state until probes are rebuilt.
- Recommended fix: relabel the action as Reset watchdog state, or implement real service restart/reprobe callbacks and return per-service results to the UI.

### 73. Default settings models are listed as editable real rows, but edit/test/delete routes only work for saved `state.models`

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:4720-4730` makes `GET /api/models` fall back to `defaultModelsFromSettings()` when `state.models` is empty.
  - `packages/core/src/api/launcher-compat.ts:2450-2487` maps those fallback models through `modelInfoFromStored()` with `is_virtual: false`, so the UI receives them as normal rows.
  - `packages/core/src/api/launcher-compat.ts:4771-4780` handles `PUT /api/models/:index` only against `(state.models || [])` and returns 404 when the fallback row was never saved.
  - `packages/core/src/api/launcher-compat.ts:4817-4825` handles `DELETE /api/models/:index` with the same persisted-only lookup.
  - `packages/core/src/api/launcher-compat.ts:4917-4920` handles `POST /api/models/:index/test` by reading `state.models?.[index]`, so fallback rows also fail model testing.
  - `packages/ui/frontend/src/components/models/model-card.tsx:154-183` still exposes edit and delete actions for these cards.
  - `packages/ui/frontend/src/components/models/test-model-dialog.tsx:68-71` calls `testModel(model.index)`, and `packages/ui/frontend/src/components/models/edit-model-sheet.tsx:371-389` calls `updateModel(model.index, ...)`.
- Impact: a fresh/default install can show model cards that look editable, deletable, and testable, but Edit/Test/Delete hit backend 404 "Model not found" because the rows are not actually in `state.models`.
- Recommended fix: materialize default settings models into `state.models` before exposing row actions, or mark fallback rows as virtual and disable Edit/Delete/Test with explicit UI copy. Test fallback models through inline parameters instead of persisted indexes if they should be testable.

### 74. Drive write controls stay enabled for external browse roots even though backend restricts writes to the workspace

- Evidence:
  - `packages/core/src/api/file-manager-router.ts:808-862` exposes Home, quick access folders, and filesystem drives as browseable roots.
  - `packages/ui/frontend/src/components/drive/drive-page.tsx:1123-1167` renders those roots as clickable Drive locations.
  - `packages/ui/frontend/src/components/drive/drive-page.tsx:2432-2452` exposes create file, create folder, and upload controls in directory views without checking whether the current path is inside the writable workspace scope.
  - `packages/ui/frontend/src/components/drive/drive-page.tsx:2464-2491` exposes download, copy, move, and delete selected actions.
  - `packages/ui/frontend/src/components/drive/drive-page.tsx:2589-2595` wires row actions for download, copy, move, run, pin, rename, and delete.
  - `packages/ui/frontend/src/components/drive/drive-page.tsx:1591` disables Save only for `saving || file.readonly`.
  - `packages/core/src/api/file-manager-router.ts:367-382` sets file `readonly` only from filesystem mode, not from the app write-scope policy.
  - `packages/core/src/api/file-manager-router.ts:196-207` rejects writes outside the workspace unless system write access is enabled, with "file manager write access is restricted to the workspace".
  - `packages/core/src/api/file-manager-router.ts:1038-1254` applies that mutable-scope check to write, create, rename, copy, move, delete, and upload routes.
- Impact: users can browse external roots, open writable-looking files, edit them, and press Save, or try create/upload/rename/delete/copy/move in external folders. The UI presents the actions as available, then the backend rejects them after submission.
- Recommended fix: include path write capability in roots/listing/read responses and disable or hide mutating controls for paths outside the allowed write scope. If system-wide writes are intended, expose that permission clearly and keep the frontend state in sync with it.

### 75. Logs page Log Level selector is saved but ignored by the Node runtime

- Evidence:
  - `packages/ui/frontend/src/components/logs/log-level-select.tsx:31-38` reads `gateway.log_level` from config and defaults to `warn`.
  - `packages/ui/frontend/src/components/logs/log-level-select.tsx:51-58` writes `{ gateway: { log_level: nextLevel } }` through `patchAppConfig`.
  - `packages/ui/frontend/src/components/logs/logs-page.tsx:16-33` displays the selector as a live Logs page control.
  - `packages/core/src/api/launcher-compat.ts:5234-5265` commits patched config and calls `applyRuntimeChanges()`, but the Node compat runtime has no consumer that applies `gateway.log_level` to its logger.
  - `packages/core/src/api/launcher-compat.ts:4363-4372` serves `/api/gateway/logs` by reading log files through `readLogLines(workspaceDir)`.
  - `packages/core/src/api/launcher-compat.ts:4473-4481` clears log files, also without applying log-level state.
  - Searches for `log_level`, `LOG_LEVEL`, and logger level changes under `packages/core/src` show log file readers and config flow, but no Node runtime log-level application. The older Go backend has `logger.SetLevelFromString`, but the Node compat routes do not mirror that behavior.
- Impact: changing the Logs page level appears saved and refreshes gateway state, but it does not change the log verbosity for the Node runtime logs that the page displays.
- Recommended fix: apply `gateway.log_level` inside the Node runtime logger during config commit/runtime reload, or hide/disable the selector when serving the Node compat runtime.

### 76. Session deletion leaves stream cache and agent task rows behind

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:4572` and `packages/core/src/api/index.ts:575` delete sessions through `orchestrator.memory.deleteSession(...)`.
  - `packages/core/src/memory/architect.ts:236-238` deletes relational session data and vectors only.
  - `packages/core/src/memory/relational.ts:82-85` deletes facts/procedures for the session, then delegates to `SessionRepository.deleteSession(...)`.
  - `packages/core/src/memory/repositories/session.ts:93-107` stores `stream_cache` and `agent_tasks` rows with `session_id`.
  - `packages/core/src/memory/repositories/session.ts:258-261` deletes only `messages`, `tool_logs`, and `sessions`.
  - `packages/core/src/memory/repositories/session.ts:468-470` and `packages/core/src/api/index.ts:1670` can still query tasks by the deleted session id.
- Impact: deleting a chat session is not a full data delete. Stream replay chunks and agent task metadata can remain in the database after the session disappears from history, creating stale diagnostics, possible privacy leakage, and unbounded leftover rows.
- Recommended fix: delete `stream_cache` and `agent_tasks` by `session_id` inside `SessionRepository.deleteSession()`, add foreign keys with `ON DELETE CASCADE` where possible, and add a regression test that a deleted session leaves no session-scoped rows.

### 77. Model Fetch treats a saved model index as a usable credential, but the backend ignores `model_index`

- Evidence:
  - `packages/ui/frontend/src/components/models/edit-model-sheet.tsx:788-795` passes `modelIndex={model?.index}` into `FetchModelsDialog`.
  - `packages/ui/frontend/src/components/models/fetch-models-dialog.tsx:59` treats `modelIndex !== undefined` as `hasKey`, so the missing-key warning and auto-fetch guard are bypassed.
  - `packages/ui/frontend/src/components/models/fetch-models-dialog.tsx:67-72` sends `model_index` to `fetchUpstreamModels(...)`.
  - `packages/ui/frontend/src/api/models.ts:171-184` includes `model_index` in the fetch request contract.
  - `packages/core/src/api/launcher-compat.ts:4952-4964` handles `/api/models/fetch` by reading only `provider`, `api_key`, and `api_base`.
  - `packages/core/src/api/launcher-compat.ts:2414-2424` resolves credentials only from the explicit key or provider env secret; it has no model-index lookup.
- Impact: editing an unconfigured saved/default model can open Model Fetch and auto-submit because the UI assumes the saved row index can supply credentials. The backend ignores that index and returns "API key is required", so the dialog presents a broken fetch path instead of the intended missing-key state.
- Recommended fix: either implement `model_index` lookup on `/api/models/fetch` and use the saved model/provider credential state, or remove `model_index` from the fetch contract and make the frontend gate fetch on `api_key_set`/provider credential availability.

### 78. IRC SASL password is declared as configurable but never applied by the runtime

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:187` includes `sasl_password` in the IRC secret fields.
  - `packages/core/src/api/launcher-compat.ts:225-227` maps IRC password secrets to `IRC_PASSWORD`, `IRC_NICKSERV_PASSWORD`, and `IRC_SASL_PASSWORD`.
  - `packages/config/src/secret-vault.ts:50-52` also includes `IRC_SASL_PASSWORD` in the default vault/env migration set.
  - `packages/core/src/api/launcher-compat.ts:3487-3490` syncs only `IRC_PASSWORD` and `IRC_NICKSERV_PASSWORD` into runtime env state.
  - `packages/core/src/channels/irc.ts:123-128` resolves only server password and NickServ password.
  - `packages/core/src/channels/irc.ts:305` sends IRC `PASS`, and `packages/core/src/channels/irc.ts:335-336` sends NickServ `IDENTIFY`; there is no CAP/SASL `AUTHENTICATE` flow.
- Impact: config, vault, and env migration imply SASL auth support, but setting `IRC_SASL_PASSWORD` cannot authenticate to SASL-required IRC networks. Users can believe the secret is supported while the bot still connects without SASL.
- Recommended fix: either remove `sasl_password`/`IRC_SASL_PASSWORD` from the supported config surface, or implement IRC CAP SASL negotiation with username/password fields and tests for the registration sequence.