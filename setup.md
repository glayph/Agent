# Setup Guide

Complete setup and development-environment guide for Hiro on a fresh Windows installation.

## Overview

The project is a TypeScript/Node monorepo (npm workspaces) that runs a core agent plus an Express gateway, with LLM calls made directly to Gemini / OpenRouter / OpenAI. It also builds a pnpm-based web UI and optional Go helper binaries during the build step.

| Component | Ecosystem | Installed by | Required |
|---|---|---|---|
| Node runtime | system | winget | Yes |
| Go toolchain | system | winget | No (Go binaries only) |
| Git | system | winget | Only for cloning |
| JS packages (npm) | npm | `npm ci` | Yes |
| Web UI (react, vite, ...) | pnpm | `npm run build` (corepack) | No (headless agent works) |
| Playwright browsers | downloader | `npx playwright install` | No (browser tools only) |
| better-sqlite3 native binding | npm postinstall | `npm ci` (`allowScripts`) | Yes |

## 1. Install system prerequisites

Open PowerShell and run:

```powershell
winget install -e --id Git.Git --silent
winget install -e --id OpenJS.NodeJS.LTS --silent
winget install -e --id Python.Python.3.12 --silent
winget install -e --id GoLang.Go --silent   # optional
```

Then **close and reopen the terminal** so PATH refreshes, and verify:

```powershell
node --version
npm --version
corepack --version
python --version
git --version
```

Node must be `>=20.19`. Corepack ships with Node and is used to run pnpm during the build.

## 2. Get the code

```powershell
git clone https://github.com/glayph/agent.git
cd agent
```

## 3. Install JavaScript dependencies

```powershell
npm ci --no-audit --no-fund
```

Installs all workspace packages (`@hiro/core`, `@hiro/gateway`, `@hiro/config`, `@hiro/skills`, `@hiro/installer`, `graphrag-memory`, `@hiro/cli`) and every third-party npm library. The root `allowScripts` setting permits the `better-sqlite3` native rebuild; `npm ci` handles it automatically.

## 4. Python dependencies (optional, skill-only)

```powershell
python -m pip install --user -r requirements.txt
```

LLM calls go directly to Gemini / OpenRouter / OpenAI, so no Python gateway is required. The remaining entries in `requirements.txt` are optional skill-only packages (matplotlib, numpy, arxiv, etc.).

## 5. Create and configure `.env`

```powershell
Copy-Item .env.example .env
```

This is the step that silently breaks everything if skipped. Edit `.env` or use the dashboard's Models page to set a provider API key:

- `GEMINI_API_KEY` (or `OPENAI_API_KEY` / `OPENROUTER_API_KEY`) — the agent cannot serve models without one

You can also set a key from the CLI with `mikiagent config set GEMINI_API_KEY <your-key>`. Keys are stored in your user profile secret vault, not in the project `.env` file.

## 6. Build

```powershell
npm run build
```

- Compiles TypeScript to `dist/`
- Installs and builds the web UI via pnpm (corepack)
- Compiles Go helper binaries if Go is present (skipped with a warning otherwise)

## 7. Run

```powershell
npm start
```

- Dashboard: `http://127.0.0.1:18800`

For development with live rebuilds: `npm run dev`.

## 8. Optional extras

```powershell
npx playwright install   # browser binaries - only for browser/crawler tools
```

## Verification

```powershell
# Dashboard health
Invoke-WebRequest http://127.0.0.1:18800/health/liveliness

# Model list
Invoke-WebRequest http://127.0.0.1:18800/api/models
```

## Troubleshooting

- **Chat fails with a missing-credential error** — no Gemini / OpenRouter / OpenAI API key is configured. Add one via the Models page, `mikiagent config set GEMINI_API_KEY <your-key>`, or `.env`.
- **Provider rejects the API key (401/403)** — the stored key is invalid. Update it in the dashboard Credentials or Models page.
- **`npm run doctor` hangs / starts the gateway** — the current `bin/miki.js` has no doctor branch; use the manual checks above instead.
