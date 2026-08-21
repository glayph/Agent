# Miki Native Runtime

Agent Miki-এর local GGUF inference backend এই directory-তে পরিচালিত হয়। Runtime source `miki-native-runtime/`-এ রাখা হয়েছে এবং Miki-এর build script headless server artifact তৈরি করে `native/<platform>-<architecture>/`-এ রাখে। Dashboard ও TypeScript provider lifecycle-এর একমাত্র application-facing control surface; আলাদা web interface বা manual server process প্রয়োজন নেই।

## Build policy

The native build is intentionally direct and host-based. It uses CMake plus a C/C++ compiler on Linux or Windows, does not require Docker, does not run Python, and excludes embedded web assets, benchmarks, examples, tests, conversion utilities, CI metadata, and platform packaging helpers from the distributable runtime tree. Optional or historical material is retained only in the local `.trash/` quarantine during source maintenance and is excluded from release archives.

The runtime preserves the stable OpenAI-compatible local HTTP contract needed by Agent Miki. Internal compatibility identifiers and the `llama-server` executable target remain unchanged where required by the native source and launcher contract; user-facing provider labels, HTTP identity, MCP client identity, diagnostics, documentation, and filesystem ownership use Agent Miki terminology.

## Local model requirements

A user supplies an absolute path to a GGUF model outside the source tree. Miki validates the extension and configured allowlist, starts the native executable on loopback, waits for `/v1/models`, and routes requests through the local provider adapter. Credentials are not required for local inference. API keys must be supplied only through environment variables or the dashboard credential flow and must never be written into this source tree.

## Maintenance boundary

Do not mechanically rewrite native model, tensor, quantization, or ABI symbols merely to change their technical spelling. Such symbols are part of the compiled compatibility boundary. Project-specific integration belongs in the Miki TypeScript adapter, build script, runtime manifest, and user-facing documentation.
