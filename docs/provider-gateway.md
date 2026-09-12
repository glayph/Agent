# Provider Gateway

Agent Miki now routes model requests through one canonical **Provider Gateway**. The agent and model router resolve a model identifier to a provider plugin, obtain credentials through the secret resolver, normalize the request, and dispatch it through the provider SDK. MCP remains the tool and capability protocol; it is not used as a substitute for the model transport. The existing `model-router.provider-registry` plugin is the gateway boundary between the agent and provider adapters.

## Built-in Providers

| Provider | Identifier | Environment variable | API contract |
|---|---|---|---|
| Google Gemini | `gemini` | `GEMINI_API_KEY` | Gemini OpenAI-compatible endpoint |
| llama.cpp | `llama.cpp` | local configuration | Local runtime |
| OpenAI | `openai` | `OPENAI_API_KEY` | OpenAI Chat Completions |
| OpenAI Compatible | `openai-compatible` | `OPENAI_COMPATIBLE_API_KEY` | Any OpenAI-compatible `/v1` server |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | OpenRouter OpenAI-compatible endpoint |

OpenAI-compatible base URLs can be customized with `OPENAI_COMPATIBLE_BASE_URL`. Provider-specific models can be referenced as `provider/model`, while recognizable model prefixes such as `gpt-*` resolve to OpenAI.

## Provider SDK

New providers can be created with `createOpenAICompatibleProvider()` in `packages/core/src/plugins/providers/builtin/openai-compatible-factory.ts`. A provider plugin supplies a manifest, authentication policy, catalog, completion hook, model discovery, and connection health check. The provider registry owns lifecycle and routing; adapters own vendor transport details.

Credentials are never serialized into provider descriptors or logs. The dashboard exposes provider metadata and configuration state, while actual API keys are resolved only at invocation time.

## Verification

The core test suite passed with **102 test suites and 641 tests**. The core TypeScript build also passed after registering the new provider plugins.
