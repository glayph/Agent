# Agent Miki Provider-Isolated LLM Architecture

## উদ্দেশ্য

Gemini, OpenAI, Anthropic, OpenRouter, Ollama এবং ভবিষ্যৎ OpenAI-compatible provider-গুলোর transport ও credential logic এখন `packages/core/src/llm/provider/` boundary-এর মধ্যে রাখা হয়েছে। Agent orchestration, workflow, queue, channel এবং UI code provider SDK-এর সঙ্গে সরাসরি কথা বলবে না।

> **মূল contract:** core agent কেবল `achatCompletion()` অথবা `@miki/core/llm/provider`-এর neutral adapter contract ব্যবহার করবে; কোনো provider SDK import adapter directory-এর বাইরে করা উচিত নয়।

## Directory boundary

| Layer | Location | Responsibility |
|---|---|---|
| Public provider facade | `packages/core/src/llm/provider/index.ts` | Stable exports for other packages |
| Stable port | `contracts.ts` | `LLMProviderAdapter`, request, model and connection types |
| Routing/catalog | `catalog.ts` | Provider IDs, model prefix routing, custom providers, API-key names and model normalization |
| Registry | `registry.ts` | Adapter selection, credential resolution, completion dispatch and cache lifecycle |
| OpenAI-compatible adapter | `openai-compatible-adapter.ts` | Gemini, OpenAI, OpenRouter, Ollama and custom compatible endpoints |
| Anthropic adapter | `anthropic-adapter.ts` | Native Anthropic SDK, message/tool translation and error mapping |
| Error contract | `errors.ts` | Provider-neutral typed errors and retryability metadata |
| Compatibility layer | `packages/core/src/providers/*.ts` | Re-exports only; existing imports do not break |

## Isolation guarantees

Provider-specific SDK imports are kept inside adapter files. A provider change therefore changes only its adapter and focused tests, while `agent.ts`, queue workers, delivery code and channel adapters continue to receive the same `LLMResponse` shape.

Credential lookup is performed by the registry through the existing configured-secret mechanism. API keys are not placed in model names, request payloads, logs, or public error text. Missing credentials, authentication rejection, quota/rate limit, timeout and generic provider failures are normalized into typed errors with `providerId`, optional HTTP status and retryability metadata.

The old `providers/provider-controller.ts` and `providers/claude-native.ts` paths now contain compatibility re-exports. This is intentional: code that still imports those paths remains operational, but there is only one implementation source under `llm/provider/`.

## Adding a new provider

For a native SDK provider, create an adapter under `llm/provider/`, implement `LLMProviderAdapter`, translate the provider response to `LLMResponse`, classify SDK errors into the shared error types, and register the adapter in `registry.ts`. For an OpenAI-compatible endpoint, add a catalog entry or a `model_providers` configuration block; no agent or channel code change is required.

A new adapter must have focused tests for model routing, missing credentials, authentication rejection, rate limiting, timeout, response translation and cache clearing. Network tests should use mocks or a local test server; real credentials must never be committed.

## Current validation

The core package build passes. The provider boundary suite and existing native Claude suite pass together with **31 tests**. The explicit package export is `@miki/core/llm/provider`.

## Deliberate future hardening

The launcher compatibility router still contains some duplicated provider metadata and model-management helpers. They are currently protected by the compatibility facade, but a later cleanup should make launcher endpoints consume the catalog directly. Provider fallback policy, per-provider circuit breakers, streaming parity and production secret rotation should also be added as separate changes with their own regression suites.
