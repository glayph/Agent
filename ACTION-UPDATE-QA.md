# Agent Miki — AI Action Update and Working Indicator QA

## Requirement

Routine fixed progress sentences must not appear in the chat. When Miki starts a tool-backed task, it should briefly state its immediate action in its own generated words. While the run is active, the top bar should show a small animated `🛠️` indicator; when the run ends, the indicator should disappear.

## Implementation

The backend no longer sends the fixed Bengali accepted/progress sentences. The model prompt now requests one short natural action sentence before a tool call. The agent loop emits the model's pre-tool text as an `action_update` event and excludes that pre-tool text from the final answer and persisted assistant history. The API trims the action update to the first sentence and at most 12 words without inventing replacement text.

The frontend supports an `action_update` message kind and renders it as a compact tool-style bubble. The run lifecycle sets `isTyping` true at `node.run_start` and false at `node.run_end`. `WorkspaceHeader` receives that state and shows an animated `🛠️` button only while work is active, with reduced-motion support and Inspector navigation on click.

## Visual E2E

After rebuilding and restarting the runtime, a browser task was submitted asking Miki to open the official MDN video reference page and report its title. While the task was running, the dashboard showed `Running`, `1 active agents`, the animated `🛠️` icon in the top bar, and the live activity node `Running tool: browser_navigate`. Miki generated the short action sentence: `আমি ব্রাউজারের মাধ্যমে MDN-এর ভিডিও এলিমেন্ট পেজটি খুলে তার শিরোনাম সংগ্রহ করব।`

After completion, Miki returned the page title in one short sentence. The dashboard changed to `Ready`, showed `0 active agents`, and the `🛠️` working indicator disappeared. No fixed `ঠিক আছে, কাজটি শুরু করছি।` or `প্রথম ধাপ চলছে; কাজের অগ্রগতি যাচাই করছি।` text was emitted by the new run.

## Regression result

Core TypeScript build passed. Frontend protocol tests, assistant-message tests, status tests, and frontend production build passed. The remaining final verification must include the complete repository verification, generated-file cleanup, commit, and GitHub publication.
