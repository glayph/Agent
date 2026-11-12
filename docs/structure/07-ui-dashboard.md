# 07 — UI Dashboard

The current Web UI is a React application served by the Node Gateway:

```text
React frontend → Node Gateway → Agent runtime / Core / Memory / providers
```

## Key locations

- `packages/ui/frontend/src/`: React pages, feature components, state, API clients and translations.
- `packages/ui/frontend/src/pages/chat-page.tsx`: Chat page state, autonomy polling, model/thinking/display selectors, and Top Bar status derivation.
- `packages/ui/frontend/src/features/chat/components/workspace/workspace-header.tsx`: Chat Top Bar presentation and interaction/accessibility behavior.
- `packages/ui/frontend/src/app/layout/global-header-actions.tsx`: global Gateway lifecycle actions and related dialogs.
- `packages/ui/legacy-go-compat/`: legacy Go compatibility/static-serving sources; not the primary dashboard API backend.

## Chat Top Bar behavior

The Top Bar status pills are derived from live Gateway/WebSocket connection state and the `/api/autonomy/status` snapshot. Gateway status opens Health; Agent/autonomous-work status and the working indicator open Activity. Active goal count appears only when the API reports active/running goals. On narrow screens, accessible status dots replace full text pills; desktop shows compact labels.

The control cluster retains the model selector, thinking mode, assistant-detail/display selector and global Gateway actions. Gateway stop uses the existing confirmation flow; it must not silently terminate a running service. Translation keys for the status pills live in the frontend locale JSON files.

## UI quality rules

- Drive status from actual application state, not hard-coded empty arrays or optimistic labels.
- Make interactive status indicators keyboard reachable with accessible names.
- Use confirmation for disruptive lifecycle actions and represent pending/error states accurately.
- Keep mobile and desktop variants functionally equivalent.
- Add component/status tests when changing state derivation or actions; validate the actual browser layout before claiming responsive verification.

Vite proxies API, Gateway and WebSocket requests to the configured Node Gateway during development. The legacy Go compatibility layer is not the primary Web UI API server.
