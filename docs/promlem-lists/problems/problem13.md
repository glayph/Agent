
### 122. Health Flow marks major branches Ready without verifying their runtime contracts

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:3556` reads tool definitions, but `:3632-3635` still hard-codes the Agent Core component as `status: "ready"`.
  - `packages/core/src/api/launcher-compat.ts:3643-3647` hard-codes Memory / Context as ready after a best-effort session count read, with no database/write-path health check.
  - `packages/core/src/api/launcher-compat.ts:3706-3716` hard-codes External Systems as ready even when registered tool count is zero or channel/file/browser handlers are not actually callable.
  - `packages/core/src/api/launcher-compat.ts:3581-3584` marks plugin and model branches ready from non-empty metadata counts, not from executable skill/plugin checks or provider/LiteLLM health.
  - `packages/core/src/api/launcher-compat.ts:3728-3758` adds gaps only for no skills, MCP partial, no model, and pending restart. It does not add gaps for failed tool execution surfaces, missing channel runtime adapters, unauthenticated direct tool routes, or the already-known inert Agent Runs/Flow branches.
  - `packages/ui/frontend/src/components/health/flow-status-panel.tsx:63-67` counts components as ready from those backend statuses, and `:168-170` shows "No Flow.md gaps detected" when the narrow `gaps` array is empty.
- Impact: the Health page can present the runtime graph as ready even when key contracts are metadata-only, disabled elsewhere, or not executable. This turns the Flow panel into a false readiness signal and can hide setup/debugging problems behind a clean-looking health view.
- Recommended fix: derive every Flow component from concrete health probes: tool execution availability, model provider/LiteLLM status, memory read/write checks, mounted channel adapters, plugin executable readiness, and auth state. Add explicit gaps for metadata-only or config-only branches instead of marking them ready.

### 123. Gateway log clear reports success even when log files were not cleared

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:4473-4481` loops over `core_backend.log` and `litellm_proxy.log`, catches every `fs.writeFileSync(...)` failure, ignores it, and still returns `{ status: "cleared", log_total: 0 }`.
  - `packages/ui/frontend/src/hooks/use-gateway-logs.ts:16-25` trusts that response, clears the local log list, and advances the log offset to the returned total.
  - `packages/ui/frontend/src/hooks/use-gateway-logs.ts:26-29` also catches frontend clear failures silently, so users do not get a visible error if the clear request fails.
- Impact: if a log file is missing, locked, permission-denied, or on a failing filesystem, the UI can show an empty log panel while the backend log files still contain old data. Subsequent polling starts from offset `0`/the reported run id and can leave users with inconsistent log state.
- Recommended fix: make the clear route collect per-file results, return an error when any required log file cannot be truncated, and let the frontend show that failure without clearing local state. If missing files are acceptable, distinguish missing from failed writes explicitly.

### 124. Drive copy follows symlink and junction descendants even though symlinks are rejected at the selected path

- Evidence:
  - `packages/core/src/api/file-manager-router.ts:425-442` validates only the selected `sourcePath` with `assertSafeFilesystemNode(sourcePath)` before recursively copying directories with `fsp.cp(...)`.
  - `packages/core/src/api/file-manager-router.ts:1106-1121` calls that copy helper for dashboard `/api/files/copy` requests after checking only the destination directory and final target path.
  - `packages/core/src/api/file-manager-router.ts:221-224` explicitly rejects a symbolic link when the final target itself is a symlink, but the recursive copy path does not walk and reject symlink or junction descendants inside a selected directory.
  - A contained Windows repro in this workspace showed Node `fs.cpSync(src, dst, { recursive: true })` copying a directory junction descendant as a normal copied directory and reading the outside file through the copied path.
- Impact: copying a normal-looking folder from Drive can unexpectedly traverse symlink/junction descendants and import external filesystem contents into the workspace or another destination. This bypasses the file manager's "symbolic links are not supported" safety expectation for recursive copy and can copy far more data than the selected tree appears to contain.
- Recommended fix: implement a recursive preflight for copy that walks selected directories with `lstat`, rejects symlink/junction descendants, and enforces file count/byte/depth limits before `fsp.cp`. Use `verbatimSymlinks`/manual copy semantics only when explicitly supported, and add regression tests for nested POSIX symlinks and Windows junctions.
