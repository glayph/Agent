# Capability Verification Evidence

## Gemma direct transport

- Endpoint: `http://127.0.0.1:39200/v1`
- Model: `gemma-4-e2b`
- Health: `{"status":"ok"}`
- Smoke result: exact response `miki model smoke test`
- Process exit code: `0`

## Agent Miki UI retest

The dashboard rendered the local run label `llama.cpp/local-model` and entered the `Running` state. The Gemma-routed retest remained in `Thinking…` during the observation window and did not render a final assistant answer; this was recorded as incomplete agentic end-to-end verification rather than a pass.

## Repository validation

- Core test suites: 100 passed
- Core tests: 586 passed
- Frontend tests from prior validation: 68 passed
- Active retained model: Gemma 4 E2B Q4_0 GGUF, approximately 2.7 GiB
- Obsolete LFM model and historical runtime backups removed during final cleanup
- No API key or GitHub token is included in these reports
