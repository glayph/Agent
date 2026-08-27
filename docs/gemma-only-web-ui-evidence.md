# Gemma 4 E2B-only Web UI Evidence

## Model identity and source

The selected local model is `gemma-4-E2B-it-Q4_0`, displayed in the Web UI as `gemma-4-e2b`, served through `llama.cpp`. The GGUF was downloaded from the pinned Hugging Face source `https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF` and verified with SHA-256 `2d9a803a627ee94230dc23681008ae340d9785a2374e2a6a0c8d69c7ee7ea47e` and size `3378740704` bytes.

## Web UI model readiness

The authenticated Web UI model API returned HTTP 200 with:

- `default_model: gemma-4-e2b`
- exactly one visible model: `gemma-4-e2b`
- `provider: llama.cpp`
- `runtime_model: llama.cpp/gemma-4-E2B-it-Q4_0`
- `is_default: true`
- `status: available`
- `ready: true`

The earlier LFM, Gemini, and placeholder entries were removed from the active launcher state for this Gemma-only test.

## Live Web UI runs

The first Gemma Web UI task requested a three-file SHA-256 utility. The run was shown as `Run: llama.cpp / llama.cpp/gemma-4-E2B-it-Q4_0` but ended with `Error calling LLM: Local llama.cpp request timed out after 90000ms`; no requested files were created.

A second, smaller Gemma Web UI task requested one `add.js` file, a CLI run, and a read-back. It also entered a running state without creating the requested artifact during the observed window. The model server process was CPU-bound, indicating a generation/context performance problem rather than a missing provider.

A direct minimal completion probe against the same local server returned `READY`, proving the Gemma server and basic inference path are healthy. The remaining issue is the agentic prompt/tool-call path under the dashboard's accumulated session context and tool schema.

## Remediation applied

The model manager now allowlists Gemma 4 E2B Q4_0 and, when Gemma is installed, prunes other model entries from launcher state. The runtime was restarted with longer local LLM and agent timeouts. Agent configuration was tightened to `message_history_limit: 4`, resource `max_context_chars: 12000`, and `max_tool_iterations: 12` to reduce prompt pressure for the compact local model.

## Current status

Gemma-only model configuration is verified. Basic inference is verified. Full free-form agentic tool execution is not yet verified in this run because the dashboard benchmark timed out/no artifact was observed. Further testing must use a fresh session or a deterministic tool benchmark with a compact prompt.
