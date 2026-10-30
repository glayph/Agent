# Miki

Miki is an autonomous agent with a web dashboard. The gateway serves the dashboard and API, and the launcher (`npm start`) starts the gateway, the core agent, and the memory service.

## Requirements

- Node.js 22.19.0 or newer (`node -v`)
- npm (the workspace is managed with npm; use `package-lock.json`)
- Git
- Optional, depending on which features you use:
  - Chrome or Chromium (browser automation)
  - ffmpeg (media tasks; set `MIKI_FFMPEG_EXECUTABLE` if it is not on `PATH`)
  - Python (set `MIKI_PYTHON_BIN` if it is not on `PATH`)

## Install and build

Run these from the project root. Do not use `--ignore-scripts`: the native SQLite module and the Playwright step need their install scripts.

```bash
npm ci
npm run build:all
```

`build:all` builds every workspace package and the dashboard. If it fails, fix the reported error and run it again.

## Configure

1. Copy the template and fill in only the settings you need:

   ```bash
   cp config/.env.example .env
   ```

2. Miki reads `.env` from the project root (and `config/.env` if present) when the launcher starts. Values already set in your shell take priority over the file. Lines with an empty value are ignored.

Common settings:

| Variable | Purpose |
| --- | --- |
| `MIKI_PROVIDER`, `MIKI_MODEL` | Default model provider and model name |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Used when no model is configured in the dashboard |
| `MIKI_MODEL_PATH` | Path to a local GGUF model (for the local llama.cpp runtime) |
| `GATEWAY_HOST` | Bind address for the gateway (default `127.0.0.1`) |
| `GATEWAY_PORT` | Gateway port (default `18800`) |
| `MIKI_VAULT_KEY` | Passphrase for the secret vault (see below) |
| `MIKI_SKIP_PLAYWRIGHT_INSTALL=true` | Skip the Chromium download during install |

## Run

```bash
npm start
```

Open the dashboard at `http://127.0.0.1:18800` (or your `GATEWAY_HOST`/`GATEWAY_PORT`). Use the dashboard to add a model (Models page) and configure channels. Alternatively, set the provider variables above before starting.

## Secret vault

Credentials are stored in `data/secret-vault.json` under the runtime data root, and the key is in `data/secret-vault.key` (or you can supply a passphrase in `MIKI_VAULT_KEY`). Back up both files together. If you lose the key, the stored credentials cannot be recovered.

## Troubleshooting

- **"Could not locate the bindings file" (better-sqlite3):** run `npm rebuild better-sqlite3`, or reinstall with `npm ci`.
- **Launcher reports missing `dist` files:** run `npm run build:all`.
- **Port already in use:** set `GATEWAY_PORT` to a free port.
- **"No model is configured":** add a model in the dashboard or set `MIKI_PROVIDER`/`MIKI_MODEL` and the matching API key.
- **Vault locked or unreadable:** make sure `MIKI_VAULT_KEY` matches the passphrase used when the vault was created, or that `secret-vault.key` is present next to `secret-vault.json`.

## Tests

```bash
npm run test --workspace=@miki/gateway
npm --prefix packages/ui/frontend run test
```
