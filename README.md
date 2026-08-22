# Agent Miki

**Agent Miki** is a local-first autonomous AI agent with a Node.js launcher, gateway, TypeScript core, React dashboard, provider/model management, memory, guarded tools, channels, runs, automations, and an execution Inspector. It is organized as a monorepo and requires Node.js 20 or newer.[1] [2]

> **Scope of this document:** The statements below are separated into **verified**, **available with configuration**, and **not verified** so that the README does not claim capabilities that were not demonstrated.

## Setup

Read the [complete setup guide](SETUP.md) before installing or operating Agent Miki. The documented source workflow is:

```bash
npm install
npm run build:all
npm start
```

The complete build includes the platform-specific llama.cpp server and may require CMake and a compatible C/C++ compiler when a reusable native artifact is unavailable.[2] For a conservative Linux build, use `MIKI_LLAMA_BUILD_JOBS=1 npm run build:all`.[2]

After startup, open the local dashboard address printed by the launcher. The verified local instance served the dashboard at `http://127.0.0.1:18800` and exposed a password setup/login flow.

## Verified in the Local Runtime

| Area | Observed behavior |
|---|---|
| **Dashboard and authentication** | The React dashboard served successfully. The first-run/login surface accepted the configured local password and opened the authenticated workspace. |
| **Chat surface** | The composer, model selector, running/ready state, context indicator, message actions, and provider-error display rendered. A successful cloud-model answer was not obtained in the tested environment because the provider credential request was rejected. |
| **Models and credentials** | The catalog returned 7 models, including Gemini and OpenAI entries. The dashboard exposed model selection and credential-management pages. |
| **Memory** | Selective memory search, region filters, reindex, chunk inspection, retrieval traces, postings, and graph-edge status rendered. |
| **Tools** | The authenticated API returned 50 tool entries. The catalog included filesystem, shell, browser, computer, model, runtime, workflow, web-search, and skill-discovery/install surfaces. |
| **Channels** | The channel catalog returned 15 entries. The Web channel page exposed enable, token, type, streaming, runtime probe, reset, and save controls. |
| **Drive** | The workspace and home-directory locations rendered with path, refresh, and file-action controls. |
| **Runs and automations** | Runs and Automation Center pages rendered with refresh/export/replay/manual-run, workflow, schedule, connection, and execution-history controls. The disposable workspace had no recorded runs or configured workflows. |
| **Config, Health, and Logs** | Configuration, health, and logs pages rendered. The command-pattern test correctly marked `rm -rf /tmp/demo` as blocked by the configured deny pattern. |
| **Inspector** | The Inspector opened from an assistant message, exposed Overview, Response, Thoughts, Work, Artifacts, Evidence, and Events, and its expand/shrink and close controls worked. |

## Plugins and Skills

### Online discovery and installation

The implementation exposes skill search, marketplace installation, manual Markdown/ZIP import, installed-skill metadata, readiness reporting, and workspace-skill deletion routes.[3] A live authenticated search for `github` returned 5 `skills.sh` results, all marked `installed: false`. This verifies online discovery, not that an online skill was installed.

Marketplace installation is implemented through an external skills CLI and then copies the result into the workspace while recording marketplace metadata.[3] Because this acquires third-party code, no online skill was installed during the audit. Manual import accepts a Markdown file or a ZIP containing `SKILL.md`, rejects oversized files and unsafe archive paths, and stores imported content in an isolated downloaded-skills area.[3]

### Plugin creation boundary

No dedicated plugin-authoring or plugin-generator route was found in the inspected core/launcher source. The existing implementation can **discover, install, import, load, and audit** skills/plugins, but a natural-language plugin creator is **not verified and is not advertised as a built-in feature**. Generic file-writing tools must not be confused with a supported plugin-authoring workflow.

## MCP

MCP is implemented as an authenticated in-process server with tools, resources, prompts, discovery, session handling, and external connector configuration.[4] The MCP configuration schema supports stdio and HTTP/SSE servers, discovery TTL and result limits, BM25/regex search, and validation rules. Enabled stdio servers require a command; HTTP/SSE servers require a valid HTTP(S) URL without embedded credentials; discovery requires at least one search method; and unsafe environment keys such as `NODE_OPTIONS` are rejected.[5]

An authenticated disposable MCP session was verified after the internal core-client authentication path was corrected. The session completed initialize with HTTP 200, `notifications/initialized` with HTTP 202, `tools/list` with HTTP 200 and 47 tools, `resources/list` with HTTP 200, and `prompts/list` with HTTP 200. A read-only `tool_search_tool_bm25` call returned a health-related tool match. No external MCP server was configured or executed in this audit.

MCP therefore **can expose and discover Agent tools when explicitly enabled and authenticated**. The audit did not prove that an arbitrary remote MCP server is safe or that every MCP-triggered operation inherits the same remote-origin restrictions as an HTTP chat request. External MCP servers must be treated as untrusted code and configured only with validated, least-privilege settings.

