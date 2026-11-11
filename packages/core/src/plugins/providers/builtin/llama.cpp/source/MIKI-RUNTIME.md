# Agent-Miki llama.cpp runtime

- The only runnable build target is `llama-server`.
- One local GGUF model is loaded per server process (`--model`).
- The exposed API is limited to health/readiness, model metadata/properties, and OpenAI-compatible chat completions (including SSE streaming).
- Web UI/static assets, examples, benchmarks, tests, model conversion/quantization utilities, model-download presets, embedding/reranking modes, multimodal input, speech/audio/video, router/subprocess mode, and unrelated API families are not exposed or built as runnable targets.
- GGML backends, tokenizer/chat-template utilities, HTTP support, and the internal MTMD compatibility library remain only where the server's current shared context implementation requires them. MTMD is not exposed as a Miki feature.
- `node scripts/build-llama.mjs` configures and rebuilds the `llama-server` target on every Agent build. The build emits one runnable server executable; static libraries are internal link dependencies.
