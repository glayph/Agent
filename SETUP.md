# Agent Miki — Complete Setup Guide

**Version:** 1.3.6
**Project type:** Local-first autonomous AI agent  
**Audience:** Users installing Agent Miki from a clean Linux or Windows machine  
**Author:** Manus AI

> This guide describes the complete Agent Miki runtime: the React dashboard, Node.js gateway, TypeScript core, vendored headless llama.cpp executable flow, separately configured local GGUF models, cloud/API providers, memory services, and the optional Go terminal interface.

## 1. What is included

Agent Miki is a monorepo. The main `npm start` command launches the Node launcher, which starts the gateway and its managed core runtime. The dashboard is served by the gateway. When a local model is selected and configured for automatic startup, Agent Miki starts the included platform-specific `llama-server` executable against the separately configured GGUF path; no answer-model GGUF is included in the release. When a cloud/API model is selected, the local llama-server process is not needed for that request path.

The repository keeps the complete llama.cpp source under `packages/core/src/llm/local/vendor/llama.cpp/`. The project build compiles only the headless server component and disables the upstream web UI before copying the resulting executable into the local runtime area. Agent Miki's own dashboard is the user interface for model management and chat.

| Component             | Location                                        | Purpose                                                                                          |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Node launcher         | `bin/miki.js`                                   | Starts Miki, delegates setup/doctor commands, and manages child processes.                       |
| Gateway               | `packages/gateway/`                             | Serves the dashboard, API, authentication, WebSocket connection, and runtime controls.           |
| Core agent            | `packages/core/`                                | Agent orchestration, providers, tools, channels, safety, memory bridge, and local LLM lifecycle. |
| Local LLM integration | `packages/core/src/llm/local/`                  | Local provider code, executable locations, metadata, and vendored llama.cpp source.              |
| llama.cpp source      | `packages/core/src/llm/local/vendor/llama.cpp/` | Vendored upstream source used to build `llama-server`.                                           |
| Frontend              | `packages/ui/frontend/`                         | React dashboard and chat interface.                                                              |
| Memory package        | `packages/memory/`                              | Memory service and persistence support.                                                          |
| Go CLI                | `packages/cli/`                                 | Optional native terminal interface and managed runtime controls.                                 |
| Runtime data          | `data/`                                         | Workspace databases, audit data, memory data, logs, backups, and runtime state.                  |

## 2. Requirements

A clean installation requires a supported Node.js runtime, npm, Git, a C/C++ build toolchain for platforms where a bundled llama.cpp binary is not already available, and Go only if the Go terminal interface is required. The root package requires Node.js 20 or newer; the CLI package declares support for Node.js `^20.19.0 || ^22.13.0 || >=24`. Go tests and the native terminal interface require Go 1.25 or newer as declared by `packages/cli/go.mod`.

| Requirement               | Linux                                                         | Windows                                                        | Required for                            |
| ------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------- |
| Git                       | Recommended                                                   | Recommended                                                    | Cloning and updating the repository.    |
| Node.js                   | 20+                                                           | 20+                                                            | All Agent Miki commands.                |
| npm                       | Bundled with Node.js                                          | Bundled with Node.js                                           | Dependency installation and scripts.    |
| CMake                     | Required when `npm run build:llama` must compile llama.cpp    | Required when Windows llama.cpp must be compiled locally       | Building the vendored llama.cpp server. |
| C/C++ compiler            | GCC/G++ or Clang                                              | Visual Studio Build Tools or another CMake-compatible compiler | llama.cpp compilation.                  |
| Go                        | 1.25+                                                         | 1.25+                                                          | Go CLI build/test/use.                  |
| GGUF model                | Only for local-model use                                      | Only for local-model use                                       | Running a local model.                  |
| Cloud API key             | Only for cloud-model use                                      | Only for cloud-model use                                       | Using a remote provider.                |
| Whisper.cpp runtime/model | Optional for voice transcription; official native build/model | Optional for voice transcription; official native build/model  | Browser microphone/audio transcription. |
| FFmpeg                    | Optional; needed by whisper-server `--convert` for WebM/M4A   | Optional; needed by whisper-server `--convert` for WebM/M4A    | Browser-recorded formats beyond WAV.    |

Official installation references are listed at the end of this guide: Node.js [1], CMake [2], Go [3], Git [4], and llama.cpp [5].

## 3. Linux installation

### 3.1 Install system prerequisites on Ubuntu/Debian

Run the following commands in a terminal. The repository can also be installed on other Linux distributions, but the package names for CMake, Git, and the compiler may differ.

```bash
sudo apt update
sudo apt install -y git curl ca-certificates build-essential cmake pkg-config
```

Install Node.js 20 or a newer supported release. Using a version manager is recommended when the machine contains multiple Node projects. After installation, verify the runtime:

```bash
node --version
npm --version
cmake --version
git --version
```

If you intend to use the Go CLI, install Go 1.25 or newer using the official Go distribution for your Linux architecture, then verify:

```bash
go version
```

### 3.2 Obtain the source

Clone the repository and enter its directory:

