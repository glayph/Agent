# Agent Control API

All control routes are authenticated through the existing core HTTP boundary. The API returns sanitized data only.

## Inspect capabilities

```http
GET /api/control/capabilities
```

Use this before making a management request. The response lists capability IDs, actions, risk class, supported platforms, approval requirements, and limitations.

## Inspect state

```http
GET /api/control/state
```

This returns the dashboard-backed configuration, tool state, model/provider state, runtime metadata, and bounded control journal count. Credential-like fields are redacted.

## Preview a configuration change

```json
{
  "capability": "config",
  "action": "preview",
  "input": {
    "patch": {
      "agent": {
        "resource": {
          "mode": "eco"
        }
      }
    }
  }
}
```

Send the payload to `POST /api/control/plan` or `POST /api/control/execute`. Only allowlisted configuration prefixes are eligible for autonomous control, and the existing runtime schema remains authoritative.

## Change a tool state

```json
{
  "capability": "tool_state",
  "action": "set",
  "input": {
    "name": "web_search",
    "enabled": false
  }
}
```

The operation delegates to the existing launcher admin controller, reloads supported runtime state, and reads state back for verification.

## Model/runtime inspection and activation

```json
{
  "capability": "model_runtime",
  "action": "health",
  "input": {
    "adapter": "llama.cpp",
    "model": "llama.cpp/local-model"
  }
}
```

The built-in llama.cpp adapter delegates to the existing local runtime health and synchronization functions. It does not download arbitrary GGUF files or native binaries. Model installation/removal and service-affecting actions require a registered adapter and approval.

## Approval flow

Pending requests are available to the authenticated dashboard at `GET /api/control/approvals`, and an operator can approve or deny them with `POST /api/control/approvals/:id/approve` or `POST /api/control/approvals/:id/deny`. These routes reuse the existing persisted approval inbox and the same session-aware HTTP boundary as the control API.

A protected operation first returns `202` with `status: "approval_required"` and a non-secret `request_id` in evidence. An authenticated operator approves the request through the existing approval inbox. The operation can then be retried with the same immutable plan and `approvalRequestId`. The approval is checked against operation context and consumed once immediately before the protected mutation. Raw worker tokens are never stored in the control journal or returned by the control API.

## 24/7 operation boundary

The control service is in-process and workspace-aware. For Linux and Windows, keep the existing launcher/supervisor process online and configure the operating system to restart it after failure. The repository’s existing `runtime:24-7` and `runtime:24-7:check` commands remain the readiness entrypoints. A healthy process does not imply that a provider credential, native local runtime, channel adapter, or external MCP server is available; those are reported separately.
