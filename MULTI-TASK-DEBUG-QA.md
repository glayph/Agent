# Multi-task debug QA

## Video playback task — initial state

The task was submitted through the dashboard chat in Bengali. Agent Miki accepted it and emitted a progress message equivalent to “Okay, starting the task,” while the UI changed to `Running` with one active agent. The final result is not available yet. The task explicitly prohibited login, download, and external side effects.

The video task completed in the chat UI, but the result is mixed. Inspector Response contains a direct Big Buck Bunny MP4 URL (`https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4`), title `Big Buck Bunny`, and a claim that the browser played it. However, the same inspector response also contains the earlier safe-stop text `I could not produce a final answer for this turn`, and the normal chat preview initially showed only the opening portion. The next step is to inspect Work/Evidence/Events to distinguish real browser playback from an unsupported claim and verify whether link rendering is handled by the frontend.

Inspector verification found a concrete reliability issue: the Evidence tab says `No verifier evidence or checkpoints yet`, and the Work tab says `No work nodes are available yet`. Therefore, the agent’s claim that the browser actually played the video is not independently evidenced by the run inspector. The response includes a valid-looking public MP4 URL, but backend execution observability did not record browser/tool checkpoints for this task.

Independent verification of the reported MP4 URL failed: the Google Cloud Storage URL returned `AccessDenied` and no native video player loaded. This means the agent’s “play succeeded” claim was incorrect or unverified. Combined with the empty Work/Evidence inspector tabs, this is a confirmed bug in task verification and/or tool execution reporting. The agent must not report playback success without a browser checkpoint such as loaded media metadata and a verified playing state.

## Video playback fix

Root causes were confirmed in source: BrowserTool always aborted `resourceType === "media"`, the configured Chromium path was ignored by `_launchPlaywright()`, and the isolated browser worker had no media command. Fixes added an `allowMedia` configuration (enabled by default), system Chromium fallback including Windows paths, a dedicated `browser_play_media` tool with verified `readyState`, `paused`, `currentTime`, and `duration` checks, and isolated-worker support for the new command. After rebuilding core, an isolated E2E test successfully played the public MDN Flower MP4 with `readyState: 4`, `paused: false`, and duration about 5 seconds.

After adding the media tool, the Agent Miki runtime restarted successfully on the same gateway/core ports. The dashboard required re-authentication; the configured password was entered successfully and the login button is ready. The next test will submit a task explicitly asking Agent Miki to use `browser_play_media` and report the returned verification object.

## Dedicated media-tool retest

After runtime restart, Agent Miki accepted a task explicitly requiring `browser_play_media` with the reliable MDN Flower MP4 URL and strict verification criteria. The UI showed `Running` with one active agent and a progress message. The final tool result is pending; this retest checks whether the new tool is actually exposed to the model and whether its verified JSON is reflected in the final answer.

The dedicated media-tool retest remained `Running` with one active agent after two observation intervals and produced only progress messages, not a final answer. This suggests either the model did not call the new tool, the tool call is blocked/stalled in the current runtime, or the chat runner is not persisting tool execution nodes. Further backend logs and run events must be inspected before declaring success.

The retest now exposes a real Work node: `browser_navigate` completed in about 19 seconds and navigated to the MDN Flower MP4 URL. This confirms the new runtime exposes browser execution telemetry, unlike the earlier task. Playback verification is still pending because the current Work node only proves navigation, not `browser_play_media` success.

The retest remained stuck after the completed `browser_navigate` node; no `browser_play_media` node appeared after additional observation intervals. The run therefore still does not complete the requested playback task even though the lower-level isolated BrowserTool E2E succeeded. This points to agent orchestration/tool-selection or run finalization behavior, not the media engine itself.

After adding the explicit media-request rule to the adaptive selector and rebuilding/restarting the runtime, a fresh dashboard task successfully exposed and completed `browser_play_media`. The run advanced past navigation, confirming the selector fix solved the orchestration gap. The detailed Inspector payload remains the source of truth for the verification fields; progress-only chat text is not treated as proof.

Inspector Work evidence for the successful run recorded: `verified: true`, media tag `video`, source `https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4`, `readyState: 4`, `paused: false`, `currentTime: 0.000308`, and `duration: 5.055` seconds. This is independently verifiable playback evidence. The UI still showed the run as active immediately after the tool completion, so final-response finalization remains a separate behavior to observe and test.

The same payload is persisted in Inspector Evidence as a `browser_play_media` checkpoint, with the request URL and the complete verification object. This closes the earlier observability defect: a playback claim now has a durable Work/Evidence record. The agent run remained `Running` for several seconds after this checkpoint, so the final narrative response path is slower than tool execution but no longer lacks proof.

The run then finalized normally. The chat returned the same MDN Flower direct URL, and the Inspector response contained the verified playback statement only after the tool checkpoint. Dashboard status changed to Ready with zero active agents, confirming that the previous post-tool finalization delay was transient rather than a stuck run.

A negative actual-browser E2E against a non-existent MP4 initially exposed two browser-native viewer edge cases (`style` and `load`/`play` methods absent). BrowserTool now guards those methods and returns a clean `verified:false` result: `Current page does not expose a playable media element`. The valid MDN Flower E2E still passes with `verified:true`, `readyState:4`, `paused:false`, and duration `5.055` seconds. The isolated worker forwarding test also passes.

For independent link sharing, Agent Miki executed `web_search` with query `MDN Web Docs HTML video element`. Inspector Evidence shows a native provider response and the direct result URL `https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video` titled `HTML video embed element - HTML | MDN - MDN Web Docs`. The completed response later rendered two tool-originated direct MDN URLs as clickable links; no guessed URL was introduced.


After the controller negation fix and runtime reload, a fresh chat task returned the exact Markdown YouTube URL without opening a connection flow. The dashboard visually rendered a clickable `Big Buck Bunny on YouTube` link and a preview card containing the thumbnail `https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg`, provider label `YouTube`, and title `Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film`. The backend direct E2E returned the same title, provider, thumbnail, and site name `Blender` through YouTube oEmbed. The first false-positive connection setup was fixed by making connection-intent detection boundary- and negation-aware; targeted controller tests passed.

An earlier YouTube share run appended a generic safe-stop sentence after the exact response. This was diagnosed as a core finalization fallback bug for concise content without a completion phrase and was subsequently fixed and regression-tested; the fresh minimal-link run had no appended safe-stop text.


After the core finalization fix, a fresh minimal-link task returned exactly `[MDN HTML video element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video)` and the run finished Ready with zero active agents. No generic safe-stop fallback was appended. The dashboard rendered the URL as a clickable anchor. This confirms concise no-tool final responses now terminate normally.


A read-only workspace task was also verified in the dashboard. Agent Miki used the `file_read` tool, returned project name `miki`, and reported the available `build` script as `npm run build`. The run reached Ready with zero active agents and no write/edit/delete operation was performed.


A safe-failure integration task asked Agent Miki to inspect `https://example.invalid/` once and report truthfully. Inspector showed the browser task ran, and the response correctly reported navigation failure because `.invalid` is a reserved non-resolving domain; it did not claim the page loaded and did not retry. The run completed Ready with zero active agents.


A browser navigation/extraction task was verified end to end. Agent Miki used `browser_navigate` on the official MDN `<video>` page and returned the extracted page title `<video> HTML video embed element - HTML | MDN` plus the fact that the element embeds a media player for video playback. Inspector marked Browser Navigate completed and the run finished Ready.