```bash
git clone <YOUR_GITHUB_REPOSITORY_URL> "Agent Miki"
cd "Agent Miki"
```

If the source was delivered as a ZIP, extract it and enter the extracted directory instead:

```bash
unzip AgentMiki-github-source-final.zip
cd "Agent Miki"
```

### 3.3 Install JavaScript dependencies

Install all root and workspace dependencies with npm:

```bash
npm install
```

The project uses npm workspaces defined in the root `package.json`. Do not run `npm install` inside every package unless you are debugging a package in isolation; the root install is the normal setup path.

### 3.4 Build Agent Miki and llama.cpp together

The standard complete build is:

```bash
MIKI_LLAMA_BUILD_JOBS=1 npm run build:all
```

`npm run build:all` first runs the llama.cpp build orchestration and then builds the configuration, installer, skills, memory, core, and gateway workspaces. `MIKI_LLAMA_BUILD_JOBS=1` is conservative for machines with limited RAM. On a stronger machine, the variable may be increased, for example:

```bash
MIKI_LLAMA_BUILD_JOBS=4 npm run build:all
```

The llama.cpp build script uses the vendored source and applies these important build choices:

| Build setting           | Value | Meaning                                                                        |
| ----------------------- | ----: | ------------------------------------------------------------------------------ |
| `LLAMA_BUILD_SERVER`    |  `ON` | Build the `llama-server` executable.                                           |
| `LLAMA_BUILD_UI`        | `OFF` | Do not build llama.cpp's separate web UI.                                      |
| `LLAMA_USE_PREBUILT_UI` | `OFF` | Do not package the upstream prebuilt UI.                                       |
| `LLAMA_BUILD_TESTS`     | `OFF` | Omit llama.cpp tests from the application artifact.                            |
| `LLAMA_BUILD_EXAMPLES`  | `OFF` | Omit upstream examples.                                                        |
| `LLAMA_BUILD_TOOLS`     |  `ON` | Keep the tools needed by the project build.                                    |
| `LLAMA_BUILD_APP`       | `OFF` | Do not build the upstream standalone app.                                      |
| `LLAMA_OPENSSL`         | `OFF` | Keep this embedded server build independent of OpenSSL.                        |
| `GGML_NATIVE`           | `OFF` | Produce a more portable CPU artifact rather than a host-specific native build. |

The compiled executable is copied into `packages/core/src/llm/local/native/<platform>-<architecture>/` and into the core distribution during the build. Do not move the vendored llama.cpp source outside `packages/core/src/llm/local/`.

### 3.5 Start Agent Miki

For the normal dashboard runtime:

```bash
npm start
```

For development with the project development launcher:

```bash
npm run dev
```

The gateway normally binds to loopback. Open the address printed by the process, commonly:

```text
http://127.0.0.1:18800
```

The first visit opens the setup/login flow. Choose a dashboard password and keep it safe. The password is local dashboard authentication; it is not a cloud-provider API key.

The shortest complete Linux sequence is therefore:

```bash
git clone <YOUR_GITHUB_REPOSITORY_URL> "Agent Miki"
cd "Agent Miki"
npm install
MIKI_LLAMA_BUILD_JOBS=1 npm run build:all
npm start
```

## 4. Windows installation

### 4.1 Install prerequisites

Install the current supported Node.js release from the official Node.js website and ensure that the installer adds `node` and `npm` to `PATH`. Install Git for Windows if the source will be cloned. Install CMake and a C/C++ compiler for the local llama.cpp build.

A practical Windows toolchain is Visual Studio Build Tools with the **Desktop development with C++** workload, together with CMake. The CMake installer must add `cmake` to `PATH`, or CMake must be invoked from a Visual Studio Developer PowerShell where the compiler environment is already configured.

Verify from PowerShell:

```powershell
node --version
npm --version
cmake --version
git --version
```

If the Go terminal interface is required, install Go 1.25 or newer and verify:

```powershell
go version
```

### 4.2 Obtain and install the source

Clone the repository:

```powershell
git clone <YOUR_GITHUB_REPOSITORY_URL> "Agent Miki"
Set-Location "Agent Miki"
```

For a ZIP delivery, extract it with File Explorer or PowerShell:

```powershell
Expand-Archive .\AgentMiki-github-source-final.zip -DestinationPath .
Set-Location ".\Agent Miki"
```

Install dependencies:

```powershell
npm install
```

### 4.3 Build on Windows

Run the complete build from PowerShell:

```powershell
$env:MIKI_LLAMA_BUILD_JOBS="1"
npm run build:all
```

The build script automatically selects `llama-server.exe` on Windows and uses CMake to configure the vendored source under `packages\core\src\llm\local\vendor\llama.cpp\`. If CMake cannot find a compiler, open a **Developer PowerShell for Visual Studio** and rerun the build. If the build was interrupted, rerun the same command; the script reuses an existing compatible artifact unless `MIKI_LLAMA_FORCE_REBUILD=1` is set.

To force a fresh llama.cpp compilation:

```powershell
$env:MIKI_LLAMA_FORCE_REBUILD="1"
$env:MIKI_LLAMA_BUILD_JOBS="1"
npm run build:llama
npm run build:all
```

### 4.4 Start on Windows

Start the dashboard runtime:

```powershell
npm start
```

Or start the development launcher:

```powershell
npm run dev
```

Open the printed local address, normally `http://127.0.0.1:18800`. Windows Firewall may ask whether Node.js can access the network. For a local-only installation, allow the private/local network profile only when prompted, and do not expose the dashboard to the public internet without separately securing the deployment.

