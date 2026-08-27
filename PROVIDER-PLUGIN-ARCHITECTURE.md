# Agent Miki Provider Plugin Architecture

## Objective

Every AI provider is an independently managed plugin. The core runtime owns only plugin discovery, validation, routing, credential resolution, lifecycle, and shared request contracts. Provider modules own vendor-specific transport, model discovery, health checks, aliases, and completion behavior.

## Current audit

The repository provides a provider-plugin contract and registry under `packages/core/src/llm/provider/sdk`. Built-in ownership is now explicit under the mandated `packages/core/src/plugins/providers/builtin/` path: Gemini is under `Plug-in/gemini/`, local LFM/llama.cpp is under `Plug-in/llama-cpp/`, and `Plug-in/index.ts` is the sole built-in registration list. The launcher’s provider options and OAuth list are derived from registered manifests; the legacy catalog is only a compatibility facade derived from those manifests.

The shared OpenAI-compatible adapter is retained as a transport utility, not as a provider definition. It may be used by a plugin when the provider exposes a compatible endpoint, while provider-specific request normalization remains inside that plugin.

## Target contract

Each built-in provider is a separate module exporting one `MikiProviderPlugin` and one manifest. A provider plugin defines its stable provider ID, display metadata, aliases, model prefixes/IDs, capabilities, authentication mode, catalog, completion, model discovery, connection test, and optional shutdown hook. Gemini-specific compatibility normalization is in `Plug-in/gemini/compat.ts`; Gemini discovery and health are in `Plug-in/gemini/catalog.ts`; local runtime behavior is in `Plug-in/llama-cpp/index.ts`. The plugin registry validates API compatibility, rejects duplicate IDs, scopes external permissions, and supplies an isolated runtime context.

The built-in provider index imports provider modules explicitly. Adding a provider therefore requires a new plugin module plus registration, rather than editing a shared provider switch. Removing a provider removes one registration and its module without changing another provider's implementation.

## Provider isolation rules

Gemini owns Gemini endpoint construction, API-key use, model discovery, and Gemini-compatible request normalization. The local LFM/llama.cpp plugin owns local runtime startup, local health, local model identity, and no-auth behavior. Neither plugin reads or mutates the other plugin's credentials or runtime state.

The launcher and Web UI consume plugin descriptors and plugin-owned manifest/catalog metadata. Legacy aliases remain compatibility inputs only; canonical provider IDs and model identities come from plugin manifests. Model list, connection test, and completion calls use the plugin registry, while the shared OpenAI-compatible adapter is only a vendor-neutral transport utility. The Web UI now sends an optional `requested_model` on each chat turn; the backend validates it against the registry before execution.

## Safety and compatibility

External plugin entrypoints remain metadata-only unless the bounded executor is explicitly implemented. Plugin manifests are validated before registration. Credentials are resolved by provider ID and never included in descriptors or logs. The supported built-in set remains Gemini and llama.cpp, with LFM model execution available when a local GGUF model is configured.

## Verification requirements

Verification covers provider contract/loader/registry tests, the launcher compatibility suite, core and frontend tests, standard verification, release verification, provider-specific connection/model smoke tests, and direct Web UI routing checks. When the local plugin is not ready, the central router checks plugin health and falls back to a configured available remote model with an auditable warning instead of repeatedly attempting a missing GGUF runtime. If no provider is available, the user receives a targeted availability error before agent-loop churn.
