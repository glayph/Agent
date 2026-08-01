### 5. `ENABLE_MCP=false` does not gate the gateway `/mcp` proxy

- Evidence:
  - `packages/gateway/src/index.ts:65` reads `enableMcp`.
  - `packages/gateway/src/index.ts:734-745` always mounts the `/mcp` proxy.
  - `packages/gateway/src/index.ts:1051-1054` uses `enableMcp` only for logging.
- Impact: gateway-side behavior does not match the "ENABLE_MCP=false to disable" message. Core may still disable its MCP server, but the gateway proxy remains mounted and forwards requests.
- Recommended fix: mount `/mcp` only when `config.enableMcp` is true, or update the flag/message to describe core-only behavior.

### 6. Go CLI builds invalid URLs for IPv6 hosts

- Evidence:
  - `packages/Hiro-cli/config.go:63-70` accepts arbitrary `--host` values.
  - `packages/Hiro-cli/runtime.go:371-373` correctly uses `net.JoinHostPort` when binding/checking the port.
  - `packages/Hiro-cli/runtime.go:225-227` builds dashboard URL with `fmt.Sprintf("http://%s:%d", host, port)`.
  - `packages/Hiro-cli/runtime.go:277-282` builds health URL the same way.
- Impact: `--host ::1` can produce invalid URLs such as `http://::1:18800`, so the TUI/plain dashboard URL and health polling are broken for IPv6.
- Recommended fix: build URLs with `net.JoinHostPort` plus `url.URL`, for example host `::1` -> `http://[::1]:18800`.

### 7. Vite dev proxy can target pending `GATEWAY_PORT` despite the comment

- Evidence:
  - `packages/ui/frontend/vite.config.ts:14-16` says `.env` `GATEWAY_PORT` may be a pending restart value and only explicit frontend overrides should be used.
  - `packages/ui/frontend/vite.config.ts:17-21` still includes `process.env.GATEWAY_PORT`.
  - `packages/ui/frontend/vite.config.ts:96-114` uses that origin for `/api`, `/gateway`, `/hiro/media`, and `/hiro/ws` proxying.
- Impact: local frontend development can proxy to a port that the live gateway is not using yet, making frontend API calls appear broken after a pending port change.
- Recommended fix: remove `process.env.GATEWAY_PORT` from the dev proxy fallback or treat it only as an explicit dev override with a separate variable.

# Low Priority / Maintenance

### 8. Runtime stale-check rebuilds unrelated targets after root TypeScript config edits

- Evidence:
  - `scripts/build-runtime-if-stale.mjs:27-30` defines root `tsconfig.json` and `tsconfig.base.json` as common build inputs.
  - `scripts/build-runtime-if-stale.mjs:83-110` applies those common inputs to the dashboard and Go backend groups.
  - Root `tsconfig.json:3-8` references only TypeScript packages, not the frontend or Go backend.
- Impact: editing root TS config can force dashboard and Go backend rebuilds even when those targets are unaffected.
- Recommended fix: split common inputs per build group. Keep root TS config inputs for TS package builds only.

### 9. Windows `frontend-pnpm.mjs` assumes Corepack lives beside `node.exe`

- Evidence:
  - `scripts/frontend-pnpm.mjs:16-31` resolves Windows Corepack as `<dirname(process.execPath)>/node_modules/corepack/dist/corepack.js`.
  - `scripts/frontend-pnpm.mjs:42-56` spawns that path directly and exits on the low-level spawn error.
- Impact: Node installs where `corepack` is available as a shim or on PATH, but not inside `node_modules/corepack` next to `node.exe`, cannot bootstrap frontend pnpm through this wrapper.
- Recommended fix: check the computed Corepack path first; if missing, fall back to `corepack` on PATH or provide a clear install/setup error.

### 10. `scripts/postbuild.mjs` is stale and can corrupt import specifiers

- Evidence:
  - Root/package scripts do not reference `postbuild`.
  - `scripts/postbuild.mjs:21` hardcodes scanning `dist`.
  - `scripts/postbuild.mjs:28-43` rewrites import/export specifiers using regex and skips `#`, but not query strings.
