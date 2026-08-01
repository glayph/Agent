
## Issue #5: ENABLE_MCP=false does not gate the gateway /mcp proxy

**Status**: ✅ Already Fixed

**Original Problem**:
- `packages/gateway/src/index.ts:65` reads `enableMcp`
- `packages/gateway/src/index.ts:734-745` always mounted the `/mcp` proxy
- `packages/gateway/src/index.ts:1051-1054` used `enableMcp` only for logging

**Evidence of Fix**:
- Current code at `packages/gateway/src/index.ts:824` properly checks `if (config.enableMcp)` before mounting `/mcp` proxy
- The `/mcp` proxy is only mounted when the flag is true
- Behavior now matches the configuration

**Impact**:
- Gateway-side behavior now matches the "ENABLE_MCP=false to disable" message
- MCP proxy is properly gated by the configuration flag

---

## Issue #6: Go CLI builds invalid URLs for IPv6 hosts

**Status**: ✅ Fixed

**Original Problem**:
- `packages/Hiro-cli/runtime.go:225-227` built dashboard URL with `fmt.Sprintf("http://%s:%d", host, port)`
- `packages/Hiro-cli/runtime.go:277-282` built health URL the same way
- `--host ::1` could produce invalid URLs such as `http://::1:18800`

**Evidence of Fix**:
- Updated `DashboardURL()` function to use `url.URL` struct for proper URL construction
- Updated `pollHealth()` function to use `url.URL` struct for health URL
- IPv6 addresses are now properly formatted with brackets: `http://[::1]:18800`

**Impact**:
- TUI/plain dashboard URL and health polling now work correctly for IPv6 hosts
- URLs are properly formatted according to RFC standards
- Go CLI can now handle IPv6 addresses correctly

---

## Issue #7: Vite dev proxy can target pending GATEWAY_PORT despite the comment

**Status**: ✅ Already Fixed

**Original Problem**:
- `packages/ui/frontend/vite.config.ts:14-16` said `.env` `GATEWAY_PORT` may be a pending restart value
- `packages/ui/frontend/vite.config.ts:17-21` still included `process.env.GATEWAY_PORT`
- This could cause frontend to proxy to wrong port after pending changes

**Evidence of Fix**:
- Current code at `packages/ui/frontend/vite.config.ts:17-20` only uses `VITE_GATEWAY_PORT` overrides
- No longer includes general `GATEWAY_PORT` in the proxy fallback
- Comment accurately describes the actual behavior

**Impact**:
- Frontend dev proxy no longer targets pending restart values
- Only explicit frontend overrides are used for proxy configuration

---

## Issue #8: Runtime stale-check rebuilds unrelated targets after root TypeScript config edits

**Status**: ✅ Already Fixed

**Original Problem**:
- `scripts/build-runtime-if-stale.mjs:27-30` defined root `tsconfig.json` as common build input
- This was applied to dashboard and Go backend groups which don't depend on it
- Editing root TS config forced unnecessary rebuilds

**Evidence of Fix**:
- Current build script already separates build inputs per group
- TypeScript packages use root tsconfig files
- Dashboard and Go backend have their own specific inputs
- No cross-contamination of build dependencies

**Impact**:
- Build system is more efficient
- Unnecessary rebuilds are avoided
- Build dependencies are accurate

---

## Issue #9: Windows frontend-pnpm.mjs assumes Corepack lives beside node.exe

**Status**: ✅ Already Fixed

**Original Problem**:
- `scripts/frontend-pnpm.mjs:16-31` resolved Windows Corepack as `<dirname(process.execPath)>/node_modules/corepack/dist/corepack.js`
- This failed when Corepack was available as shim or on PATH
- Script exited with cryptic error on missing path

**Evidence of Fix**:
- Current code at `scripts/frontend-pnpm.mjs:16-59` has multiple fallback strategies
- First tries bundled path, then checks PATH with `where` command, then checks common locations
- Provides clear error messages if Corepack cannot be found
- More robust Corepack resolution

**Impact**:
- Works with various Corepack installations (bundled, shim, global)
- Better error messages for troubleshooting
- More reliable frontend package management

---
