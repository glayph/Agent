# Agent Miki Verification Report

## Scope

This report records the final local verification of Agent Miki after configuring the allow-listed Gemma GGUF model, validating the Gemini provider, fixing the local-provider registration gap, and correcting local tool-choice behavior.

## Configuration

The local model is registered as `llama.cpp/gemma-4-E2B-it-Q4_0` using a verified GGUF artifact. The model file was downloaded outside the repository and its SHA-256 checksum matched the catalog entry. The local llama.cpp server was started on `http://127.0.0.1:39200/v1`.

The model manager now persists both `MIKI_LLAMA_BASE_URL` and `MIKI_LOCAL_MODEL_ENDPOINT`, so the dashboard correctly recognizes a healthy local model as **Available**. The local server was tuned for the CPU-only environment with an 8K context and a 512-token prediction budget.

Gemini Flash Lite connectivity was tested through the dashboard using the configured Gemini provider endpoint. The dashboard reported a successful completion-level verification with a 620 ms response time. Credentials are not included in this report or in the source archive.

## Fixes Applied

The model-manager catalog test was updated to validate both supported pinned models and to isolate its model directory from user-level installed state. Local model registration was fixed to persist the endpoint variables required by the runtime configuration layer. Local model requests now use automatic tool selection rather than forcing a structured tool call on every turn; this allows small local checkpoints to answer direct questions while retaining access to registered tools.

## Verification Results

| Check | Result |
| --- | --- |
| Frontend build | Passed |
| Full project build | Passed |
| Model-manager tests | Passed: 3/3 |
| Local llama.cpp smoke test | Passed; exact smoke response returned |
| Runtime doctor | Passed with expected warnings for optional Go CLI and dependency audit |
| Dashboard setup/login | Passed with the configured local password |
| Local Gemma model readiness | Passed; dashboard displayed **Available** |
| Gemini Flash Lite connection | Passed; completion-level verification |
| Level 1 direct question | Passed; returned `4` for `2 + 2` |
| Level 2 terminal task | Passed; executed `pwd` and `uname -s`, returning the project path and `Linux` |
| Visual UI check | Passed; dashboard, Models page, login flow, and chat workspace rendered in the single dark theme |

## Known Limitation

The first long Level 1 prompt timed out on the CPU-only runtime because the agent initially used a large context and tool-heavy request path. The runtime was then tuned and the local tool-choice behavior was corrected. Subsequent short direct and terminal tasks completed successfully. Larger local tasks may still require shorter prompts, a smaller tool set, or stronger hardware.

## Reproducible Commands

```bash
npm ci
npm run build
npm run test:model-manager
npm run model:smoke -- --local
node bin/miki-doctor.mjs
npm run model:status
```

The model file is intentionally excluded from the source archive because it is several gigabytes and is managed by `npm run model:install -- gemma-4-e2b`.

## Visual Evidence

The final browser screenshot shows the authenticated chat workspace after the successful Level 2 terminal task. The screenshot is retained outside the source tree as session evidence.

## Security Notes

No API key, password, access token, runtime database, generated log, or installed model file is included in the source archive. The dashboard password and provider credentials remain local runtime state only.

## Review Status

The final review confirms that the runtime is built, the local model is registered and healthy, the Gemini provider has been validated, the browser UI is usable, Level 1 and Level 2 test tasks complete, and generated runtime artifacts are excluded from the deliverable archive.

