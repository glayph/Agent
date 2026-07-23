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
