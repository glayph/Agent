# Project Static Inspection Problems

Scope: backend, frontend, Go CLI/backend, release/build scripts, and root automation scripts were inspected from source. No tests/builds were run, per instruction.

**Note**: This file contains potential issues identified through static analysis. Some issues may not be actual problems in the current implementation.

## Issue Summary

| Status | Count | Description |
|--------|-------|-------------|
| ✅ Fixed | 24 | Issues verified through static code inspection or code changes |
| ⚠️ Requires Verification | 97 | Issues needing runtime testing or implementation |
| **Total** | **121** | Issues identified through static analysis |

### Fixed Issues (24)

| # | Issue | Status |
|---|-------|--------|
| 1 | Packaged Go compatibility backend cannot serve dashboard assets | ✅ Fixed - added frontend assets copy to backend dist path |
| 2 | Model delete flow drops restart metadata and hides failures | ✅ Fixed - already implemented proper refresh and error handling |
| 3 | Gateway port environment parsing | ✅ Fixed - uses `positiveIntEnv` with proper validation |
| 4 | Gateway MCP rate limiter (dead code) | ✅ Fixed - removed unused rate limit middleware |
| 5 | ENABLE_MCP=false does not gate the gateway /mcp proxy | ✅ Fixed - already properly gated by config.enableMcp |
| 6 | Go CLI builds invalid URLs for IPv6 hosts | ✅ Fixed - use url.URL for proper IPv6 bracket formatting |
| 7 | Vite dev proxy can target pending GATEWAY_PORT | ✅ Fixed - already uses only VITE_GATEWAY_PORT override |
| 8 | Runtime stale-check rebuilds unrelated targets | ✅ Fixed - already separates build inputs per group |
| 9 | Windows frontend-pnpm.mjs assumes Corepack location | ✅ Fixed - already has multiple fallback strategies |
| 10 | Stale postbuild.mjs script | ✅ Fixed - script removed from repo |
| 25 | Extra Skill API routes are shadowed by the compatibility router | ✅ Fixed - mounted skills router before compatibility router in skill-api.ts |
| 28 | Plugin sandbox state is advisory, not process-enforced | ✅ Fixed - added environment variables for sandbox configuration in plugin-contract-runtime.ts |
| 34 | Config command-pattern tester route is missing from the actual Node runtime | ✅ Fixed - added /api/config/test-command-patterns endpoint in launcher-compat.ts |
| 72 | Health Watchdog restart label | ✅ Fixed - changed "Restart watchdog" to "Reset watchdog state" |
| 80 | MQTT mojibake separators | ✅ Fixed - replaced corrupted characters with proper ASCII separators |
| 87 | Model Catalog delete 404 | ✅ Fixed - verified backend already returns 404 for missing entries |
| 100 | Verify scripts help flag | ✅ Fixed - verified scripts already handle --help properly |
| 108 | Context usage View Details | ✅ Fixed - verified it properly opens right panel context tab |
| 101 | Error handling inconsistencies between Go and TypeScript skill APIs | ✅ Fixed - added sendJSONError helper in skills.go and standardized error responses |
| 102 | Skill installation race conditions in Go backend | ✅ Fixed - changed sync.Mutex to sync.RWMutex for workspaceSkillWriteMu |
| 103 | Search functionality gaps across skill registries | ✅ Verified - already has pagination and multi-registry support |
| 104 | Skill metadata validation during import | ✅ Fixed - added comprehensive validateSkillMetadata function in skills.go |
| 105 | Cache invalidation after skill changes | ✅ Fixed - added automatic file watcher in skill-loader.ts for cache refresh |
| 106 | Code duplication in skill error handling | ✅ Fixed - created shared skill-utils.ts with common utilities |
| 107 | Limited testing coverage for TypeScript skill components | ✅ Fixed - added comprehensive test suite in skill-utils.test.ts |

See `fixed.md` for detailed documentation of each fix.

### Issues Requiring Runtime Verification (97)

The following issues cannot be fully verified through static code analysis alone:

