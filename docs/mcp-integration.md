# External MCP Integration

Agent Miki can discover and invoke tools from configured external Model Context Protocol (MCP) servers over stdio, Streamable HTTP, or SSE. External servers are disabled by default in the repository configuration (`servers: {}`), and no connector credentials are included in source control.

## Authentication

For stdio servers, credentials should be supplied through the process environment or an explicitly configured environment file. For HTTP and SSE servers, static headers are supported for local configuration, while `header_env` is preferred for secrets:

```yaml
runtime:
  mcp:
    enabled: true
    servers:
      example:
        type: http
        url: https://mcp.example.test/mcp
        header_env:
          Authorization: MIKI_MCP_AUTH
```

The value of `MIKI_MCP_AUTH` is read only at runtime and is never written to `tools.yaml`, logged, placed in a URL, or included in diagnostic messages. URL-embedded username/password credentials are rejected. Use the provider’s documented authentication method and least-privilege scope; HTTP MCP authorization is a transport-level concern in the official specification, while stdio deployments should obtain credentials from the environment.[1]

External connector configuration is separate from the Manus connector inventory. A user-provided connector may be configured through the supported connector workflow, but this repository does not invent endpoints, OAuth clients, scopes, or credentials. A real provider authentication test requires a user-owned connector or target-host environment variable and is not performed by the credential-free test suite.

## Reconnect behavior

MCP tool discovery (`tools/list`) and calls classified as read-only get one reconnect attempt after a transport failure. The existing client is closed, its tool references are retained, and a fresh client/transport is created before the retry. This is intentionally bounded to prevent retry storms.

Non-read-only calls are never automatically retried after a transport failure. The result may have reached the external server even when the client lost the response, so Agent Miki reports an **unknown side-effect outcome** and requires reconciliation instead of risking duplicate execution. This follows the practical distinction between safe read-only refreshes and uncertain external mutations.

## Side-effect validation

MCP tool annotations are treated as hints, not guarantees. The official MCP guidance states that clients should treat annotations from untrusted servers as untrusted and keep deterministic controls at the host/runtime boundary.[2] Agent Miki therefore applies the following policy before an external call:

| External tool metadata | Runtime behavior |
|---|---|
| `readOnlyHint: true` without contradictory destructive/idempotent hints | Allowed and eligible for one reconnect/retry. |
| `readOnlyHint: false`, `destructiveHint: true`, or `idempotentHint: true` | Classified as a possible side effect; blocked unless the server has explicit `allow_side_effects: true`. |
| No usable annotation | Classified as unknown and blocked by default. |
| Side-effect call that fails after dispatch | No automatic retry; outcome is reported as unknown. |

`allow_side_effects: true` is an explicit operator opt-in for a configured server, not a claim that the server is trusted or that delivery is exactly-once. Users should still keep a human approval boundary for sensitive tools and use provider-side idempotency keys where available. MCP’s own tools guidance recommends human ability to deny sensitive invocations, input validation, timeouts, audit logging, and output validation.[3]

## Test coverage

The repository tests cover environment-backed authentication header resolution, URL credential rejection rules, default-deny side-effect policy, read-only reconnect/retry behavior, no-retry behavior after uncertain side effects, configuration parsing, discovery, and session permissions. The tests use fake values and do not call a real external MCP server.

## What remains target-dependent

Real authentication, OAuth refresh, provider-specific scopes, external server reconnect under network loss, and side-effect reconciliation require a real MCP server and user-owned credentials. No external server is currently configured in this project session, so no real connector call or external mutation is claimed. Exactly-once external delivery also remains provider-dependent; the local runtime prevents duplicate retries after an uncertain side effect but cannot retroactively prove whether a remote server committed the first request.

## References

[1]: https://modelcontextprotocol.io/specification/draft/basic/authorization — **Model Context Protocol Authorization**, official transport-level authorization guidance.

[2]: https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/ — **Tool Annotations as Risk Vocabulary: What Hints Can and Can’t Do**, official MCP project blog.

[3]: https://modelcontextprotocol.io/specification/draft/server/tools — **Model Context Protocol Tools**, official tool invocation and security guidance.
