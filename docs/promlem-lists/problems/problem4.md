
### 34. Config command-pattern tester route is missing from the actual Node runtime

- **Status:** ✅ Fixed
- Evidence:
  - `packages/ui/frontend/src/components/config/config-sections.tsx:985` posts to `/api/config/test-command-patterns`.
  - `packages/ui/backend/api/config.go:24` registers `POST /api/config/test-command-patterns` only in the legacy Go backend.
  - `packages/core/src/api/launcher-compat.ts:5198-5267` exposes `/config`, `/config/validate`, `/config/reset`, but no `/config/test-command-patterns`.
  - `packages/core/src/api/index.ts:505` mounts `launcherCompatRouter` under `/api`, making the Node compatibility router the dashboard API runtime.
- **Fix:** Added `POST /api/config/test-command-patterns` endpoint in `packages/core/src/api/launcher-compat.ts:5258-5324` to match the Go backend functionality for testing command patterns against allow and deny lists.
- Impact: the Exec config "test command patterns" action can never work in the bundled Node runtime. The implementation exists only in the stale Go backend.
- Recommended fix: implement `POST /api/config/test-command-patterns` in `launcher-compat.ts` with the same allow/deny matching semantics, and call it through `launcherFetch` so auth redirects and errors are handled consistently.

### 101. Error handling inconsistencies between Go and TypeScript skill APIs

- **Status:** ✅ Fixed
- Evidence:
  - `packages/ui/backend/api/skills.go` uses inconsistent error response formats (some use `http.Error()`, some use JSON)
  - `packages/core/src/skill-api.ts` uses different error response structure than Go backend
- Impact: Inconsistent error responses make frontend error handling difficult and user experience inconsistent
- **Fix:** Added `sendJSONError()` helper function in `skills.go:111-124` for standardized JSON error responses with `success: false`, `error`, and `detail` fields. Updated all skill API handlers in Go backend to use this helper. Updated TypeScript skill-api.ts to use shared utility functions from `skill-utils.ts`.

### 102. Skill installation race conditions in Go backend

- **Status:** ✅ Fixed
- Evidence:
  - `packages/ui/backend/api/skills.go:102` uses `sync.Mutex` for `workspaceSkillWriteMu`
- Impact: Concurrent skill operations can block each other unnecessarily, reducing performance
- **Fix:** Changed `sync.Mutex` to `sync.RWMutex` in `skills.go:102` to allow concurrent read operations while protecting write operations.

### 103. Search functionality gaps across skill registries

- **Status:** ✅ Verified - Already Implemented
- Evidence:
  - `packages/ui/backend/api/skills.go:228-297` implements pagination with limit/offset
  - `packages/ui/backend/api/skills.go:238` uses `registryMgr.SearchAll()` for multi-registry search
  - `packages/core/src/skill-api.ts:174-200` implements search with keywords, category, tags, and limit
- Impact: Search functionality is already comprehensive with pagination and multi-registry support
- **Fix:** No changes needed - functionality already properly implemented.

### 104. Skill metadata validation during import

- **Status:** ✅ Fixed
- Evidence:
  - `packages/ui/backend/api/skills.go:775-809` only validates skill name format
- Impact: Invalid skill metadata (description, category, tags, version, author) can be imported, causing runtime errors
- **Fix:** Added comprehensive `validateSkillMetadata()` function in `skills.go:811-886` that validates name, description, category, tags, version, and author fields with proper length limits, character validation, and semantic versioning checks. Integrated validation into `importUploadedMarkdownSkill()` at line 938.

### 105. Cache invalidation after skill changes

- **Status:** ✅ Fixed
- Evidence:
  - `packages/core/src/skill-loader.ts:195-197` only has manual `refreshCache()` method
- Impact: Skill changes require manual cache refresh, leading to stale data being displayed
- **Fix:** Added automatic file watcher in `skill-loader.ts:26-27, 198-227` that watches the skills directory for changes and automatically invalidates cache when files are modified. Includes 500ms debouncing to handle rapid file changes.

### 106. Code duplication in skill error handling

- **Status:** ✅ Fixed
- Evidence:
  - Both Go and TypeScript skill APIs have duplicate error handling logic
  - Similar validation and normalization code across multiple files
- Impact: Maintenance burden and risk of inconsistencies between implementations
- **Fix:** Created shared utility file `packages/core/src/skill-utils.ts` with common functions: `createSuccessResponse()`, `createErrorResponse()`, `validateSkillName()`, `normalizeSkillName()`, `validateSkillMetadata()`, `debounce()`, and `safeJsonParse()`. Updated `skill-api.ts` to use these shared utilities, reducing code duplication significantly.

### 107. Limited testing coverage for TypeScript skill components

- **Status:** ✅ Fixed
- Evidence:
  - TypeScript skill components have limited test coverage compared to Go backend
- Impact: Higher risk of bugs and regressions in TypeScript code
- **Fix:** Added comprehensive test suite in `packages/core/src/skill-utils.test.ts` with 20+ test cases covering all utility functions including response creation, validation, normalization, debouncing, and JSON parsing.

### 35. Agent Runs create and replay only record inert pending runs

- Evidence:
  - `packages/ui/frontend/src/components/agent/runs/runs-page.tsx:217` sends Create run through `createAgentRun`.
  - `packages/ui/frontend/src/components/agent/runs/runs-page.tsx:253` sends Replay run through `createAgentRun(buildReplayRunPayload(run))`.
  - `packages/core/src/api/enhancement-router.ts:202-229` handles `POST /agent/runs` by validating input and calling `runRecorder.create`.
  - `packages/core/src/agent-run.ts:478-514` creates run steps with `status: "pending"`.
  - `packages/core/src/agent-run.ts:519-528` saves and returns the run graph without calling `AgentOrchestrator.runAgentLoop` or enqueueing a worker.
  - `packages/core/src/api/enhancement-router.ts:90-101` creates the router with only `workspaceDir`; it has no orchestrator or queue dependency.
- Impact: users can click Create run or Replay run and see a new run, but nothing executes. The UI looks like an agent launcher while the backend only creates a static trace template.
- Recommended fix: either relabel this flow as a manual run template, or wire create/replay into a real agent queue/runner and update run steps from execution events.

### 36. Chat image attachments are displayed but not sent as multimodal model input

- Evidence:
  - `packages/ui/frontend/src/components/chat/chat-page.tsx:53-75` accepts image files up to 7 MB and reads them as data URLs.
  - `packages/ui/frontend/src/components/chat/chat-page.tsx:747` stores image attachments for the outgoing user message.
  - `packages/ui/frontend/src/features/chat/controller.ts:343-363` sends image attachments as `media: attachments.map(url)` over the hiro websocket.
  - `packages/core/src/api/index.ts:819-855` receives `payload.media` and converts it into plain text with `Attached media:\n${media.join("\n")}`.
  - `packages/config/src/types.ts:7-13` defines `ChatMessage.content` as string-only.
  - `packages/core/src/agent.ts:840-888` casts string-only chat messages into OpenAI chat completion params.
- Impact: the UI accepts and previews image attachments, but the model receives only text references/data URLs instead of actual image content parts. Vision requests appear supported while they are effectively text-only.
- Recommended fix: add provider-aware multimodal content support for images, or disable/hide image attachment controls for transports that cannot send image parts.
