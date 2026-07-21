
### 88. System Index search cannot reach results beyond the first fixed response window

- Evidence:
  - `packages/ui/frontend/src/api/system-index.ts:107-117` sends only `q` and `limit`; there is no offset, cursor, total, or next-page contract.
  - `packages/ui/frontend/src/components/system-index/system-index-page.tsx:198` always calls `searchSystemIndex(text, 50)`.
  - `packages/ui/frontend/src/components/system-index/system-index-page.tsx:165-167` and `:487-490` implement "Show more" only over the already-loaded local result array.
  - `packages/core/src/api/system-index-router.ts:17-19` clamps requested limits to at most 100.
  - `packages/core/src/api/system-index-router.ts:67` returns only `currentIndexer.search(query, limitFromRequest(req))`.
  - `packages/core/src/system-index/database.ts:176-223` applies that limit directly to SQLite search queries and returns no total/offset metadata.
- Impact: once a query has more than 50 dashboard matches, the UI cannot fetch the rest; even direct API callers cannot page beyond 100. The page's "Show more" control looks like pagination but only reveals the first fixed server response.
- Recommended fix: add server-side offset/cursor and total/has-more metadata for system-index search, then drive the dashboard "Show more" action through follow-up backend requests.

### 89. Drive folder listing silently hides files after the first 1000 directory entries

- Evidence:
  - `packages/core/src/api/file-manager-router.ts:10` sets `MAX_LIST_ENTRIES = 1000`.
  - `packages/core/src/api/file-manager-router.ts:331-340` calls `fsp.readdir(...).slice(0, MAX_LIST_ENTRIES)` before mapping metadata and sorting entries.
  - `packages/core/src/api/file-manager-router.ts:1018-1019` returns `entries` plus `limit`, but no total count, truncated flag, offset, or cursor.
  - `packages/ui/frontend/src/api/files.ts:34-46` models a directory listing as only `entries` and `limit`.
  - `packages/ui/frontend/src/components/drive/drive-page.tsx:1214-1217` implements local incremental display over `listing.entries`.
  - `packages/ui/frontend/src/components/drive/drive-page.tsx:1901-1908` implements Select All from `listing.entries`, so hidden backend-truncated files are never selected.
- Impact: large directories can omit valid files without warning, and because truncation happens before sorting, the visible 1000 entries may not even be the alphabetically first 1000. Search-by-eye, Select All, bulk download/move/delete, and file opening from the dashboard are incomplete for large folders.
- Recommended fix: sort before slicing, return `total`, `offset`, and `has_more` or a cursor, show a truncation warning in Drive, and make Select All explicitly operate on either the visible page or a backend-supported full selection.

### 90. Session history Rename and Pin actions are browser-local only

- Evidence:
  - `packages/ui/frontend/src/components/chat/session-history-menu.tsx:55-56` stores pinned and renamed session metadata under localStorage keys.
  - `packages/ui/frontend/src/components/chat/session-history-menu.tsx:328-336` pins/unpins sessions only by writing localStorage.
  - `packages/ui/frontend/src/components/chat/session-history-menu.tsx:355-371` renames a session only by updating local component state and localStorage.
  - `packages/ui/frontend/src/api/sessions.ts:63-93` exposes list, detail, and delete only; there is no rename or pin API.
  - `packages/core/src/api/launcher-compat.ts:4484-4510` lists sessions with titles derived from the first message content.
  - `packages/core/src/api/launcher-compat.ts:4544-4576` provides session detail, and `:4568-4576` provides delete, but no persisted title/pin mutation route.
- Impact: Rename and Pin look like real session-management actions, but they disappear across browsers/devices, localStorage resets, private windows, or any alternate client. Backend history, exported data, and API consumers keep using the original first-message title and no pinned state.
- Recommended fix: add session metadata columns or a separate session preferences table, expose PATCH endpoints for title and pin state, and have the history menu persist through that API while keeping localStorage only as an offline fallback.

### 91. Default Go web backend ships a stub API while the frontend expects the full launcher API

