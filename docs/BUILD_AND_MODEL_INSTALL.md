# Agent Miki Build and Self-Service LLM Installation

Agent Miki can be built locally without GitHub Actions and can also be built and verified automatically by GitHub Actions on Linux x64 and Windows x64. Both paths use the same Node-based build orchestrator, so the native llama.cpp build flags, workspace compilation, verification, and release packaging remain aligned.

## Local build without GitHub Actions

Install Node.js 20 or newer, CMake, and a C/C++ compiler. On Linux, install `build-essential`, `cmake`, and `pkg-config`. On Windows, install Visual Studio Build Tools with the C++ workload and CMake. From the repository root, run:

```bash
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run build:local
```

The build script checks prerequisites, compiles the native llama.cpp server for the current operating system and architecture, builds all Agent Miki workspaces and the dashboard, and runs the repository verification workflow. To produce the matching offline package locally, run `npm run build:local:release`. Use `MIKI_LLAMA_BUILD_JOBS=1` on memory-constrained hosts. On Windows PowerShell, set it with `$env:MIKI_LLAMA_BUILD_JOBS = "1"`.

## GitHub Actions build

The workflow at [`.github/workflows/build-cross-platform.yml`](../.github/workflows/build-cross-platform.yml) runs on pushes and pull requests targeting `main`, as well as manual dispatch. It builds a Linux x64 and Windows x64 matrix, installs platform-native prerequisites, invokes `scripts/build-local.mjs`, runs verification, and creates the offline package. The existing manual release workflow remains available when a GitHub Release must be published.

The workflows intentionally do not bundle answer-model weights, provider API keys, voice models, or runtime state. This keeps artifacts portable and avoids placing large or sensitive assets in Git history. The model manager downloads approved weights on the target machine after installation.

## Self-service LLM model manager

The model manager is available through npm commands and can be invoked by an operator or by a permitted Agent Miki tool action:

```bash
npm run model:list
npm run model:status
npm run model:install -- gemma-4-E2B-it-Q4_0
npm run model:install -- gemma-local-e2b --start
```

The current catalog contains the official Gemma 4 E2B instruction-tuned Q4_0 GGUF. The catalog stores the HTTPS source URL, expected byte count, SHA-256, license, and model identifier in code. The manager rejects unknown model IDs and does not accept arbitrary URLs. Downloads are written to a temporary file under the user-owned Miki model directory, checked for size and SHA-256, and atomically renamed only after verification. An existing file is re-hashed before reuse; a corrupted file is removed rather than registered.

After a verified install, the manager registers the model in `launcher-state.json` as an enabled llama.cpp model, sets the default model variables, records the model directory as the allowed model directory, and optionally starts the local OpenAI-compatible llama.cpp server. The runtime uses localhost binding, no API key, and a bounded context setting. Model weights remain outside the repository and are never bundled into release archives.

The user-data locations are platform-aware. Linux uses `$XDG_DATA_HOME/miki` or `~/.local/share/miki`; Windows uses `%LOCALAPPDATA%\\miki`. They can be overridden for testing or multi-instance deployments with `MIKI_MODEL_DIR`, `MIKI_RUNTIME_ROOT`, `MIKI_STATE_PATH`, and `MIKI_CONFIG_DIR`. `MIKI_LLAMA_SERVER_BIN` can point to a prebuilt compatible server when the bundled native binary is unavailable.

## Safety and recovery behavior

Only allow-listed models can be downloaded. HTTPS redirects are followed for the pinned source, but the final bytes must match the pinned size and hash. Secrets are not needed for the public model source and are not written by the manager. If a download is interrupted or fails integrity validation, the partial file is discarded and no model is registered. The manager exits nonzero with a diagnostic message so a supervisor or Agent Miki can retry after diagnosing the failure.

The `remove` command removes an allow-listed model file and its persisted local registration. It should be used only when the operator intends to delete that model. The agent should treat model installation as a bounded model-runtime operation rather than as permission to fetch arbitrary binaries, plugins, or code.

## Example first-run sequence

```bash
npm run build:local
npm run model:install -- gemma-4-E2B-it-Q4_0 --start
npm start
```

Open `http://127.0.0.1:18800`, confirm `gemma-local-e2b` is selected, and run the dashboard Models-page completion test. For a production deployment, also keep the gateway under the repository’s 24/7 supervisor and configure the host firewall to retain the localhost-only binding unless remote access is explicitly required.
