# Model Test Results

## Gemini

The OpenAI-compatible Gemini transport smoke test passed with the configured `gemini-3.5-flash-lite` model and returned the expected fixed response. The API key value is intentionally not stored in this document.

## Local LFM

The local llama.cpp smoke test could not connect because `http://127.0.0.1:8080/v1/chat/completions` returned `ECONNREFUSED`. No local LFM inference server is currently running in this runtime.

## Interpretation

Agent Miki can be tested against Gemini when the runtime is launched with the valid provider environment, while local LFM remains an environment/setup limitation rather than a frontend failure.

## LFM2.5 local follow-up

The official LiquidAI `LFM2.5-1.2B-Instruct-Q4_0.gguf` file was downloaded and loaded by the bundled llama-server at `http://127.0.0.1:8080/v1`. The local smoke test passed and returned the expected fixed response. The model is a free local CPU path; the server is intentionally bound to loopback only.

## Live provider test status

Gemini and local LFM transport are both now independently verified. The next UI task pass will select the local model in the Models page and verify an actual agent response through the dashboard.

## Models UI selection

The Models page successfully promoted `llama.cpp/local-model` to Default and displayed the expected “Gateway restart required” notice. This confirms the UI state mutation path; the gateway restart is required before the dashboard chat uses the local endpoint.
