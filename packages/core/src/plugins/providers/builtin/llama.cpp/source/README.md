# Vendored llama.cpp runtime for Agent-Miki

This source tree is trimmed for the Agent-Miki single-model inference server. The only executable target is `llama-server`; static libraries are internal dependencies. No upstream Web UI, examples, benchmark/test executables, conversion or quantization tools, model preset downloads, embedding/reranking endpoints, multimodal input, audio/video, or router mode is exposed.

Build from the Miki project root with `node scripts/build-llama.mjs`. This configures CMake and rebuilds only the `llama-server` target on every run. CMake and a platform C/C++ toolchain are required.

Some shared tokenizer, chat-template, GGML backend and internal MTMD compatibility sources remain because the server context currently depends on them; they are not separate runnable features.
