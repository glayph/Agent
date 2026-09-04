# Level 1 — Gemma Web UI Evidence

## Text benchmark

A fresh authenticated Web UI session displayed `gemma-4-e2b` as the selected model and the run header `llama.cpp / llama.cpp/gemma-4-E2B-it-Q4_0`. The single Gemma prompt requested five independent outputs in strict JSON: a factual answer (`2 + 2`), a one-sentence summary, Bengali translation of `Good morning`, a polite rewrite of `The build failed.`, and extraction of `Name: Ada; Role: Engineer;` into exact fields.

The visible Web UI returned valid JSON with exactly the requested top-level keys. The values were correct: `2 + 2 equals 4.`, a faithful one-sentence summary, `শুভ সকাল`, a polite formal rewrite, and the exact extracted object `{ "name": "Ada", "role": "Engineer" }`. The response was rendered in the UI as a JSON code block and the Inspector event was visible.

This is evidence for L1-01 through L1-05 only. File and folder capabilities require separate live Web UI tool-call evidence and are not inferred from this text response.
