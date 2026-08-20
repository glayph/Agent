# Miki Agent v0.1.0 — Release Notes

## Release Package

| File | Size | SHA256 |
|------|------|--------|
| `miki-0.1.0.tgz` | 41 MB | `95d59f1db4122bf3683a60cb827e3cd23836a62905465008c9073d9a7307e9ae` |

## What's Included

### TypeScript Packages (fully compiled)
- ✅ `@miki/config` — Configuration & security module
- ✅ `@miki/core` — Agent engine
- ✅ `@miki/gateway` — Express gateway (Core + reverse proxy)
- ✅ `@miki/installer` — Installer module
- ✅ `@miki/skills` — Skills module
- ✅ `@miki/memory` — Graph memory module

### Frontend
- ✅ `Miki-web` (React + Vite) — Full production build

### Go Binaries
- ⚠️ `Miki-cli` — Requires Go 1.22+ to build from source (`packages/cli`)
- ⚠️ `Miki-web backend` — Requires Go 1.22+ (`packages/ui/backend`)

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
npm install miki-0.1.0.tgz
```

## Verify Integrity

```bash
sha256sum -c miki-0.1.0.sha256
```
