# Fixed Issues

This file tracks problems that have been resolved.

---

## Issue #1: Packaged Go compatibility backend cannot serve dashboard assets

**Status**: ✅ Fixed

**Original Problem**:
- `packages/ui/backend/stub_main.go:57` sets `distDir := filepath.Join(".", "dist")`
- `packages/ui/backend/stub_main.go:42-47` serves static files only when `distDir/index.html` exists, otherwise returns `503`
- `scripts/prepare-runtime-package.mjs:225-232` copies frontend assets to `dist/runtime/packages/ui/frontend/dist`, but copies only `packages/ui/backend/dist/bin` into the backend runtime path
- `scripts/assert-pack-contents.mjs:54-55` verifies frontend `index.html` and backend binary separately, but does not require `dist/runtime/packages/ui/backend/dist/index.html`

**Evidence of Fix**:
- Updated `scripts/prepare-runtime-package.mjs` to copy frontend assets to both locations
- Added `copyRecursive(path.join(root, "packages/ui", "frontend", "dist"), path.join(stagingRoot, "packages/ui", "backend", "dist"))`
- This ensures the Go stub can find frontend assets in its expected location

**Impact**:
- Packaged runtime can now serve dashboard assets correctly
- The stub backend will no longer return "assets are not built" error when assets are present

---

## Issue #2: Model delete flow drops restart metadata and hides failures

**Status**: ✅ Already Fixed

**Original Problem**:
- Backend delete returns restart/apply metadata at `packages/core/src/api/launcher-compat.ts:4817-4843`
- Frontend API type omitted those fields at `packages/ui/frontend/src/api/models.ts:63-67`
- `packages/ui/frontend/src/components/models/delete-model-dialog.tsx:38-45` ignored the delete response, never refreshed gateway state, swallowed errors, and closed the dialog in `finally`

**Evidence of Fix**:
- Current `delete-model-dialog.tsx` already calls `refreshGatewayState({ force: true })` after delete
- Already uses `showSaveSuccessOrRestartToast` with gateway restart status
- Properly handles the delete response and errors
- Consistent with add/edit/default model flows

**Impact**:
- Delete flow now properly surfaces restart/apply status
- Gateway state is refreshed after delete operations
- Errors are properly displayed to users

---

## Issue #3: Gateway port environment parsing can produce invalid runtime config

**Status**: ✅ Already Fixed

**Original Problem**:
- `packages/gateway/src/index.ts:58-61` was using raw `parseInt` for `CORE_PORT`, `GATEWAY_PORT`, and `LITELLM_PORT` parsing
- Invalid values such as `GATEWAY_PORT=abc` would become `NaN`, which could break startup, create bad health URLs/proxy targets, or persist bad launcher state

**Evidence of Fix**:
- `packages/gateway/src/index.ts:61-64` already uses `positiveIntEnv` for all port parsing
- `packages/core/src/api/launcher-compat.ts:3135` and `3185` use `positiveIntFromEnv` with proper validation
- Invalid values now fallback to safe defaults instead of producing `NaN`

**Impact**:
- Invalid port environment variables now safely fall back to defaults instead of causing NaN errors
- Gateway startup is more robust against configuration mistakes

---

## Issue #4: Gateway MCP rate limiter (dead code)

**Status**: ✅ Fixed

**Original Problem**:
- `packages/gateway/src/index.ts:556-567` declared `rateLimitBuckets` and a cleanup timer
- No middleware actually incremented or checked the buckets
- The `/mcp` endpoint traffic was not actually rate limited despite the code suggesting it should be

**Evidence of Fix**:
- Removed the unused `mcpRateLimitMiddleware` function from `packages/gateway/src/index.ts`
- Removed the middleware call from the `/mcp` proxy configuration
- Updated comments to remove references to rate limiting

**Impact**:
- Eliminated false security signal from unused rate limiting code
- Reduced code complexity by removing dead code
- Made the actual behavior (no rate limiting) explicit in the code

---

