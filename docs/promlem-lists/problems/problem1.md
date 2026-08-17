### 11. Configured CORS origins cannot restrict loopback credentialed origins

- Evidence:
  - `packages/config/src/security.ts:99-130` builds the configured/default CORS origin set.
  - `packages/config/src/security.ts:133-143` returns `true` for any loopback browser origin before checking that configured set.
  - `packages/gateway/src/index.ts:524-538` reflects the normalized request origin and sets `Access-Control-Allow-Credentials: true`.
  - `packages/core/src/api/launcher-compat.ts:1940-1945` sets the dashboard session cookie as host-scoped; browser cookie scoping ignores ports.
- Impact: when a user configures a narrow `MIKI_ALLOWED_ORIGINS` value, any page served from another loopback port can still make credentialed browser requests to the dashboard API with `credentials: "include"`.
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