- Evidence:
  - `scripts/build-go-backend.mjs:15-24` builds the default Go backend as a "compatibility stub" and does not include the `legacy_backend` tag in the default build.
  - `packages/ui/backend/stub_main.go:29-40` registers only `/api/version` and `/api/health` as API handlers.
  - `packages/ui/backend/stub_main.go:45-62` then serves embedded frontend assets or a missing-assets error; it does not register dashboard API routes for auth, models, config, channels, Pico, sessions, skills, logs, or gateway control.
  - `packages/ui/README.md:3-14` describes the launcher as a service that bundles the React dashboard, exposes a backend API, manages authentication, and starts or attaches to the runtime process.
  - `packages/ui/README.md:20-33` says the Go backend serves REST APIs, authentication endpoints, channel helper flows, the Pico WebSocket proxy, and the frontend talks only to the launcher backend.
  - `packages/ui/frontend/src/api/launcher-auth.ts:12-60`, `packages/ui/frontend/src/api/gateway.ts:57-100`, `packages/ui/frontend/src/api/models.ts:86-212`, `packages/ui/frontend/src/api/channels.ts:114-170`, `packages/ui/frontend/src/api/pico.ts:29-37`, and `packages/ui/frontend/src/api/sessions.ts:63-93` call many `/api/...` routes that the stub binary does not implement.
  - `scripts/assert-pack-contents.mjs:54-55` still requires both the built frontend and the Go backend binary in the packaged runtime.
- Impact: even after the dashboard HTML/assets load, the packaged/default Go web server can only answer health/version. Most dashboard actions will 404 or fail because the frontend is wired to a full launcher API that the default binary does not provide.
- Recommended fix: either stop packaging/advertising the stub as the dashboard backend and route packaged dashboards to the Node launcher-compat API, or build a real API-proxy/full launcher backend by default. Add a packaged smoke test that starts the bundled backend and checks representative routes such as `/api/auth/status`, `/api/config`, `/api/models`, `/api/channels/catalog`, and `/api/pico/info`.

### 92. Cron execution enable switch saves to tools.yaml but scheduler reads agent.yaml

- Evidence:
  - `packages/ui/frontend/src/components/config/config-sections.tsx:1225-1227` renders the Cron "Allow Shell Execution" switch from `form.allowCommand`.
  - `packages/ui/frontend/src/components/config/config-page.tsx:618-619` saves that switch as `tools.cron.allow_command` plus `tools.cron.exec_timeout_minutes`.
  - `packages/core/src/api/launcher-compat.ts:1653-1729` persists the dashboard tools config to `config/tools.yaml`, and `packages/core/src/api/launcher-compat.ts:1723` writes the cron block as `runtime.cron`.
  - `packages/core/src/api/launcher-compat.ts:1598-1641` updates `config/agent.yaml` for agent defaults, session, heartbeat, evolution, devices, and channels, but it does not write the saved `tools.cron` block into `agent.yaml`.
  - `packages/core/src/agent.ts:315` gates cron execution with `asAgentConfig(this.config).tools?.cron?.allow_command === true`.
  - `packages/core/src/agent.ts:724-747` reloads only `this.config` and starts or stops the task scheduler from that gate.
  - `packages/core/src/api/index.ts:1586-1645` exposes scheduled task list/create APIs, so tasks can be queued while the background scheduler remains stopped.
- Impact: turning on Cron "Allow Shell Execution" in the dashboard can still leave scheduled tasks dormant because the UI writes the flag into `tools.yaml` while the scheduler checks `agent.yaml`/`this.config.tools`. The API can show scheduled tasks and stats, but they will not run after save/reload unless another path manually places the same flag in `agent.yaml`.
- Recommended fix: make the scheduler read the same runtime tools config used by the tool registry (`config/tools.yaml` `runtime.cron.allow_command`) or persist `tools.cron` into `agent.yaml` consistently. Add a regression test that saves the UI cron switch, reloads runtime config, and verifies the scheduler starts and stops.

### 93. Agent Bypass Restrictions switch is saved but no runtime policy reads it

- Evidence:
  - `packages/ui/frontend/src/components/config/config-sections.tsx:174-179` renders the Agent "Bypass Restrictions" switch from `form.bypassRestrictions`.
  - `packages/ui/frontend/src/components/config/config-page.tsx:578` saves the value as `agent.security.bypass_restrictions`.
  - `packages/ui/frontend/src/components/config/form-model.ts:327-330` reads the same value back into the form, so the dashboard appears to persist it correctly.
  - `packages/core/src/api/launcher-compat.ts:1598-1641` can sync `agent.security` into `config/agent.yaml`, but searches under the core, gateway, and backend runtimes find no enforcement consumer for `bypass_restrictions` beyond the default config declaration at `packages/core/src/api/launcher-compat.ts:1744`.
  - `packages/core/src/tools/executor/file-security.ts:89-122` validates file operations only from `config/tools.yaml` permission levels, absolute-path allowance, and workspace checks.
  - `packages/core/src/tools/executor/shell.ts:142-196` validates shell execution only from `permissions.shell_execute` in `config/tools.yaml`.
  - `packages/core/src/tools/registry/executor.ts:222-269` disables tools from `tool_state`, `disabled_tools`, and per-tool permission levels only.
