# Chat UI — Part 1: Architecture & Feature Audit

**Date:** 2026-10-03  
**Scope:** Frontend Chat Page only (no visual redesign in this part)  
**Commit baseline:** `f98aabe`  
**Part plan:** (1) Audit → (2) Bubble redesign + rendering → (3) Interactions, performance, visual QA

---

## 1. Architecture map

```
pages/chat-page.tsx                 # Shell: session, composer state, scroll, voice, handlers
  └─ workspace/workspace-shell.tsx  # Header + message list + composer layout
  └─ workspace/chat-message-list.tsx
       └─ workspace/chat-message.tsx  # role switch
            ├─ user-message.tsx
            └─ assistant-message.tsx (lazy)
                 ├─ markdown-renderer.tsx
                 ├─ message-code-block.tsx
                 ├─ message-action-bar.tsx
                 ├─ attachment-card / link-preview / live-activity
  └─ chat-composer.tsx (via workspace/composer.tsx)
  └─ chat-inspector.tsx
  └─ session-history-menu / model-selector

State & transport
  store/chat.ts              # jotai chatAtom
  features/chat/controller.ts  # send/edit/delete/retry/fork/session
  features/chat/websocket.ts
  features/chat/protocol.ts
  hooks/use-miki-chat.ts → use-pico-chat.ts
```

### Key files (size)

| File | ~LOC | Role |
|------|-----:|------|
| `chat-page.tsx` | 1138 | Page orchestration |
| `controller.ts` | 852 | WS + session API |
| `assistant-message.tsx` | 530 | Agent bubble |
| `chat-composer.tsx` | 424 | Input |
| `user-message.tsx` | 162 | User bubble |
| `message-action-bar.tsx` | 239 | Copy/retry/fork/delete/inspect |
| `markdown-renderer.tsx` | 27 | GFM + highlight + sanitize |
| `message-code-block.tsx` | 222 | Code chrome + copy/wrap |

Tokens: `packages/ui/appearance.css` (`--chat-user-*`, `--chat-assistant-*`).

---

## 2. Feature inventory & status

Status legend: **OK** = wired end-to-end · **PARTIAL** = UI or API incomplete · **BROKEN** = present but fails or no-op · **MISSING** = required by product but absent

| Feature | Location | Status | Notes |
|---------|----------|--------|-------|
| Message send | `sendChatMessage` + composer | **OK** | WS required; optimistic user row |
| Streaming | controller `stream_checkpoint` / `stream_done` | **OK** (needs live QA) | `isTyping` during run |
| Stop generation | composer / controller | **MISSING** | No abort API in composer; `isWorking` only on header/inspector |
| Retry / regenerate | action bar → `retryChatMessage` | **OK** (gate) | Only when `retryableMessageIds` + connected + not typing |
| Edit message | user bubble → composer | **PARTIAL** | Loads content into composer; resend via `editMessage`; cancel-edit UX weak |
| Delete message | action bar + confirm dialog | **OK** | API `deleteSessionMessage` |
| Fork session | action bar | **OK** | `forkChatSessionFromMessage` |
| Copy message | action bar | **OK** | `useCopyToClipboard` |
| Code copy / wrap / collapse | `MessageCodeBlock` | **OK** | Line numbers, wrap atom |
| Markdown (GFM) | `MarkdownRenderer` | **PARTIAL** | Only `pre` overridden; tables/lists default; long content overflow risk |
| Inline code | default markdown | **PARTIAL** | No dedicated chat styles |
| Tables | remark-gfm | **PARTIAL** | Needs bubble max-width + overflow audit |
| Links | default `<a>` | **PARTIAL** | External attrs / link-preview separate |
| JSON / commands | user mono if `/` prefix | **PARTIAL** | User only; assistant JSON is plain MD |
| Tool / status messages | `kind` + collapse | **OK** | thought / tool_calls / action update |
| Errors / warnings | `isError` + classify | **OK** | error bubble tokens |
| Attachments (image) | composer + cards | **OK** | type/size limits on chat-page |
| Attachments (audio) | optional menu | **PARTIAL** | Depends on handlers |
| Voice record | MediaRecorder | **PARTIAL** | Stop voice only; browser permission dependent |
| Loading / typing | list + header | **OK** | `isTyping` |
| Empty state | `ChatEmptyState` | **OK** | Gateway/model gates |
| Session switch | history menu + controller | **OK** | Hydration flag |
| Scroll / stick-to-bottom | chat-page rAF | **PARTIAL** | Bottom threshold 10px; long stream needs QA |
| Incremental history | `useIncrementalList` 80+80 | **OK** | Performance baseline present |
| Persistence | session API | **OK** | Server-side |
| WebSocket connect | controller + gateway | **OK** | Disabled reasons in composer |
| Keyboard send | composer Enter | **OK** (assume) | Needs QA for Shift+Enter |
| Action bar visibility | hover/focus on bubble | **PARTIAL** | Mobile: hover weak; touch path relies on focus |
| Assistant lazy load | `React.lazy` | **OK** | Suspense fallback nearly invisible |
| Inspector | ChatInspector | **OK** | Separate panel |
| Context usage ring | composer | **OK** | |
| Model selector | header | **OK** | |

