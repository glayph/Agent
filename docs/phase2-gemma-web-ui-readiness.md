# Phase 2 — Gemma Web UI Readiness Evidence

The current runtime check found exactly one listening llama-server process at `127.0.0.1:39200`; its command line contains the Gemma 4 E2B Q4_0 GGUF and no LFM model. Gateway and core were listening on `127.0.0.1:18800` and `127.0.0.1:8000`. The active launcher state contained exactly one enabled/auto-start model with provider `llama.cpp`, local runtime `llama.cpp`, the Gemma GGUF path, and `runtime_apply_status: applied`.

The authenticated Web UI visibly showed `gemma-4-e2b` selected and a run header `llama.cpp / llama.cpp/gemma-4-E2B-it-Q4_0`. A direct bare-endpoint probe showed that the same Gemma model can produce a structured tool call. Prior full Miki Web UI attempts, however, produced prose or `tool_code` content rather than executable tool events; this is recorded as a capability failure, not a pass.

The expanded evaluation matrix is stored in `docs/agent-miki-capability-test-matrix.md`. No capability is classified as 100% merely from model readiness or a prose response.