The shortest complete Windows sequence is:

```powershell
git clone <YOUR_GITHUB_REPOSITORY_URL> "Agent Miki"
Set-Location "Agent Miki"
npm install
$env:MIKI_LLAMA_BUILD_JOBS="1"
npm run build:all
npm start
```

## 5. llama.cpp integration and local models

### 5.1 How the integration works

The project does not require a separately installed global `llama-server` for the normal source build. The source is already vendored in the repository, the build script compiles the headless server, and the local provider knows where the platform artifact is located. The upstream llama.cpp web UI is deliberately disabled because Agent Miki uses its own dashboard.

The local model must be a GGUF file supported by the llama.cpp build. The model file itself is not included in the source ZIP because model files are large and model licensing varies. Store the model outside the Git repository, for example:

```text
Linux:   /models/Miki-7B-Instruct.Q4_K_M.gguf
Windows: C:\Models\Miki-7B-Instruct.Q4_K_M.gguf
```

A small model is recommended for the first smoke test. The required RAM, response speed, context length, and quantization compatibility depend on the selected model and host hardware; if the server is killed by the operating system, use a smaller quantization or model. The default local context is 16,384 tokens so the full Agent Miki system prompt fits. Explicit per-model `context_size` values override this default, but values below 12,000 tokens may not fit long tool workflows. The Models page warns when a model looks like a 300M/350M-class smoke-test model or has a low context budget; use a larger instruction-tuned, tool-capable GGUF model for file-producing work.

### 5.2 Add a local model in the dashboard

After `npm start` is running:

1. Open the dashboard and sign in.
2. Open **Models**.
3. Choose **Add Model**.
4. Select the local/llama.cpp provider option.
5. Enter the absolute path to the `.gguf` model file.
6. Leave the API key empty for a local model.
7. Keep automatic llama-server startup enabled if the model should start automatically when selected.
8. Save the model and select it as the default model.
9. Return to Chat and send a short prompt.

The local model form may also accept an explicit executable path. Normally this should be left empty so Agent Miki uses the included llama-server executable. The model file itself is always supplied separately. Use an explicit path only when intentionally connecting to a compatible `llama-server` executable or an existing loopback OpenAI-compatible local endpoint. Changes to context size, threads, batching, GPU layers, mmap, mlock, or flash attention invalidate the managed runtime fingerprint; Agent Miki restarts the managed server automatically before the next request.

### 5.3 Switching between cloud and local models

The intended runtime behavior is:

| Selected default model                | llama-server behavior                                                                                               | API key behavior                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Cloud/API model                       | Local llama-server is not required for the selected request path.                                                   | The selected provider key must be configured and valid.               |
| Local llama.cpp model                 | Agent Miki starts the local llama-server automatically when the model is selected/configured for automatic startup. | No cloud API key is required.                                         |
| Local model with an existing endpoint | Agent Miki uses the configured loopback-compatible endpoint according to the model configuration.                   | No cloud API key is required unless the endpoint itself requires one. |

After changing the default model, wait for the model status to settle before sending a message. If the local model cannot start, inspect the **Logs** and **Health** pages first. The user-facing Chat response should remain concise, while runtime details are available in the Inspector/log surfaces.

### 5.4 Local model diagnostics

Run these checks from the project root:

```bash
npm run build:llama
npm run build:all
npm run verify
npm start
```

On Windows, use the same commands in PowerShell. If a local artifact already exists but you suspect it is stale:

```bash
# Linux/macOS
MIKI_LLAMA_FORCE_REBUILD=1 MIKI_LLAMA_BUILD_JOBS=1 npm run build:llama

# Windows PowerShell
$env:MIKI_LLAMA_FORCE_REBUILD="1"
$env:MIKI_LLAMA_BUILD_JOBS="1"
npm run build:llama
```

Do not delete the vendored source to fix a build problem. Confirm that `packages/core/src/llm/local/vendor/llama.cpp/` exists, confirm that CMake and the compiler are available, and read the first compiler error rather than only the final CMake summary.

## 6. Dual-mode web-search setup

Web search is independent from the model used to write the final answer. In **Local** mode, Miki performs retrieval from the machine running the Agent using the native DuckDuckGo adapter and falls back to public Bing HTML if the native endpoint is unavailable. You can also point Local mode at a private SearXNG instance by selecting `searxng` and entering its base URL. In **API / Cloud** mode, Miki calls an enabled search API provider. In **Auto** mode, Miki tries Local first and uses an enabled API provider only when the local path returns no results. Sensitive credential-like queries are blocked from cloud fallback.

Open **Tools → Web Search** in the dashboard and choose the execution mode. The default is Local. Enable the provider you want before choosing API / Cloud or Auto. API keys are entered through the secret-aware provider field and are stored in the workspace vault; they are not returned by the settings API or included in search results. Each successful search returns normalized results and numbered citations with the title and URL.

