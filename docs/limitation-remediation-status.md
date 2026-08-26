# Agent Miki Limitation Remediation Status

## Scope

This document records the repository-level remediation completed in the current pass and the validation still required on real target hosts. It deliberately does not contain credentials, tokens, passwords, private responses, or private file contents.

## Completed repository remediation

| Area | Completed change | Evidence |
|---|---|---|
| Provider policy | Legacy provider type/labels were constrained to Gemini and llama.cpp; unsupported models are reported explicitly. | Core typecheck and canonical verification pass. |
| Plugin runtime | Node and Python runtime paths are policy-gated; Python interpreter selection is host-aware; escaped symlink entrypoints are rejected. | Provider/plugin runtime tests pass. |
| Archive safety | Tar extraction enforces entry-count and expanded-byte limits in addition to path and symlink checks. | Extractor regression test passes. |
| Plugin registry | Registry snapshots use fsync, atomic rename and restrictive file mode. | Installer build and tests pass. |
| Governance | Skill governance is enabled in the active configuration with default rules for destructive deletion, shell review and external browser actions. | Governance regression tests pass. |
| Session list performance | `/sessions` uses SQL-backed summary pagination instead of loading every transcript before slicing. | Session-store and session-router tests pass. |
| Observability | JSON metrics now include active sessions and collector data; authenticated Prometheus-style metrics are available at `/metrics/prometheus`. | Core typecheck and canonical verification pass. |
| Public exposure | Non-loopback gateway binding requires explicit public-bind opt-in and a non-empty CIDR allowlist. | Gateway typecheck pass; public deployment remains target-host work. |

## Validation completed

The following checks passed after the changes:

- `npm run verify`
- Core typecheck
- Gateway typecheck
- Provider/plugin runtime and installer tests
- Channel, voice/STT, MCP, runtime-consent and plugin readiness tests
- Session-store SQL pagination tests
- Linux deployment script syntax checks
- Staged whitespace check
- Staged high-confidence secret-pattern scan with zero matches

## Target-host validation still required

The following cannot be honestly certified from a Linux sandbox alone:

1. Linux systemd install, boot start, crash recovery, reboot recovery, permission failure and disk-full behavior.
2. Windows PowerShell parsing, Task Scheduler registration, boot start, reboot recovery, process-tree cleanup and native Windows llama.cpp.
3. Real channel delivery for Telegram, Discord, Slack, WhatsApp or other integrations, because credentials and provider endpoints are environment-specific.
4. Facebook/YouTube automation, because adapters, scopes, quotas and credentials are not configured by default.
5. Voice/STT, because a whisper.cpp model and runtime must be installed and exercised on the target host.
6. External MCP server authentication, reconnect and side-effect policy.
7. Multi-hour/day soak testing, remote-LAN exposure, TLS/reverse-proxy configuration and production alert routing.
8. Exactly-once external side effects. Persistent jobs remain at-least-once and handlers must use idempotency keys.

## Target-host acceptance rule

A limitation is considered closed only when both repository tests and the corresponding target-host evidence exist. A generated deployment script or a passing local build is not a substitute for a real OS reboot, credentialed integration test or long-running soak.
