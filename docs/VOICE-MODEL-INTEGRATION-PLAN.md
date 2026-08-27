# Voice Model UI Integration Plan

## Decision

This change will be implemented as a frontend integration over the existing speech-to-text contracts. The repository already supports local `whisper.cpp` speech models through two transports: a local CLI model and an HTTP(S) endpoint. The API routes already persist model selection, enablement, language and runtime settings, install catalog models, run health checks, and activate a model. No new backend persistence field is required for the requested UI.

## UI behavior

The Models page will keep cloud provider configuration unchanged. The local provider group will receive a compact **Voice** row directly beneath its model cards. Clicking the row will open a focused configuration dialog containing the existing speech model manager. The dialog will retain local model installation, health, activation and file-path configuration, while exposing the endpoint transport as the API-based audio-to-text option.

The compact row will not duplicate provider cards or create a separate route. It will use the existing shared dialog, card, button, input, select and switch primitives, preserving keyboard access, error toasts and current API behavior. The API option will remain distinct from the local CLI option through the transport selector and endpoint field.

## Acceptance criteria

| Criterion          | Expected result                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Placement          | Voice appears below the local llama.cpp provider models only                              |
| Interaction        | Clicking Voice opens the configuration dialog; Escape and close controls work             |
| Local mode         | CLI executable and model-path configuration remain available                              |
| API mode           | HTTP(S) speech endpoint can be added, edited, activated and removed through existing APIs |
| Existing providers | Gemini and other provider cards retain current behavior                                   |
| Minimal design     | Compact trigger row; detailed controls only appear after clicking                         |
| Verification       | Frontend lint, tests, build and browser runtime verification pass                         |