| Mode        | Retrieval path                                                            | Requires a search API key | Internet behavior                                         |
| ----------- | ------------------------------------------------------------------------- | ------------------------: | --------------------------------------------------------- |
| Local       | Native DuckDuckGo, public Bing HTML fallback, or configured local SearXNG |                        No | The Miki host makes the web request.                      |
| API / Cloud | Enabled Brave, Tavily, SerpAPI, Serper, or Bing adapter                   |                       Yes | The query is sent to the selected API provider.           |
| Auto        | Local first, API fallback if permitted                                    |         Only for fallback | Sensitive credential-like queries never use API fallback. |

The active answer model is configured separately under **Models**. A local llama.cpp/Ollama model can synthesize the returned citations without using a cloud model; a cloud/API model can also synthesize them when selected. This gives two independent choices: **where Miki retrieves web data** and **where Miki generates the final answer**. Miki normally searches only when the request requires current or externally verifiable information. The default Balanced resource profile permits at most two `web_search` calls per turn; Eco permits one and Performance permits three. Set `agent.resource.web_search_max_calls_per_turn` from 1 to 5 only when a workflow genuinely needs more search steps. If no final synthesis is returned, Miki provides a source-lead summary explicitly marked as unverified.

For faster, lower-context Local search, use the **Local Search Performance** controls on the same dashboard page. `Reuse Recent Results` caches only non-sensitive searches, `Cache Lifetime (minutes)` controls freshness, and `Snippet Character Limit` controls how much text is sent to the answer model. The shipped defaults are caching enabled, 5 minutes, and 420 characters. Provider **Max Results** should normally remain at 5 or below. Search output is compact JSON, removes tracking URL duplicates, and retains citations even when snippets are shortened. A practical breaking-news profile is 1–3 minutes of cache lifetime and 3–5 results; a documentation profile can use 15–60 minutes.

### API provider credentials

Cloud providers require credentials supplied through the dashboard or through the runtime environment used by the deployment. Never commit an API key, place it in this guide, or include it in a source ZIP. Use the dashboard's Tools → Web Search secret-aware fields where available, or configure the documented environment variable in the deployment environment.

Common environment variables used by the project include the following. The exact provider/model name must match the model catalog entry selected in the dashboard.

| Variable             | Use                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`     | OpenAI-compatible provider credential.                                                        |
| `GEMINI_API_KEY`     | Google/Gemini-compatible provider credential where supported by the configured provider path. |
| `GROQ_API_KEY`       | Groq-compatible provider credential where supported.                                          |
| `ANTHROPIC_API_KEY`  | Anthropic-compatible provider credential where supported.                                     |
| `OPENROUTER_API_KEY` | OpenRouter-compatible provider credential where supported.                                    |
| `GATEWAY_HOST`       | Gateway bind host.                                                                            |
| `GATEWAY_PORT`       | Gateway port.                                                                                 |
| `MIKI_WORKSPACE_DIR` | Directory for runtime data, configuration, and logs.                                          |

A provider test returning HTTP 401 or a message that credentials were rejected means the application reached the provider path but the credential was missing, invalid, expired, or incompatible. Do not interpret `available: true` in a model catalog as proof that a completion will succeed; run the model test and then a short Chat smoke test.

### Conversational chat and Inspector details

Normal Chat is designed to read like a person-to-person conversation. Each assistant bubble shows only a short answer preview. To read the complete answer, explanation, source details, tool activity, report, or verification, click that bubble’s **Inspector** action and open the Inspector menu. Full details are not expanded inside the normal chat bubble.

The Inspector’s **Response** page shows the complete answer, while **Thoughts**, **Work**, **Artifacts**, **Evidence**, and **Events** show their respective runtime details. It does not display private hidden chain-of-thought. Thought and hidden tool-feedback events are linked to the matching assistant response through `run_id`, so details remain attached to the correct chat bubble. This behavior is independent of whether the selected answer model is local or cloud-based.

### Voice messages with whisper.cpp

The Chat composer includes a microphone recorder and an **Upload audio** fallback. The browser sends one bounded recording to `POST /api/voice/transcribe`; the Node core validates the multipart body, invokes the configured official `whisper.cpp` server or CLI, deletes any temporary CLI audio directory, and sends the resulting transcript through the same WebSocket `message.send` and `runAgentLoop` path used by normal text. Therefore, the response model can be either the configured local llama.cpp/Ollama model or a cloud/API model; transcription and answer generation are separate choices.

Voice transcription is disabled until an operator installs whisper.cpp and configures a runtime. The checked-in `config/agent.yaml` contains the safe defaults. For repeated microphone messages, build the official project and run `whisper-server` locally with a small model, then use an endpoint configuration:

```yaml
speech_to_text:
  enabled: true
  provider: whisper.cpp
  endpoint: http://127.0.0.1:8080
  language: auto
  max_audio_seconds: 300
  max_file_mb: 25
  timeout_ms: 120000
  concurrency: 1
  retain_audio: false