## Telegram, Web UI, and Remote Settings Control

The Telegram adapter is implemented and routes accepted text messages into the normal Agent orchestrator. It supports typing indicators, optional placeholder messages, collected or streamed replies, reconnect behavior, and sender/chat allow-lists.[6] It requires an enabled Telegram channel and a valid bot token; bot messages and slash commands are ignored. A live Telegram delivery was not performed because no approved bot token and test identity were available.

The Web UI exposes authenticated settings and control APIs for configuration read/validate/update/reset, tool enable/disable, channel configuration/probes, runtime reload/restart, skills, models, memory, runs, automations, health, and logs.[3] This proves that those control surfaces exist; it does **not** prove that a free-form chat sentence can safely perform every corresponding mutation.

| Request source | Verified control boundary |
|---|---|
| **Authenticated Web UI/API** | Can reach the implemented configuration and control surfaces, subject to validation, authentication, runtime-apply behavior, and tool permissions. |
| **Telegram** | Can deliver accepted text to the Agent orchestrator when configured. Direct natural-language control of every setting was not verified. |
| **Authenticated MCP** | Can list/call exposed tools and read exposed resources/prompts when MCP is enabled. External-server execution was not tested. |
| **Remote shell or destructive actions** | Not unrestricted. Shell execution can be disabled, blocked for remote callers, filtered by allow/deny patterns, limited by timeout/output, and restricted to the active workspace.[7] |

The current code establishes local/remote call origin for HTTP chat and direct HTTP tool-call routes. The source explicitly notes that Telegram and MCP in-process calls do not yet establish that per-request origin context. Consequently, Agent Miki should **not** be described as able to control every setting or run unrestricted commands from Telegram or MCP.

## Inspector

The Inspector opens from **Inspect agent** on an assistant message. Its verified pages are:

| Page | Observed purpose |
|---|---|
| **Overview** | Message count, live-node count, selected message, and recent activity. |
| **Response** | Short human-facing answer separate from detailed execution information. |
| **Thoughts** | Concise categorized execution summaries; private hidden chain-of-thought is not shown. |
| **Work** | Execution nodes and tool-call summaries when available. |
| **Artifacts** | Generated files and attachments when available. |
| **Evidence** | Checkpoints and verifier evidence when available. |
| **Events** | Timestamped realtime summaries and execution/error events. |

## Verification Record

| Check | Result |
|---|---|
| Workspace tests | Passed. The frontend reported **13 test files and 52 tests passed**; memory integration/selective-memory tests also passed. |
| Workspace builds | Config, installer, skills, memory, core, gateway, and frontend builds passed during the audit. |
| Backend lint | Passed with `--max-warnings=0` for the documented backend scope. |
| Launcher doctor | Exit 0 with `WARN`: Node/npm, configuration, data, SQLite, secret vault, provider audit, and migrations were available; Go and native runtime artifacts were incomplete in the sandbox. |
| 24/7 readiness | Passed with `ok: true` and a valid gateway entrypoint.[8] |
| Gateway | `/health` returned HTTP 200. |
| Skill discovery | Passed: 5 online `skills.sh` results returned; no online installation was performed. |
| MCP | Passed after the internal authentication fix: initialize, tools/list, resources/list, prompts/list, and read-only discovery call all returned successful protocol responses. |
| Telegram | Adapter support verified from source; live delivery not tested because no approved bot token/test identity was available. |
| Provider response | Not passed in the available provider setup: Gemini returned a credential rejection/HTTP 401 in the previous live test. |
| Full `npm run verify` | Not completed within the bounded test window; it reached the test phase before timing out. |

## Runtime and Security Boundaries

Agent Miki’s actual capabilities depend on configuration, provider credentials, enabled tools, channel allow-lists, MCP server definitions, and the active workspace. The test workspace had zero installed skills, zero configured external MCP servers, zero recorded agent runs, zero configured automations, no generated artifacts, and no verifier checkpoints.

Keep API keys, Telegram bot tokens, MCP secrets, local databases, runtime logs, compiled executables, private keys, downloaded skills, and model files out of Git. Use the dashboard vault or deployment environment for credentials.[2]

## References

[1]: package.json "Agent Miki package manifest and supported commands"

[2]: SETUP.md "Agent Miki complete setup guide"

[3]: packages/core/src/api/launcher-compat.ts "Launcher control, skill, tool, channel, and configuration APIs"

[4]: packages/core/src/mcp/server.ts "MCP server registration, discovery, and tool execution"

[5]: packages/config/src/schema.ts "MCP configuration and safety validation"

[6]: packages/core/src/channels/telegram.ts "Telegram channel configuration and Agent routing"

[7]: packages/core/src/tools/executor/shell.ts "Shell execution permissions and remote/workspace guardrails"

[8]: scripts/miki-24-7.mjs "24/7 runtime readiness check"
