# Local LLM Error Remediation

## Root cause

The repeated generic local-LLM errors were not caused by Gemma model identity or basic inference. The Gemma endpoint had previously loaded successfully and returned `READY`. The actual failure state was that the core and gateway processes remained alive while the single Gemma `llama-server` process had exited and port `39200` was no longer listening. The dashboard health path could still trust the cached `externalReadyBaseUrl` or an environment base URL, so readiness became stale and the completion path later surfaced a misleading timeout.

## Fixes

The local runtime now clears the cached external-ready marker when a live `/models` probe fails. The reported `ready` state no longer becomes true merely because `MIKI_LLAMA_BASE_URL` exists. The llama.cpp provider `testConnection` now calls the live runtime readiness path and returns the actual health failure with measured latency. The agent timeout response now explains the model, timeout duration, cancellation, and the likely CPU/prompt-context cause instead of repeatedly saying only “check the provider connection”.

## Verification

The Gemma server was restarted from the pinned GGUF file and listened on `127.0.0.1:39200`. `/v1/models` returned only `gemma-4-E2B-it_Q4_0`, and a direct `READY` completion succeeded. Core build passed. The full core suite passed with 100 suites and 587 tests. Frontend production build passed after the non-generation-message cleanup.

A previous dead-server state is preserved in the runtime logs as evidence: core/gateway listeners remained present while no llama-server listener was present, and the llama log ended with a cleanup message. After restart, the process list showed one Gemma llama-server, core on `8000`, and gateway on `18800`.

## Operational result

The system now distinguishes a live local endpoint from a stale cached readiness flag. When a local completion genuinely exceeds the configured limit, the user-facing message includes a clear `[Local AI timeout]` explanation and a concrete retry direction. When the server is unavailable, the live health check can report that the llama.cpp runtime is unreachable or failed to start rather than masking the condition as an unexplained repeated timeout.