```

You can also manage multiple speech models from **Models → Speech-to-Text Models**. Select **Add audio model**, give the record an ID and display name, choose **Local whisper-cli** or **Whisper server endpoint**, enter the corresponding executable/model paths or HTTP(S) endpoint, and save it. The first saved model becomes active automatically; use the model row’s activate action to switch models later. The section also supports editing, deleting, enabling/disabling individual records, and turning transcription on or off globally. These settings are persisted under `speech_to_text.models` and `speech_to_text.active_model_id` in `config/agent.yaml`.

On Linux, the official source workflow is `git clone https://github.com/ggml-org/whisper.cpp.git`, `cmake -B build`, and `cmake --build build -j --config Release`. Download an official GGML model with the upstream `models/download-ggml-model.sh` script, then start the server with `./build/bin/whisper-server --host 127.0.0.1 --port 8080 --model /absolute/path/to/ggml-base.bin --convert` when accepting browser formats such as WebM; `--convert` requires FFmpeg. On Windows, use the official repository with Visual Studio Build Tools/CMake, run the equivalent CMake Release build, and start `build\\bin\\Release\\whisper-server.exe` on loopback with the same model and `--convert` options. Agent Miki does not silently download, install, or execute the native runtime or model.

The direct CLI alternative requires both `executable` and `model` paths and is useful for controlled WAV input. If the runtime is not configured, the UI shows the returned actionable error rather than uploading audio to a cloud transcription service. The backend enforces the configured file-size, timeout, and concurrency bounds; `retain_audio: false` is enforced in the current implementation. Inspector’s **Voice** page shows transcript, language, provider, duration, latency, and transport; raw audio, file paths, credentials, and private hidden chain-of-thought are not shown. The current implementation is a Web UI microphone/upload path; Telegram voice-file ingestion and optional spoken TTS replies are not claimed as implemented.

### Search-necessity smoke test

After configuring a model, use two separate chat turns. Ask a current-information question such as `what is the GTA 6 NEW LEAKS INFO?` and confirm in the Inspector that `web_search` runs and the answer contains source links or a clearly marked source-lead fallback. Then ask a stable question such as `What is 2+2? Answer in one sentence.` and confirm that Miki answers without a `web_search` event. Search-result snippets are evidence leads; confirm important claims by opening and cross-checking the cited sources.

## 7. Provider-plugin setup

Agent Miki exposes a stable provider-plugin SDK under `packages/core/src/llm/provider/sdk/`. Built-in plugins are registered automatically for Gemini, OpenAI, OpenRouter, Claude, Ollama, llama.cpp, and the optional OmniRoute loopback gateway. The Models page shows each provider’s plugin ID, version, source, capabilities, and readiness state.

The provider manifest filename is `miki.provider.json`. External manifests may be placed under an approved provider directory for discovery, but external entrypoints are metadata-only by default. Direct in-process loading is disabled. To execute an external provider, an operator must explicitly enable the bounded runtime-contract policy and approve only the required permissions. See [`docs/provider-plugin-architecture.md`](docs/provider-plugin-architecture.md), [`docs/provider-plugin-authoring.md`](docs/provider-plugin-authoring.md), and [`docs/provider-plugin-security.md`](docs/provider-plugin-security.md).

OmniRoute is an optional local provider. Configure a model such as `omniroute/auto` or use the provider selector in **Models**. Its default endpoint is `http://127.0.0.1:20128/v1`, and its optional placeholder key is `MIKI_OMNIROUTE_API_KEY`. Agent Miki does not install, bundle, or auto-start OmniRoute. If OmniRoute is not running, the dashboard should report an unavailable local endpoint rather than silently switching to another provider.

When adding a provider, keep credentials in the dashboard secret vault or deployment environment, keep provider-specific imports inside the adapter, and run the complete test and release-scanning workflow before distributing an archive.

## 8. Dashboard setup and first-run checklist

Start Agent Miki, open the local URL, and complete the dashboard setup. Then use this order for the first verification:

| Step | Action                                                                              | Expected result                                                                     |
| ---: | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
|    1 | Open the dashboard URL.                                                             | Setup or login page appears.                                                        |
|    2 | Sign in with the local dashboard password.                                          | Agent Workspace opens.                                                              |
|    3 | Open **Health**.                                                                    | Doctor checks and runtime status render.                                            |
|    4 | Open **Models**.                                                                    | Model catalog and credential controls render.                                       |
|    5 | Configure one cloud or local model.                                                 | The model can be selected and tested.                                               |
|    6 | Open **Chat**.                                                                      | Composer and Inspector entry point render.                                          |
|    7 | Send `Reply with exactly: runtime smoke test`.                                      | The run enters Running and completes or shows a specific actionable provider error. |
|    8 | Open **Logs**.                                                                      | Current gateway/core log lines are visible.                                         |
|    9 | Open **Channels**, **Drive**, **Skills**, **Tools**, **Runs**, and **Automations**. | Each route renders without Not Found or unhandled runtime errors.                   |

A fresh installation may correctly show empty states for installed Skills, Agent Runs, Automations, and local workspace files. Empty state is not itself a failure unless an action that should create data fails.

