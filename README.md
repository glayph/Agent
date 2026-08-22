# Agent Miki

**Agent Miki** is a local-first autonomous AI agent with a Node.js launcher, a gateway, a TypeScript agent core, a React dashboard, provider/model management, memory services, guarded tools, channels, runs, automations, and an execution Inspector. The repository is organized as a monorepo and requires Node.js 20 or newer.[1] [2]

> **Verification status:** The dashboard, authentication flow, gateway health, workspace tests, workspace builds, route surfaces, memory dashboard, tool catalog, and Inspector were verified locally. A successful cloud-model response was **not** confirmed in this test environment: Gemini returned HTTP 401, and the independent OpenAI-model attempt surfaced an OpenRouter credential error. These results are recorded as observed behavior, not assumptions.

## Start Here

Read the [complete setup guide](SETUP.md) before installing or operating Agent Miki. The normal source workflow is:

```bash
npm install
npm run build:all
npm start
```

The complete build includes the platform-specific llama.cpp server and therefore requires CMake and a compatible C/C++ compiler when a reusable native artifact is not already available.[2] For a conservative Linux build, use `MIKI_LLAMA_BUILD_JOBS=1 npm run build:all`.[2]

After startup, open the local dashboard address printed by the launcher. The verified sandbox instance served the dashboard at `http://127.0.0.1:18800` and exposed a local password setup/login flow.

## What Is Present

| Area | Verified behavior or available surface |
|---|---|
| **Dashboard** | React dashboard served by the Node gateway. |
| **Authentication** | First-run password setup followed by a password-protected login page. |
| **Chat** | Composer, model selector, running/ready status, context indicator, message actions, and provider error display. |
| **Models** | Google Gemini models, OpenAI models, and OpenRouter entries were visible in the tested catalog. Models can be selected as the default and credentials can be managed from the dashboard. |
| **Credentials** | OpenAI and Google Antigravity credential surfaces were available. The supplied Gemini key could be saved and displayed as connected, but the live request still returned a provider rejection. |
| **Memory** | Selective memory search, region filters, reindex, chunk inspection, retrieval traces, postings, and graph-edge status. |
| **Tools** | Tool Library with enabled/disabled switches and risk labels. The Health report recorded 46 registered tool handlers, including filesystem, shell, browser, computer, model, runtime, workflow, and skill-discovery tools. |
| **Channels** | Web channel configuration with enable, token, type, streaming-output, runtime-probe, reset, and save controls. |
| **Drive** | Workspace and home-directory locations with path, refresh, and file actions. |
| **Runs** | Run history surface with refresh, export, replay, and manual-run controls. No runs were recorded in the isolated test workspace. |
| **Automations** | Workflow overview, creation, schedules, connections, execution history, and linked-run navigation. No workflows were configured in the isolated test workspace. |
| **Config** | Launcher, workspace, runtime, heartbeat, evolution, MCP, command safety, scheduling, device, and factory-reset controls. |
| **Health and Logs** | Health diagnostics, doctor checks, backups, secret scan, watchdog state, queues, and a gateway log view. |
| **Hub and Skills** | Skill discovery/search and installed-skill management surfaces. The isolated test workspace had no installed skills. |

## Agent Inspector

The Inspector opens from the **Inspect agent** action on an assistant message. The verified implementation provides seven pages:[4] [5]

| Inspector page | Verified purpose |
|---|---|
| **Overview** | Message count, live-node count, selected message, and recent activity. |
| **Response** | Short human-facing responses, separate from detailed execution information. |
| **Thoughts** | Concise categorized execution summaries; the UI explicitly states that private hidden chain-of-thought is not shown. |
| **Work** | Execution nodes and tool-call summaries when available. |
| **Artifacts** | Generated files and message attachments when available. |
| **Evidence** | Checkpoints, inputs, outputs, attempts, and verifier evidence when available. |
| **Events** | Realtime thought summaries and execution events with timestamps, status, and error/output previews. |

The Inspector also supports live/session-snapshot status, Previous/Next page navigation, expand/shrink, close, message selection, and concise redacted internal details. In the failed provider test, Events showed the Gemini HTTP 401 event while Work, Artifacts, and Evidence correctly displayed empty states because no tool work or file output was produced.

## Verification Performed

The following checks were run against the updated checkout. The application was not described as fully operational where the observed result contained a warning or provider failure.

| Check | Observed result |
|---|---|
| Workspace tests | Passed. Memory test suites completed successfully; the frontend reported **13 test files and 52 tests passed**. |
| Workspace builds | Passed for config, installer, skills, memory, core, and gateway after stale ignored `.tsbuildinfo` files were removed. The frontend build also passed. |
| Backend ESLint | Passed with `--max-warnings=0` for the documented backend scope. |
| Launcher doctor | Process exited 0 with status **WARN**. Node/npm, config, data, SQLite, secret vault, provider audit, and migration checks were OK; Go was unavailable and native runtime artifacts were incomplete. |
| 24/7 readiness | `npm run runtime:24-7:check` exited 0 and reported `ok: true` with a valid gateway entrypoint.[6] |
| Gateway | `/health` returned HTTP 200 and the dashboard served successfully. |
| Chat response | **Not passed.** Gemini produced `The gemini credential was missing or rejected` and the event stream recorded HTTP 401. The OpenAI-model attempt displayed an OpenRouter credential error. |
| Inspector | Passed for opening, all seven pages, event inspection, expand/shrink, and close. |
| Full `npm run verify` | Not completed within the bounded test window. It reached the frontend build and entered the test phase before timing out; the individual workspace tests and builds were run separately and recorded above. |

## Runtime Boundaries

Agent Miki can expose the interfaces listed above, but the tested workspace does not contain a successful provider completion, installed skills, recorded agent runs, configured automations, generated artifacts, or verifier checkpoints. A local model also requires a compatible GGUF file and a platform-native llama.cpp build; model files are not included in the repository.[2]

Credentials must remain in the dashboard vault or deployment environment. API keys, local databases, runtime logs, compiled executables, private keys, and model files should not be committed to Git.[2]

## References

[1]: package.json "Agent Miki package manifest and supported commands"

[2]: SETUP.md "Agent Miki complete setup guide"

[3]: scripts/run-verify.mjs "Repository verification workflow"

[4]: packages/ui/frontend/src/features/chat/components/chat-inspector.tsx "Chat Inspector implementation"

[5]: packages/ui/frontend/src/features/chat/components/message-action-bar.tsx "Message action bar and Inspect agent action"

[6]: scripts/miki-24-7.mjs "24/7 runtime readiness and supervisor implementation"
