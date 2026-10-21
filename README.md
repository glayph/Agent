<div align="center">

# ✨ Miki

### *Your local-first, autonomous AI agent*

**Remembers everything · Works across every channel · Runs on your own machine**

[![Node](https://img.shields.io/badge/Node.js-%E2%89%A5%2022.19-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![pnpm](https://img.shields.io/badge/pnpm-workspaces-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![Platform](https://img.shields.io/badge/Ubuntu%20%7C%20Windows-VirtualBox-7F3FBF)](#-installation)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.14-ff69b4)](package.json)

</div>

---

## 🌈 What is Miki?

Miki is a **local-first autonomous agent**. It plans, uses tools, browses the web, edits files, and reports back, all while keeping one **global memory** that follows you from the chat window to Telegram and beyond.

| | Feature | What it means |
|---|---|---|
| 🧠 | **Global memory** | One owner-only memory shared by every channel. Nothing is forgotten between sessions. |
| 💬 | **Task-per-chat** | Every new task opens its own chat, so you always see *what* started *when* and *why*. |
| 🖼️ | **Visual proof** | Screenshots and generated files appear right inside the conversation. |
| 🛠️ | **Real tools** | Browser automation, file workspace, skills, and MCP connectors. |
| 🌏 | **Bengali-aware** | Tokenizer and retrieval handle Bengali text properly. |
| 🔒 | **Yours** | Runs locally; your data stays in your data directory. |

---

## 🗺️ Architecture at a glance

```
          ┌─────────────────────────────┐
          │                 Channels                     │
          │   💻 Web chat   📱 Telegram   🔌 MCP tools   │
          └─────────────────────────────┘
                                  ▼
          ┌─────────────────────────────┐
          │  gateway  ·  REST + WebSocket  ·  auth       │
          └─────────────────────────────┘
                                  ▼
   ┌────────┬────────────────────┬─────────┐
   │ 🤖 core     │ 🧠 memory                     │ 🧩 skills     │
   │ agent loop  │ graph + paragraph recall      │ bundled tools │
   │ tools/LLMs  │ global, owner-only            │ & workflows   │
   └────────┴────────────────────┴─────────┘
        ▲                  ▲                         ▲
     ⚙️ config         📦 installer               🎨 ui (React)
```

| Package | Role |
|---|---|
| `packages/core` | Agent engine, LLM providers, tools, autonomy, safety |
| `packages/gateway` | Express + WebSocket server, sessions, auth, chat media |
| `packages/memory` | Global graph-based memory and retrieval |
| `packages/skills` | Bundled and downloadable skills |
| `packages/config` | Typed runtime configuration and validation |
| `packages/installer` | Guided setup |
| `packages/ui` | Dashboard and chat interface (React + Vite) |
| `packages/cli` | Command-line access |

---

## 🚀 Quick start

> **Requirements:** Node.js 22.19+, npm, and Git. Ubuntu (recommended) or Windows. Running inside an Oracle VirtualBox Ubuntu VM works well.

```bash
# 1. Clone
git clone https://github.com/glayph/agent.git
cd agent

# 2. Install dependencies
npm install

# 3. Build everything
npm run build

# 4. Start Miki
npm start
```

Then open the dashboard in your browser (default gateway port **18800**, set with `GATEWAY_PORT`).

### 🧪 Developer mode

```bash
npm run dev            # hot-reload development
npm run verify         # full verification pass
npm run test:gateway   # gateway test suite
```

### 💬 Telegram, Discord, and Slack channels

The persistent gateway includes text adapters for Telegram Bot API long polling, Discord Gateway, and Slack Socket Mode. Channel credentials are encrypted in the workspace secret vault; configuration responses expose only whether a secret is set, not its value. Keep `config/data/secret-vault.key` and `config/data/secret-vault.json` together when moving or restoring the workspace. Runtime export includes both; treat the archive as highly sensitive.

Before enabling a channel, add the trusted sender's platform ID to `allow_from`. Incoming messages are ignored when the sender is not listed. The wildcard `*` permits any sender and should only be used intentionally.

- **Telegram:** configure the bot token. This adapter uses `getUpdates` long polling; Telegram does not allow polling while a webhook is configured. Disable an existing webhook before using this adapter.
- **Discord:** configure the bot token, enable the **Message Content Intent** in the Discord Developer Portal, and grant the bot permission to view and send messages in the target channels.
- **Slack:** configure both the bot token and an app-level token with the `connections:write` scope, enable Socket Mode, subscribe to the required message events, and grant the bot `chat:write` plus access to the channels it should read/reply in.

The dashboard marks a channel as live only while its adapter is connected. If it remains disconnected, inspect the channel probe/runtime error and verify network access, token scopes, platform intents, and the trusted sender list.

### 🤖 Local models

```bash
npm run model:list     # see the catalog
npm run model:install  # install a catalog model
npm run model:status   # check what is ready
npm run model:auto -- --start   # find, download, and register a public GGUF chat model

# Any other GGUF model
npm run model:install -- --url https://example.com/model.gguf --name my-model --start
npm run model:install -- --path /absolute/path/model.gguf --name my-model --start
```

### 🌙 Run 24/7

```bash
npm run runtime:24-7        # supervised, auto-restart runtime
npm run runtime:24-7:check  # health check
```

---

## 🌟 Highlights

- 🪄 **Plans before acting** — breaks big goals into steps and tracks progress.
- 🖱️ **Browses for you** — Playwright-powered browser with screenshots you can see in chat.
- 📂 **Works in a workspace** — reads and writes files safely, with approvals for risky changes.
- 🔁 **Recovers gracefully** — restart policies, graceful shutdown, and budget-aware continuation.
- 🧾 **Remembers the story** — old conversations are compacted and recalled, not dropped.

---

## 🛡️ Safety & privacy

- Miki runs **on your machine**; secrets, databases, and `.git` contents are never exposed through the media route.
- File writes and dangerous commands go through **approval** and policy checks.
- Memory is **owner-only** and never mixed with other users.

---

## 🧭 Roadmap

- [x] Global, cross-channel memory
- [x] Task-per-chat sessions
- [x] Visual proof attachments in chat
- [ ] Graph memory for very long histories (100k+ messages)
- [ ] Richer skill marketplace
- [ ] Windows and Linux one-click installers

---

## 🤝 Contributing

Pull requests are welcome! Please run `npm run verify` and `npm run test:gateway` before opening one. Keep changes small, tested, and well described.

---

<div align="center">

**Made with 💜 by glayph**

*Miki — remember everything, forget nothing.*

</div>

## Runtime data, encrypted secrets, and portable backups

Miki keeps its live runtime database in `data/miki-runtime.sqlite` (or the path selected by `MIKI_DATA_DIR`). This runtime data is deliberately excluded from source ZIPs and Git. Model API keys are stored in the encrypted secret vault under `config/data/secret-vault.json`; the key-file-backed vault also needs the paired `config/data/secret-vault.key`. If you move Miki to another folder or computer, preserve the runtime database and both vault files together. A vault file and its key must never be mixed with files from a different backup.

After signing in to the dashboard, download a portable runtime backup by opening `GET /api/runtime/export` in the same browser session. The ZIP contains a consistent SQLite snapshot and, when present, the vault and its key. Treat it as a credential-bearing archive: anyone who obtains a key-file-backed backup can decrypt the saved secrets, so do not commit it, share it, or upload it to public storage. If your vault uses `MIKI_VAULT_KEY` or `MIKI_SECRET_VAULT_KEY`, preserve that environment variable separately; it is intentionally not exported.

On startup, Miki reports when an existing runtime data directory or a key-file-backed vault appears incomplete. An empty data directory on a fresh installation is normal; an existing vault without its matching key is not. Restore from a verified backup before replacing or deleting the vault.

When upgrading an older installation that stored model API keys in SQLite, Miki creates a one-time, permission-restricted recovery copy under `data/backups/` before migrating those keys into the encrypted vault. That migration recovery copy contains the old database, including plaintext model keys, and therefore remains sensitive even though its file permissions are restricted. Keep it private; after verifying that all models still connect and that a separate secure backup exists, remove it according to your retention policy.

Factory Reset also creates a permission-restricted recovery JSON under `data/backups/`. That file can contain the previous `app_config`, including channel tokens. If stored web-search API keys exist, matching `secret-vault.json` and (when applicable) `secret-vault.key` recovery files are also created before those keys are removed. Treat every file from a Factory Reset as sensitive; restore a vault JSON and key only as a matching pair. Environment-variable keys are intentionally not changed by Factory Reset.