- Impact: if run manually, an import like `import("./file?raw")` can become `import("./file?raw.js")`. Since it is not wired into package scripts, it is also dead maintenance surface.
- Recommended fix: remove the script if obsolete. If it is still needed, use an AST-based import rewriter and handle query/hash/path cases explicitly.

# Additional Deep Findings

### 11. Configured CORS origins cannot restrict loopback credentialed origins

- Evidence:
  - `packages/config/src/security.ts:99-130` builds the configured/default CORS origin set.
  - `packages/config/src/security.ts:133-143` returns `true` for any loopback browser origin before checking that configured set.
  - `packages/gateway/src/index.ts:524-538` reflects the normalized request origin and sets `Access-Control-Allow-Credentials: true`.
  - `packages/core/src/api/launcher-compat.ts:1940-1945` sets the dashboard session cookie as host-scoped; browser cookie scoping ignores ports.
- Impact: when a user configures a narrow `Hiro_ALLOWED_ORIGINS` value, any page served from another loopback port can still make credentialed browser requests to the dashboard API with `credentials: "include"`.
- Recommended fix: remove the unconditional loopback bypass when explicit origins are configured, or make the bypass development-only and opt-in. Credentialed CORS should honor the configured allowlist exactly.

### 12. LAN Access can break dashboard API calls because allowed origins are not updated

- Evidence:
  - `packages/ui/frontend/src/components/config/config-page.tsx:642-653` saves launcher `public` and `allowed_cidrs` settings.
  - `packages/core/src/api/launcher-compat.ts:5890-5915` persists `public` and updates only `GATEWAY_HOST`/`GATEWAY_PORT`.
  - `packages/config/src/security.ts:112-119` defaults allowed CORS origins to localhost/127.0.0.1 for the gateway port.
  - `packages/gateway/src/index.ts:524-548` rejects browser requests whose `Origin` is not allowed.
- Impact: enabling LAN Access binds the service to `0.0.0.0`, but a browser opened at `http://<LAN-IP>:18800` sends an origin that is not in the default allowlist. Mutating API calls and websocket handshakes can fail even though the UI setting says other network devices can access the service.
- Recommended fix: when LAN Access is enabled, derive and persist a matching allowed-origin policy, or apply a secure same-host origin rule for the actual gateway host. Do not silently widen to every LAN origin.

### 13. `allowed_cidrs` is saved but not validated or enforced in the Node runtime

- Evidence:
  - `packages/ui/frontend/src/components/config/form-model.ts:512-520` splits CIDR text but does not validate CIDR syntax.
  - `packages/core/src/api/launcher-compat.ts:5890-5906` accepts string array values and stores them without parsing or enforcement.
  - The legacy Go backend validates CIDRs in `packages/ui/backend/launcherconfig/config.go:39-49`.
  - The legacy Go backend enforces CIDRs through `packages/ui/backend/middleware/access_control.go:12-47`.
- Impact: in the current Node runtime, `allowed_cidrs` is a false security control. Invalid CIDRs can be saved, and valid CIDRs do not restrict client IP access.
- Recommended fix: add CIDR validation in the Node launcher config path and enforce the allowlist in gateway/core HTTP and websocket upgrade middleware. Keep Node and Go behavior consistent.

### 14. Browser and device-code OAuth flows can never complete

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:5050-5069` creates browser/device OAuth flows with `status: "pending"` and returns an OpenAI API keys URL.
  - `packages/core/src/api/launcher-compat.ts:5078-5086` only changes the flow to `expired`; there is no success transition or token exchange.
  - `packages/ui/frontend/src/hooks/use-credentials-page.ts:80-108` keeps polling while status is `pending`.
  - `packages/ui/frontend/src/hooks/use-credentials-page.ts:187-224` starts browser OAuth polling, and `packages/ui/frontend/src/hooks/use-credentials-page.ts:242-275` starts device-code polling.
- Impact: Browser OAuth and device-code actions leave the UI pending until expiry. Provider status never becomes connected through those flows; only manual token save can work.
- Recommended fix: either implement the real OAuth callback/device-code exchange and persist credentials on success, or remove/relabel these flows as manual API-key guidance. Browser popups should also be opened with `noopener`.