## Agent-driven skills, MCP, and remote administration

Agent Miki exposes a dedicated tool layer for controlled self-extension and administration. These operations are not equivalent to unrestricted shell access: each operation is validated, recorded, and subject to the caller’s origin and permission policy.[6]

| Tool                 | Function                                                                                                                        | Remote behavior                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `skill_search`       | Searches the online `skills.sh` registry and returns candidate metadata.                                                        | Read-only; it does not install anything.                                                                       |
| `skill_create`       | Creates an Agent-authored skill package with `SKILL.md`, metadata, and an entrypoint under the isolated downloaded-skills area. | High-risk; an authenticated owner must approve the persistent request before the write.                        |
| `skill_install`      | Installs a manifest-validated skill/plugin from `npm:`, `git:`, `clawhub:`, or a local directory.                               | High-risk; third-party acquisition is never silently activated and requires owner approval for remote callers. |
| `admin_config_get`   | Reads sanitized runtime configuration.                                                                                          | Read-only; secrets are not returned as raw values.                                                             |
| `admin_config_patch` | Applies a validated partial patch and reloads the runtime.                                                                      | High-risk; remote patches are restricted to `tools.mcp` and `tools.tool_state`, then require owner approval.   |
| `admin_tool_state`   | Enables or disables one named Agent tool.                                                                                       | High-risk; remote callers require owner approval and one-time consumption.                                     |

The safe approval sequence is deterministic. A remote Agent or MCP/Telegram turn first returns an `approval_required` response containing a request id and a human-readable preview. The owner reviews and approves the request in the authenticated Web UI approval surface, or uses the allow-listed Telegram command described below. The original operation is then retried with the same arguments and the approved request id. The implementation does not return or accept a raw approval token in chat, binds the request to the original actor and preview hash, and consumes it once.[7]

### Telegram administration configuration

Ordinary Telegram chat and administration are separate. Configure the channel token and normal message allow-list as usual, then add an explicit `admin_allow_from` list for the people permitted to view or decide approval requests. Do not rely on the ordinary `allow_from` list for administration when it includes general chat users.

A minimal configuration shape is:

```yaml
channels:
  telegram:
    enabled: true
    settings:
      allow_from:
        - "<approved-chat-or-user-id>"
      admin_allow_from:
        - "<owner-user-id>"
```

With a valid bot token and an allow-listed owner identity, the supported deterministic commands are:

```text
/miki approvals
/miki approve <request-id>
/miki deny <request-id>
```

Only these commands perform approval-inbox administration. Ordinary text continues through the Agent orchestrator, while unsupported slash commands and unauthorized admin commands do not become privileged actions. A live bot test still requires a real token and a deliberately approved test identity.[8]

### MCP administration boundary

Enable MCP and its discovery methods through the configuration or Web UI. MCP sessions are authenticated with the configured API key, and MCP tool calls are classified as remote for permission decisions.[9] Agent-driven remote configuration may only change `tools.mcp` and `tools.tool_state`. For MCP server definitions, the remote administration path permits HTTP/SSE-style transports with HTTPS URLs, or loopback HTTP for local development; it rejects stdio command fields, unsafe URLs, raw credentials, prototype-pollution keys, and unsupported fields. Configure sensitive header values through the credential vault’s `secret_ref` mechanism rather than by pasting a key into chat.[10]

External MCP servers and third-party skills are untrusted inputs. Search and inspect first, approve only the exact request you intend to execute, keep permissions minimal, and use the Web UI or local configuration for credential entry. The repository’s baseline verification does not execute an external MCP server or install an untrusted online package.

## 9. Hourly project-health review schedule

The project review schedule is configured as an active recurring interval of **3,600 seconds (one hour)** with `runAsNewTask: true`. Each firing starts as a separate fresh task instead of appending to the previous task’s conversation. Its self-contained playbook checks incomplete or failing capabilities, dual-mode search, model/provider and local-runtime readiness, MCP and Telegram/Web UI safety boundaries, tests, logs, and 24/7 readiness. It applies only safe reversible fixes, keeps credentials out of logs and commits, and reports issues that require owner input.

To inspect the schedule from the Manus environment:

```bash
manus-config schedule status --limit 1000 --offset 0
```

The schedule is project/task-scoped and is not the same as Agent Miki’s internal `self_improvement.reflection_interval_minutes` setting. Pause it only when explicitly needed:

```bash
manus-config schedule update --enabled=false
```

## 10. Node.js commands and runtime operations

| Command                      | Purpose                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `npm install`                | Install root and workspace dependencies.                                                 |
| `npm run build:llama`        | Build or reuse the platform llama.cpp server artifact.                                   |
| `npm run build:all`          | Build llama.cpp plus all TypeScript packages and the gateway.                            |
| `npm run build`              | Alias for `npm run build:all`.                                                           |
| `npm run dev`                | Start the development launcher.                                                          |
| `npm start`                  | Start the normal Agent Miki runtime.                                                     |
| `npm test`                   | Run workspace tests where defined.                                                       |
| `npm run verify`             | Run the repository verification script.                                                  |
| `npm run runtime:24-7`       | Run the long-running runtime helper when a persistent process is intentionally required. |
| `npm run runtime:24-7:check` | Check the persistent runtime helper state.                                               |
| `npm run clean`              | Run workspace clean scripts where defined.                                               |
| `node bin/miki.js doctor`    | Run runtime/CLI diagnostic checks.                                                       |
| `node bin/miki.js help`      | Display launcher help.                                                                   |
| `node bin/miki.js version`   | Display the package version.                                                             |

