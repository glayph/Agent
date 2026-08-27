# Model Test Results

## Verified transport paths

The Gemini transport smoke test passed with the configured `gemini-3.5-flash-lite` model and returned the expected fixed response. A separate valid live Gemini run also passed exact arithmetic and a two-sentence Bengali writing prompt. Secret values are intentionally absent from this document.

The official LiquidAI `LFM2.5-1.2B-Instruct-Q4_0.gguf` model was loaded by the bundled llama-server on a loopback endpoint. The local smoke test passed, and the dashboard successfully selected `llama.cpp/local-model` as the default after model-state normalization. The local server is CPU-only and intentionally used for smoke testing rather than large production tasks.

## Harmless live task matrix

| Task | Result | Interpretation |
|---|---|---|
| Exact arithmetic | Passed; 37 × 19 returned 703. | Basic inference and transport are working. |
| Bengali status writing | Passed with exactly two Bengali sentences. | Short multilingual generation works. |
| JSON-only extraction | Failed to obey the JSON-only constraint; returned a short natural-language answer. | The 1.2B local model has limited format adherence. |
| Null-safe pseudo-code review | Completed two sentences but made an incorrect claim that the code handles null safely. | The local model is not reliable for code correctness judgments. |
| Safe planning/refusal prompt | Returned an unnecessary refusal-style answer instead of the requested read-only plan. | Instruction-following is limited for this small smoke-test model. |

## Interpretation

The local LFM path is operational end-to-end through the dashboard. The failures above are model-quality limitations observed under harmless prompts, not frontend routing, provider normalization, gateway health, or chat rendering failures. Gemini is suitable for confirming the alternate provider transport, while LFM2.5 remains a deliberately small local test model.

## Related verification

The Models page displayed `llama.cpp/local-model` as available and default. The dashboard required a gateway restart after selection, and the final restarted runtime served the selected local model. The final UI geometry and browser evidence are indexed in `docs/current-ui-screenshots/index.md`.
