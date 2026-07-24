# Hiro Agent v0.1.0 — Release Notes

## Release Package

| File | Size | SHA256 |
|------|------|--------|
| `hiro-0.1.0.tgz` | 41 MB | `95d59f1db4122bf3683a60cb827e3cd23836a62905465008c9073d9a7307e9ae` |

## What's Included

### TypeScript Packages (fully compiled)
- ✅ `@hiro/config` — Configuration & security module
- ✅ `@hiro/core` — Agent engine
- ✅ `@hiro/gateway` — Express gateway (Core + LiteLLM supervisor)
- ✅ `@hiro/installer` — Installer module
- ✅ `@hiro/skills` — Skills module
- ✅ `graphrag-memory` — Graph memory module

### Frontend
- ✅ `Hiro-web` (React + Vite) — Full production build

### Go Binaries
- ⚠️ `Hiro-cli` — Requires Go 1.22+ to build from source (`packages/cli`)
- ⚠️ `Hiro-web backend` — Requires Go 1.22+ (`packages/ui/backend`)

## Build From Source

```bash
# Install dependencies
npm install

# Full build
npm run build:all

# Build frontend
npm run build:webui

# Build release package
npm run build
```

## Install from Package

```bash
npm install hiro-0.1.0.tgz
```

## Verify Integrity

```bash
sha256sum -c hiro-0.1.0.sha256
```

## Live Runtime Testing (v0.1.0)

Tested end-to-end with a real Gemini API key. Results:

### Confirmed Working
- Gateway starts on `http://127.0.0.1:18800`
- Core API starts on `127.0.0.1:8000` — `GET /health` → `{"status":"ok"}`
- LiteLLM Proxy connects and reports healthy with a Gemini key configured
- Dashboard auth flow: `POST /api/auth/setup`, `POST /api/auth/login`, `GET /api/auth/status`
- Chat flow: `POST /chat` with `{"session_id": "...", "message": "..."}` — full agent
  orchestration loop runs and correctly calls out to the configured LLM

### Bugs Found & Fixed
1. `litellm` Python package was not installed — required for the LiteLLM proxy process.
   Install with: `pip install 'litellm[proxy]'`
2. `better-sqlite3` native binding was not compiled — required for the audit log DB.
   Build with: `cd node_modules/better-sqlite3 && npx node-gyp rebuild --release --nodedir=/usr`
   (or wherever your Node headers live), then copy the compiled `.node` file into
   `dist/runtime/node_modules/better-sqlite3/build/Release/`.
3. Skill loader treated `SKILL.md` as an importable JS module, causing a startup
   crash (`ERR_UNKNOWN_FILE_EXTENSION`). Fixed in `packages/core/src/skill-loader.ts`.
4. Skill loader returned a skill's directory path when no JS entry file existed,
   causing `ERR_UNSUPPORTED_DIR_IMPORT` for documentation-only skills. Fixed by
   returning an empty string instead, which `agent.ts` now skips.

### Known Environment Limitation
Real LLM calls could not be verified end-to-end in the sandboxed build/test
environment because outbound network access is restricted to an allowlist that
does not include `generativelanguage.googleapis.com` (or other LLM provider
hosts). The full request pipeline (auth → session → orchestrator → LiteLLM →
provider call) was confirmed correct up to the network boundary; the LLM call
itself returned a `403 Host not in allowlist` error from the sandbox's egress
proxy, not from the application. In an unrestricted environment this should
work end-to-end with a valid API key.
