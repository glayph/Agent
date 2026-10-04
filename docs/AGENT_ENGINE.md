# Agent engine (`@miki/core/engine`)

The engine runs one agent turn end to end and is transport-agnostic. The gateway
(`packages/gateway/src/agent-runtime.ts`) wires it to HTTP and WebSocket.

```
Observe -> Plan -> [ model turn -> tool calls -> results ]* -> Verify/limits -> Answer
```

## Pieces

| File | Responsibility |
| --- | --- |
| `engine/agent-engine.ts` | Run loop, tool-call lifecycle, budgets, loop protection, cancellation, events |
| `engine/planner.ts` | Goal analysis (English + Bengali), LLM planning with a deterministic fallback |
| `engine/tool-registry.ts` | Dynamic tool registration, JSON schemas for the model |
| `engine/approval-store.ts` | Approval queue for agent tool calls and typed control operations |
| `engine/builtin-tools.ts` | Workspace tools (sandboxed), memory tools, control tools |
| `engine/llm-client.ts` | OpenAI-compatible client (fetch) and adapter for the provider registry |

## Tool-call lifecycle

`requested -> (awaiting_approval) -> running -> succeeded | failed | denied | blocked | cancelled`

Every state change is emitted as a `tool.call` event. Every `tool_call` id the
model produces always receives a result message, including blocked and skipped calls.

## Safety properties (covered by tests)

* Risky tools (`risk != read`) require approval; with no approval channel they are denied, never executed.
* Approvals expire (10 min), are single-use for control operations, and are bound to the exact input.
* Identical repeated calls are blocked after 2 attempts; 3 blocked calls in a row end the run.
* Limits: 12 turns, 40 tool calls, 60 s per tool (env: `MIKI_AGENT_MAX_TURNS`, `MIKI_AGENT_MAX_TOOL_CALLS`).
* Workspace tools reject `..`, absolute paths and symlinks leaving the workspace, and refuse `.env`, vault, key and database files.
* Tool output is redacted for credential shapes before the model sees it.
* Tool output is untrusted data (system prompt says so).

## Rule 1 (dynamic messages)

The engine never writes user-facing text. Answers come from the model. When the
model cannot answer (provider error, empty wrap-up) the run ends with an empty
answer and an error state; the gateway reports it through `node.run_end.error`.

## HTTP surface (gateway, session-cookie auth)

* `GET /api/control/capabilities | state | operations`
* `POST /api/control/plan`, `POST /api/control/execute` (202 + `approval_required` when approval is needed; re-send with `approvalRequestId`)
* `GET /api/control/approvals`, `POST /api/control/approvals/:id/approve | deny`
* `GET /api/test` (readiness, no model call), `POST /api/test {prompt, tools?, model?}` (one real run)
* `GET|DELETE /api/tasks/:id` (stop button), WebSocket `cancel_task`

## Tests

```bash
npm run test:agent-core      # unit tests for the engine (47)
npm run build --workspace=@miki/core && npm run build --workspace=@miki/gateway
npm run smoke:agent-core     # end-to-end through the real gateway (17 checks)
```