---

## 3. Bubble design findings (for Part 2)

1. **Weak hierarchy**  
   `appearance.css` defines distinct `--chat-user-*` and `--chat-assistant-*`, but `assistant-message.tsx` applies **user** tokens (`--chat-user-bubble/border/shadow`) on the main agent bubble. Agent and user can look nearly identical.

2. **Shared max width**  
   Agent uses `max-w-[var(--chat-user-message-max)]` instead of a dedicated agent width token.

3. **Typography**  
   User: `text-[14px] leading-5`, `whitespace-pre-wrap` (no markdown).  
   Agent: markdown path; thought/tool modes strip bubble chrome.

4. **Actions**  
   Hover-revealed bar; fine on desktop, weak on mobile/touch.

5. **Markdown surface**  
   Thin wrapper; no chat-specific prose classes for tables, blockquote, headings — risk of overflow and density issues.

6. **Code blocks**  
   Feature-rich; Part 2 should keep behavior, polish chrome only.

---

## 4. Confirmed gaps to fix in later parts

| ID | Issue | Severity | Target part |
|----|--------|----------|-------------|
| C1 | No **Stop generation** control while `isTyping` | High | 3 |
| C2 | Assistant bubble uses **user CSS variables** | High (visual) | 2 |
| C3 | Mobile action discoverability (hover-only) | Medium | 2–3 |
| C4 | Markdown prose overflow (tables, long URLs) | Medium | 2 |
| C5 | Edit-mode cancel / visual “editing” state | Medium | 3 |
| C6 | `isWorking` passed in places without composer stop UX | Medium | 3 |
| C7 | Scroll behavior under rapid streaming | Medium | 3 |
| C8 | Performance: full list re-render on each stream chunk | Medium | 3 |

Do **not** remove features; repair or complete them.

---

## 5. Part 1 conclusions

- Chat stack is modular and mostly complete at the API layer (send, stream, retry, delete, fork, sessions).
- Primary quality debt is **visual hierarchy of bubbles**, **markdown/code presentation**, **mobile actions**, and **missing stop-generation**.
- Performance already has incremental list (80 messages); stream updates still need memoization review in Part 3.
- Part 2 should redesign **UserMessage** + **AssistantMessage** (+ markdown/code chrome) using existing tokens, fixing C2/C4 without rewriting controller.
- Part 3 should wire stop generation, harden edit UX, scroll, and run live visual QA.

---

## 6. Next (Part 2) checklist

- [ ] Restyle user vs agent bubbles with correct token sets and hierarchy  
- [ ] Prose styles for MD tables, lists, code, links inside agent bubble  
- [ ] Overflow-safe long content  
- [ ] Preserve action bar APIs; improve mobile visibility  
- [ ] No new heavy dependencies  

*End of Part 1 audit.*