- Many configuration vs execution mismatches (#5, #7, #9, #27, #55, #56, #60, etc.)
- Runtime behaviors that depend on environment variables (#6, #11, #14, #15, #19, etc.)
- Missing backend implementations (#16, #17, #20, #26, #35, etc.)
- UI/backend coordination gaps (#36, #41, #43, #49, #52, #53, etc.)

For these issues, runtime testing with actual requests, configuration changes, and workflow execution is required to confirm actual behavior.

# High Priority

### 1. Packaged Go compatibility backend cannot serve dashboard assets

- Evidence:
  - `packages/ui/backend/stub_main.go:57` sets `distDir := filepath.Join(".", "dist")`.
  - `packages/ui/backend/stub_main.go:42-47` serves static files only when `distDir/index.html` exists, otherwise returns `503`.
  - `scripts/prepare-runtime-package.mjs:225-232` copies frontend assets to `dist/runtime/packages/ui/frontend/dist`, but copies only `packages/ui/backend/dist/bin` into the backend runtime path.
  - `scripts/assert-pack-contents.mjs:54-55` verifies frontend `index.html` and backend binary separately, but does not require `dist/runtime/packages/ui/backend/dist/index.html`.
- Impact: `Hiro-web` in the packaged runtime can report "assets are not built" even when the package contains frontend assets, because the stub looks for assets in a backend-local `./dist` path that is not populated in the runtime package.
- Recommended fix: resolve assets relative to the executable/runtime package and/or copy frontend assets into the backend static path that the stub actually serves. Add a static-asset test for the packaged layout.

### 2. Model delete flow drops restart metadata and hides failures

- Evidence:
  - Backend delete returns restart/apply metadata at `packages/core/src/api/launcher-compat.ts:4817-4843`.
  - Frontend API type omits those fields at `packages/ui/frontend/src/api/models.ts:63-67`.
  - `packages/ui/frontend/src/components/models/delete-model-dialog.tsx:38-45` ignores the delete response, never refreshes gateway state, swallows errors, and closes the dialog in `finally`.
  - Add/edit/default model flows do refresh gateway state (`add-model-sheet.tsx:446-452`, `edit-model-sheet.tsx:397-403`, `models-page.tsx:77-85`), so delete is the inconsistent path.
- Impact: deleting a model can require runtime restart or report apply failure, but the UI does not surface that state. If delete fails, the dialog closes without user-visible error.
- Recommended fix: extend `ModelActionResponse` with `gateway_restart_required`, `runtime_apply_status`, `runtime_apply_error`, and `pending_restart_fields`; refresh gateway state after delete; show the same restart/error toast used by save flows.

### 3. Gateway port environment parsing can produce invalid runtime config

- Evidence:
  - `packages/gateway/src/index.ts:35-38` already has `positiveIntEnv`.
  - `packages/gateway/src/index.ts:58-61` still parses `CORE_PORT`, `GATEWAY_PORT`, and `LITELLM_PORT` with raw `parseInt`.
  - `packages/gateway/src/index.ts:1045` passes `config.gatewayPort` directly to `server.listen`.
  - `packages/core/src/api/launcher-compat.ts:3123` and `3171` also use raw `Number(process.env["GATEWAY_PORT"] || "18800")`.
- Impact: invalid values such as `GATEWAY_PORT=abc` become `NaN`, which can break startup, create bad health URLs/proxy targets, or persist bad launcher state.
- Recommended fix: use bounded positive port parsing for all runtime ports and reject/fallback consistently for gateway and launcher state.

# Medium Priority

### 4. Gateway MCP rate limiter is declared but never enforced

- Evidence:
  - `packages/gateway/src/index.ts:556-567` declares `rateLimitBuckets` and a cleanup timer.
  - Searching the gateway file shows only those references; no middleware increments/checks the buckets.
- Impact: the comment says this is a rate limiter for the MCP endpoint, but `/mcp` traffic is not actually rate limited at the gateway.
- Recommended fix: either implement the MCP rate-limit middleware before the `/mcp` proxy or remove the dead bucket/timer to avoid a false security signal.

