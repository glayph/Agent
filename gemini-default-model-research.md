# Gemini default model research

Source: Google AI for Developers, Models — https://ai.google.dev/gemini-api/docs/models
Retrieved: 2026-08-20

The official model guide lists `gemini-3.7-flash` as the latest stable Flash model for complex coding and agentic workflows. It also lists `gemini-3.6-flash`, `gemini-3.5-flash`, and `gemini-3.5-flash-lite` as stable endpoints. The guide explicitly lists `gemini-2.0-flash` under previous models as shut down.

Source: Google AI for Developers, Release notes — https://ai.google.dev/gemini-api/docs/changelog
Retrieved: 2026-08-20

The release notes state that Gemini 3.7 Flash became generally available on August 13, 2026, and that Gemini 2.0 Flash was shut down on June 1, 2026. They also identify `gemini-3.5-flash` and `gemini-3.1-flash-lite` as migration targets for older Gemini 2.0 users.

Implementation implication: use the explicit provider-qualified default `gemini/gemini-3.7-flash` so local routing selects the Gemini adapter and the wire request receives the bare model ID `gemini-3.7-flash`. Keep `MIKI_MODEL` as an intentional override for OpenAI, Anthropic, OpenRouter, Ollama, or another configured provider.