Stop the process with `Ctrl+C`. The launcher manages its gateway/core children and performs shutdown cleanup. If a process remains after an abnormal termination, inspect the process list and the current log before starting a second copy on the same port.

## 11. Go CLI setup and usage

The Go CLI is optional. The JavaScript launcher is the normal cross-platform dashboard entrypoint, while the Go companion provides a native terminal dashboard and managed runtime controls.

### 11.1 Build and test the Go CLI

From the repository root:

```bash
cd packages/cli
go test ./...
go build -o ../../bin/miki-cli ./.
cd ../..
```

On Windows PowerShell:

```powershell
Set-Location packages\cli
go test ./...
go build -o ..\..\bin\miki-cli.exe .
Set-Location ..\..
```

The package README also supports the source-level checks:

```bash
node --check packages/cli/agent.js
node packages/cli/agent.js doctor
go test ./packages/cli/...
```

### 11.2 Go CLI commands

The CLI exposes the following lifecycle commands:

```text
agent start
agent doctor
agent install
agent uninstall
agent uninstall --purge
agent version
agent help
```

The native Go terminal interface supports:

```text
Miki start [--host <host>] [--port <port>] [--debug] [--plain]
Miki help
Miki version
```

In a terminal, `Miki start` opens the Bubble Tea dashboard. In a non-terminal environment, plain mode is used automatically. Stop, Shutdown, and Restart control the managed gateway process tree rather than merely detaching from it.

### 11.3 Go CLI environment variables

| Variable              | Meaning                                                        |
| --------------------- | -------------------------------------------------------------- |
| `MIKI_INSTALLER=1`    | Enables Windows installer mode when the native wrapper exists. |
| `MIKI_WORKSPACE_DIR`  | Selects the data, logs, and configuration workspace.           |
| `MIKI_GATEWAY_PATH`   | Explicit built gateway entrypoint for the Node launcher.       |
| `MIKI_GATEWAY_ENTRY`  | Explicit gateway entrypoint for the Go terminal interface.     |
| `MIKI_RUNTIME_ROOT`   | Runtime distribution root for the Go interface.                |
| `MIKI_RUNTIME_LOADER` | Optional Node runtime loader.                                  |
| `MIKI_NODE`           | Node executable used by the Go interface.                      |
| `GATEWAY_HOST`        | Gateway bind host.                                             |
| `GATEWAY_PORT`        | Gateway bind port.                                             |

Canonical `MIKI_*` variables take precedence over legacy mixed-case variables that may still be accepted during the transition period.

## 12. Relocated or packaged runtime

When Agent Miki is installed into a different directory or distributed as a packaged runtime, set the runtime paths explicitly if automatic discovery cannot find the build:

```bash
export MIKI_RUNTIME_ROOT="/opt/agent-miki"
export MIKI_WORKSPACE_DIR="/var/lib/agent-miki"
export MIKI_GATEWAY_ENTRY="$MIKI_RUNTIME_ROOT/packages/gateway/dist/index.js"
export MIKI_RUNTIME_LOADER="$MIKI_RUNTIME_ROOT/runtime-loader.mjs"
export MIKI_NODE="$(command -v node)"
npm start
```

PowerShell example:

```powershell
$env:MIKI_RUNTIME_ROOT="C:\Program Files\Agent Miki"
$env:MIKI_WORKSPACE_DIR="C:\ProgramData\Agent Miki"
$env:MIKI_GATEWAY_ENTRY="$env:MIKI_RUNTIME_ROOT\packages\gateway\dist\index.js"
$env:MIKI_RUNTIME_LOADER="$env:MIKI_RUNTIME_ROOT\runtime-loader.mjs"
$env:MIKI_NODE=(Get-Command node).Source
npm start
```

For a relocated distribution whose gateway is already built, `MIKI_GATEWAY_PATH` may be used by the Node CLI to point directly to the built gateway entry file.

## 13. Configuration, workspace, logs, and backups

Runtime configuration belongs in the selected workspace and should not be confused with source-controlled defaults. `MIKI_WORKSPACE_DIR` changes where Miki stores data and runtime state. The dashboard Config page is the preferred place to inspect and save runtime settings. Channels are disabled by default in the safe fresh-install configuration; enable an integration only after its required credentials and endpoint settings are present.

Important runtime locations include:

| Path                                  | Purpose                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `data/`                               | Runtime databases, memory, audit data, schedules, and state.              |
| `data/core_backend.log`               | Core/gateway runtime log stream exposed by the Logs page.                 |
| `data/backups/`                       | Runtime backups created by the safety/backup subsystem.                   |
| `config/agent.yaml`                   | Checked-in project configuration template/defaults.                       |
| `packages/core/src/llm/local/native/` | Platform-specific local llama-server artifacts generated during builds.   |
| `.miki-build/`                        | Temporary llama.cpp build directory; generated and not source-controlled. |

