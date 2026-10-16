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
