# Troubleshooting Matrix

[README](README.md) | [Documentation](Documentation.md) | [Release Checklist](RELEASE_CHECKLIST.md)

| Area        | Symptom                            | First check                                 | Likely fix                                                             |
| ----------- | ---------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| Startup     | Gateway health times out           | `data/logs/**`, `CORE_PORT`, `GATEWAY_PORT` | Free the port, rebuild, or inspect core process stderr                 |
| Startup     | Full health is degraded            | `/api/enhancements/health/full`             | Inspect failed component and matching audit events                     |
| LiteLLM     | Model calls fail before request id | `LITELLM_MASTER_KEY`, LiteLLM port          | Set a valid key or disable LiteLLM-dependent routes for local smoke    |
| Models      | Provider returns auth error        | Credential store and provider dashboard     | Rotate/update provider API key and rerun a low-cost model check        |
| MCP         | Client cannot initialize           | `/mcp`, `ENABLE_MCP`, gateway auth          | Enable MCP and authenticate through the gateway before client setup    |
| MCP         | Tool call denied                   | Denial object in API response               | Grant the session permission or choose a lower-risk read-only tool     |
| Tools       | Shell/file tool blocked            | Workspace restriction audit event           | Keep path inside workspace or update policy intentionally              |
| Channels    | Probe says `needs_config`          | Probe `checks` and `failure_code`           | Fill missing required fields and rerun mock probe                      |
| Channels    | Live send skipped                  | `Hiro_CHANNEL_ALLOW_LIVE_SEND`           | Keep skipped for CI, enable only for manual production smoke           |
| Channels    | Webhook fails verification         | Provider signing secret and callback URL    | Fix token/secret mismatch and confirm gateway route is reachable       |
| Memory      | Context grows too large            | Run record context budget snapshot          | Lower max context settings or prune low-value memories                 |
| Jobs        | Dead-letter count increases        | Health page queue section                   | Inspect error, retry if transient, fix config if deterministic         |
| Performance | API latency smoke fails            | `output/release/api-latency-smoke.json`     | Check slow endpoint, startup budget, and recent bundle/runtime changes |
| Packaging   | `pack:check` fails                 | `npm pack --dry-run --json`                 | Remove unwanted files or update package file allowlist intentionally   |