- Impact: users can enable or disable "Bypass Restrictions" in Config, but file, shell, and tool restrictions remain controlled by unrelated `tools.yaml` policies. The toggle is a visible security control with no backend effect, which can cause both false confidence and confusing debugging.
- Recommended fix: either remove/rename the switch, or define exactly which restrictions it bypasses and plumb that policy into file, shell, and tool permission decisions with audit logging and regression tests.

### 94. Exec Allow Remote switch is saved but no caller-origin policy enforces it

- Evidence:
  - `packages/ui/frontend/src/components/config/config-sections.tsx:1021-1025` renders the Exec "Allow Remote" switch from `form.allowRemote`.
  - `packages/ui/frontend/src/components/config/config-page.tsx:557` saves it as `tools.exec.allow_remote`.
  - `packages/core/src/api/launcher-compat.ts:1723-1725` writes the exec config under `config/tools.yaml` `runtime.exec`.
  - `packages/core/src/api/launcher-compat.ts:1673-1690` derives `permissions.shell_execute` from shell tool state, workspace restriction, and timeout, but it does not map `allow_remote` into any permission field.
  - `packages/core/src/api/index.ts:1323-1368` accepts `caller` and `session_id` for `/tools/:name/call`, but uses `caller` only as an audit actor on session permission denials.
  - `packages/core/src/tools/registry/handlers.ts:49` passes only command, working directory, and timeout into `ShellExecutor.runShell`.
  - `packages/core/src/tools/executor/shell.ts:136-196` has no caller, session, origin, or remote/local context parameter and reads only `permissions.shell_execute`.
  - `packages/core/src/tools/registry/executor.ts:396-413` executes structured tools without applying a caller-origin policy.
- Impact: the dashboard suggests command execution can be limited to local safe contexts, but `allow_remote: false` is never checked before tool execution. Any client path that can reach the tool-call API or MCP bridge and passes the normal auth/session gates follows the standard shell permission state instead of the remote-execution toggle.
- Recommended fix: carry caller origin and session type into `ToolRegistry` and `ShellExecutor`, define trusted local contexts, block remote callers when `runtime.exec.allow_remote === false`, and add tests for API, MCP, dashboard, Pico, and channel-origin tool calls.

### 95. Legacy full Go backend cannot compile from the checked-in module

- Evidence:
  - `packages/ui/backend/go.mod:1-3` declares only the module path and Go version; it has no `require` or `replace` entries for the legacy backend dependencies.
  - `packages/ui/backend/main.go:1` gates the full launcher backend behind the `legacy_backend` tag, and `packages/ui/backend/main.go:31-33` imports `github.com/sipeed/Hiro/pkg/config`, `logger`, and `netbind`.
  - `packages/ui/backend/api/models.go:1-20` is also `legacy_backend`-only and imports `github.com/sipeed/Hiro/pkg/audio/asr`, `config`, `logger`, and `providers`.
  - `packages/ui/backend/dashboardauth/store.go:1-16` imports `golang.org/x/crypto/bcrypt` and `modernc.org/sqlite`.
  - `packages/ui/backend/systray.go:1-10` imports `fyne.io/systray`.
  - `go test ./...` in `packages/ui/backend` passes for the default stub build, but `go test -tags legacy_backend ./...` fails during setup with "no required module provides package" for those Hiro, systray, bcrypt, sqlite, QR, and sync packages.
- Impact: the only Go build that contains the real launcher API is not reproducible from this checkout. Developers cannot test or ship the legacy/full backend by adding the build tag; the build stops before any API tests run. That leaves the project with a working stub backend and a non-compiling full backend path.
- Recommended fix: either remove the dead legacy backend path, or restore a valid Go module for it with explicit `require`/`replace` entries and CI coverage for `go test -tags legacy_backend ./...`. If the Node launcher-compat API is the intended replacement, delete the tagged Go implementation to avoid maintaining an unreachable backend.
