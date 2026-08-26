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
| Linux systemd packaging | Installer requires built artifacts, supports an absolute `MIKI_NODE_BIN`, uses the distribution root for `MIKI_RUNTIME_ROOT`, keeps mutable state outside the application tree, and the unit uses valid systemd start-limit placement. | Isolated systemd install/start, crash restart, permission recovery, disk-full recovery, and rollback probes completed in the sandbox. A real clean-host reboot is still required. |

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

## Linux systemd probe evidence

An isolated service instance was installed with a dedicated service account, application root under `/opt`, state under `/var/lib`, logs under `/var/log`, and non-default loopback ports. The service reached `active` with gateway, core, and memory health status `200`. A SIGKILL of the service main process produced a new main PID and systemd restarted the control group; readiness returned after a bounded poll. Permission removal caused the service to become unavailable, and restoring ownership/mode `0750` returned health. A temporary 1 MiB tmpfs was filled to `100%`; the service became unavailable until the filesystem was unmounted and the workspace restored, after which health returned. The unit was then uninstalled and the unit file/enablement were removed while data preservation behavior was checked with privileged filesystem access.

The probe found and fixed three deployment defects: hardcoded `/usr/bin/node` did not work with version-manager-only Node, `MIKI_RUNTIME_ROOT` was incorrectly pointed at mutable state instead of the packaged distribution, and relocated Node CLI fallback was spawned through a shebang that required a `node` PATH entry. It also found that `StartLimitIntervalSec` and `StartLimitBurst` belonged in `[Unit]`, not `[Service]`, and that `PrivateTmp=true` is incompatible with `ReadWritePaths` under `/tmp`.

## Windows Task Scheduler remediation

The Windows installer now requires the built gateway/core distribution, resolves or accepts an absolute Node executable through `-NodeExecutable`/`MIKI_NODE`, persists that path in the protected environment file, and passes it explicitly to the supervisor. The supervisor no longer depends on the Task Scheduler service account PATH for the gateway launch. `SETUP.md` documents the elevated PowerShell install, health checks, crash/process-tree drill, restart-budget drill, rollback and reboot acceptance criteria.

This repository-side hardening was reviewed on Linux, but PowerShell parsing, Task Scheduler cmdlets, Windows service-account ACLs, Windows reboot behavior, process-tree cleanup and native Windows llama.cpp still require a real Windows host.

## Target-host validation still required

The following cannot be honestly certified from a Linux sandbox alone:

1. Real clean Linux host-এ systemd install, boot start এবং actual machine reboot recovery; sandbox-এ install, crash restart, permission failure, disk-full এবং rollback probes already completed.
2. Windows PowerShell parsing, Task Scheduler registration, boot start, reboot recovery, process-tree cleanup and native Windows llama.cpp; repository-side installer/supervisor preflight is updated, but no Windows runtime is available in the current sandbox.
3. Real channel delivery for Telegram, Discord, Slack, WhatsApp or other integrations, because credentials and provider endpoints are environment-specific.
4. Facebook/YouTube automation, because adapters, scopes, quotas and credentials are not configured by default.
5. Voice/STT, because a whisper.cpp model and runtime must be installed and exercised on the target host.
6. External MCP server authentication, reconnect and side-effect policy.
7. Multi-hour/day soak testing, remote-LAN exposure, TLS/reverse-proxy configuration and production alert routing.
8. Exactly-once external side effects. Persistent jobs remain at-least-once and handlers must use idempotency keys.

## Target-host acceptance rule

A limitation is considered closed only when both repository tests and the corresponding target-host evidence exist. A generated deployment script or a passing local build is not a substitute for a real OS reboot, credentialed integration test or long-running soak.
