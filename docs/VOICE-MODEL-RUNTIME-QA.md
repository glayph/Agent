# Voice Model Runtime QA

## Verified behavior

The live Models page now places `llama.cpp Local` in its own provider section and renders a compact **Voice** row directly beneath the local model card. The Voice row remains hidden from cloud providers and opens a focused configuration dialog when clicked.

The dialog preserves the existing speech-to-text actions: local runtime readiness, model installation, health check, and model activation. The Add audio model form exposes both `Local whisper-cli` and `Whisper server endpoint` transports. Selecting `Whisper server endpoint` replaces the local executable/model-path fields with an HTTP endpoint field, confirming the API-based audio-to-text configuration path is wired to the existing backend contract.

The final dialog is wide enough for desktop use, remains viewport-safe, and keeps the existing model configuration page visible behind a modal overlay. No model installation or external credential submission was performed during QA.

## Evidence screenshots

- `/home/ubuntu/screenshots/127_0_0_1_2026-08-27_10-06-44_3999.webp`: local provider and compact Voice row.
- `/home/ubuntu/screenshots/127_0_0_1_2026-08-27_10-08-09_2149.webp`: Voice configuration dialog.
- `/home/ubuntu/screenshots/127_0_0_1_2026-08-27_10-08-17_1841.webp`: Add speech model form in local whisper-cli mode.
- `/home/ubuntu/screenshots/127_0_0_1_2026-08-27_10-08-36_7071.webp`: API endpoint transport selected.

## Status

Runtime UI behavior passed. Automated verification and final repository delivery remain part of the final pass.

## Automated verification

Frontend lint passed with zero warnings. The frontend test suite passed with **15 test files and 68 tests**. The frontend production build passed, and the repository-wide `npm run verify` workflow passed all build, typecheck, package-test, frontend-test, doctor, and production dependency audit stages. The doctor output contained only the pre-existing optional Gemini credential warning; no voice installation or external credential action was performed.
