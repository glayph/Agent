# Agent Miki

**Agent Miki** is a local-first, cross-platform agentic AI workspace. It combines chat, file operations, computer tasks, coding workflows, memory, automation, model routing, and a browser-based dashboard in one application.

## Highlights

- **Agent workspace:** Plan and execute multi-step tasks through a single session.
- **Provider Gateway:** Route model requests through one registry and SDK boundary.
- **Built-in providers:** Google Gemini, llama.cpp, OpenAI, OpenAI-compatible servers, and OpenRouter.
- **Local-first execution:** Use local GGUF models with the bundled llama.cpp integration.
- **Tools and MCP:** Connect agent capabilities and external tool servers through governed interfaces.
- **Dashboard:** Manage models, plugins, skills, memory, automations, health, and logs from the web UI.
- **Cross-platform support:** Designed for Linux, macOS, and Windows environments.

## Architecture

```text
Agent
  └── Model Router / Provider Gateway
        ├── Provider Plugin SDK
        │     ├── Gemini
        │     ├── OpenAI
        │     ├── OpenAI Compatible
        │     ├── OpenRouter
        │     └── llama.cpp
        └── Tools, MCP, memory, and workspace services
```

The **Provider Gateway** handles provider discovery, model resolution, credential lookup, health checks, and completion routing. MCP remains the protocol for tools and external capabilities; it is not used as a replacement for model-specific transport adapters.

## Requirements

- Node.js 20 or newer
- npm
- Git
- C/C++ toolchain and CMake when compiling llama.cpp locally
- A GGUF model for local inference
- An API key for any cloud provider you want to use

## Quick Start

```bash
git clone https://github.com/glayph/Agent.git
cd Agent
npm install
npm run build:all
npm run dev
```

The development launcher starts the gateway and dashboard. For a direct runtime launch after building:

```bash
npm start
```

Use `npm run verify` to run the repository verification checks.

## Provider Configuration

Set only the credentials required by the providers you intend to use. Do not commit `.env` files or API keys.

| Provider | Identifier | Environment variable | Default endpoint |
|---|---|---|---|
| Google Gemini | `gemini` | `GEMINI_API_KEY` | Gemini OpenAI-compatible API |
| OpenAI | `openai` | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| OpenAI Compatible | `openai-compatible` | `OPENAI_COMPATIBLE_API_KEY` | `http://127.0.0.1:8000/v1` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| llama.cpp | `llama.cpp` | Local configuration | `http://127.0.0.1:39200/v1` |

For an OpenAI-compatible server, set a custom endpoint with `OPENAI_COMPATIBLE_BASE_URL`. Provider settings can also be managed from the dashboard after the application starts.

## Local Models

Local models are served through llama.cpp. Configure a readable GGUF file in the dashboard or local runtime configuration, then select the corresponding model from the Models page. A model name alone is not sufficient; the runtime also needs a valid `model_path` and a ready local server.

## Useful Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the development runtime and dashboard. |
| `npm start` | Start the built runtime. |
| `npm run build:all` | Build llama.cpp, packages, gateway, frontend, and CLI. |
| `npm run build:frontend` | Build only the web dashboard. |
| `npm run model:list` | List managed local models. |
| `npm run model:status` | Check local model status. |
| `npm run verify` | Run repository verification checks. |
| `npm test` | Run workspace tests. |

## Documentation

- [Provider Gateway](docs/provider-gateway.md)
- [Detailed setup guide](SETUP.md)
- [License](LICENSE)

## Security

Keep API keys outside the repository. Review permissions before enabling external tools, browser actions, shell execution, or messaging integrations. Persistent jobs and external side effects should use appropriate approval and idempotency controls.

## License

Agent Miki is distributed under the MIT License.

## References

[1]: https://github.com/glayph/Agent "Agent Miki repository"
[2]: https://nodejs.org/ "Node.js"
[3]: https://ai.google.dev/gemma/docs/core "Gemma model documentation"