Do not commit `.env` files, API keys, local databases, runtime logs, GGUF model files, compiled executables, or private keys. Keep model files and credentials outside the Git repository.

## 14. Troubleshooting

### `npm run build:all` fails while building llama.cpp

Confirm that the vendored directory exists and that CMake and a working C/C++ compiler are available:

```bash
test -d packages/core/src/llm/local/vendor/llama.cpp
cmake --version
cc --version || gcc --version
c++ --version || g++ --version
```

On Windows, rerun from a Visual Studio Developer PowerShell. Reduce parallelism with `MIKI_LLAMA_BUILD_JOBS=1`. If a stale build is suspected, set `MIKI_LLAMA_FORCE_REBUILD=1` and rerun `npm run build:llama`.

### Agent Miki starts but Chat reports a rejected credential

Open **Models/Credentials**, verify that the selected model has a valid provider key, and use the model test control. A 401/403 result is a credential problem, not proof that the dashboard or WebSocket is broken. Never paste a credential into source code or into a GitHub issue.

### Local model cannot start

Verify that the `.gguf` path is absolute and readable by the current user. Confirm that the selected model is configured as a local llama.cpp model and that automatic startup is enabled. Open **Logs** and **Health**. If the executable was built for another operating system or architecture, run `npm run build:llama` on the target machine; the project selects the current platform artifact.

### Port already in use

Inspect the configured port and the process that owns it. Use another port through `GATEWAY_PORT` when appropriate:

```bash
GATEWAY_PORT=18801 npm start
```

PowerShell:

```powershell
$env:GATEWAY_PORT="18801"
npm start
```

Open the matching URL, such as `http://127.0.0.1:18801`.

### Dashboard shows an old or blank build

Stop the running process, rebuild the frontend and gateway, and start one clean process:

```bash
npm run build:all
npm start
```

Then reload the browser without using a stale tab. Check **Logs** for the current process start timestamp and verify that the browser URL uses the active gateway port.

### Go CLI cannot find the gateway build

Run the complete build first, then run `node bin/miki.js doctor`. For a relocated runtime, set `MIKI_GATEWAY_ENTRY`, `MIKI_RUNTIME_ROOT`, `MIKI_RUNTIME_LOADER`, and `MIKI_NODE`. The Go interface requires Go 1.25 or newer for compilation and tests.

### Windows blocks the compiler or executable

Use a Developer PowerShell for Visual Studio, confirm that CMake can locate the MSVC compiler, and allow the local executable through the Windows security prompt only when you trust the source. Do not download and execute an unrelated `llama-server` binary when the repository's own build can produce the required artifact.

## 15. Production and persistent operation notes

The default setup is intended for a local machine. For a persistent service, keep the workspace on durable storage, configure a process supervisor appropriate for the operating system, restrict the bind address and firewall exposure, and store credentials in the supervisor's secret/environment mechanism. Do not expose a password-only local dashboard directly to the public internet without adding an appropriate reverse proxy, TLS, access control, and operational monitoring.

A local GGUF model can require substantial memory and sustained CPU/GPU resources. Begin with a small model, verify a short prompt, and only then increase context length, concurrency, or model size. The project-level `MIKI_LLAMA_BUILD_JOBS` controls compilation parallelism; it does not determine model inference performance.

## 16. Clean-install verification checklist

A clean installation is ready when all of the following are true:

- `node --version` satisfies the repository's Node.js requirement.
- `npm install` completes without dependency errors.
- `npm run build:all` completes and builds the gateway plus the platform llama.cpp artifact.
- `npm test` completes successfully.
- `npm start` serves the dashboard.
- Dashboard setup/login works.
- **Health** reports a running gateway/core state.
- At least one local or cloud model is configured and tested honestly.
- A short Chat prompt either completes or returns a specific actionable provider/model error.
- **Logs** displays current runtime entries.
- The selected local model starts llama-server automatically, or the selected cloud model operates without requiring llama-server.
- `go test ./...` passes from `packages/cli` when the Go CLI is part of the installation.

## References

[1]: https://nodejs.org/en/download/ "Node.js official downloads"
[2]: https://cmake.org/download/ "CMake official downloads"
[3]: https://go.dev/dl/ "Go official downloads"
[4]: https://git-scm.com/downloads "Git official downloads"
[5]: https://github.com/ggml-org/llama.cpp "llama.cpp official repository"
[6]: packages/core/src/tools/registry/executor.ts "Agent tool registration and execution surface"
[7]: packages/core/src/security/approval-inbox.ts "Persistent owner approval and one-time context-bound consumption"
[8]: packages/core/src/channels/telegram.ts "Telegram configuration, allow-lists, and deterministic admin commands"
[9]: packages/core/src/mcp/server.ts "Authenticated MCP session and tool execution"
[10]: packages/core/src/tools/registry/admin-control-handlers.ts "Restricted remote administration patch policy"
