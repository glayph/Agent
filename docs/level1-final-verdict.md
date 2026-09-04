# Level 1 — Final Gemma 4 E2B Web UI Verdict

## Model and UI evidence

All tests used the authenticated Agent Miki Web UI with the selected model label `gemma-4-e2b` and run identity `llama.cpp / llama.cpp/gemma-4-E2B-it_Q4_0`. Relevant visual captures include `/home/ubuntu/screenshots/127_0_0_1_2026-08-27_18-11-18_4222.webp` for the text benchmark, `/home/ubuntu/screenshots/127_0_0_1_2026-08-27_18-35-14_9052.webp` for native file tool events, and `/home/ubuntu/screenshots/127_0_0_1_2026-08-27_18-45-38_4054.webp` for the final file-edit run. The Web UI DOM was also inspected directly for the latest assistant result.

## Final results

| ID | Capability | Verdict | Evidence |
|---|---|---|---|
| L1-01 | প্রশ্নের উত্তর দেওয়া | **১০০% নিখুঁত** | Gemma returned the correct JSON value `2 + 2 equals 4.` in Web UI. |
| L1-02 | Text summarization | **১০০% নিখুঁত** | Gemma returned a faithful one-sentence summary in Web UI. |
| L1-03 | Translation | **১০০% নিখুঁত** | `Good morning` was returned as `শুভ সকাল`. |
| L1-04 | Text rewriting | **১০০% নিখুঁত** | `The build failed.` was rewritten in a polite formal tone. |
| L1-05 | Information extraction | **১০০% নিখুঁত** | Exact fields `name: Ada` and `role: Engineer` were returned in valid JSON. |
| L1-06 | File পড়া | **১০০% নিখুঁত** | Native `File Read — Completed` event appeared in Web UI; independent read-back matched. |
| L1-07 | File তৈরি করা | **১০০% নিখুঁত** | Native `File Write — Completed` event created `level1-native-final-files/source.txt`; the file existed independently. |
| L1-08 | File edit করা | **১০০% নিখুঁত** | A separate Web UI run used native `file_write` to replace the benchmark file content with `After`, then native `file_read` returned `After`; independent shell check matched. |

## Fixes that enabled the result

The local Gemma path now sends a compact tool schema, forces structured tool choice for explicit tool-intent requests, clearly instructs the model that existing-file edits use canonical `file_write`, caps artifact turns at 192 generated tokens, and forwards provider abort signals through the provider registry. The first attempts produced `tool_code` prose or timed out; after these fixes, the native file-write/read run produced actual Web UI tool events and the explicit overwrite/read run completed with exact `After` content.

The verdict is limited to the eight Level 1 items above. It does not imply that the other levels are complete.
