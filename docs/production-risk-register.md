# Agent Miki Production Risk Register

**Status:** Repository remediation complete; target-host certification pending.

| ID | Risk | Current mitigation | Residual evidence required | Release gate |
|---|---|---|---|---|
| R-001 | Provider rejects malformed tool history | Orphan tool results are normalized before OpenAI-compatible dispatch; regression tests cover valid and orphan sequences. | Run against every selected provider with real tool calls and inspect raw request/response correlation. | Must pass for the chosen production provider. |
| R-002 | Provider credential or quota failure | Errors are classified as credential, entitlement, rate-limit, timeout, or API failures; health watcher can alert. | Valid key rotation, quota exhaustion behavior, and fallback test on target host. | No silent fallback or false success. |
| R-003 | Local LFM model unavailable | llama.cpp adapter and host validation scripts exist. | Install the approved GGUF model and run text/tool smoke tests on Linux and Windows. | Required for local-only deployment. |
| R-004 | Public gateway exposure without TLS | Loopback is the default; non-loopback bind refuses without TLS termination or explicit lab override. | External-client TLS, proxy headers, firewall, CIDR and certificate-renewal drill. | Required before LAN/WAN exposure. |
| R-005 | Runtime state and source workspace diverge | Runtime paths expose source/runtime/config roots explicitly; supervisor passes them to the child process. | Verify shell/file tools, secrets, backups and logs on a clean target installation. | Required before multi-instance deployment. |
| R-006 | External side effect is duplicated after crash | Durable queue retains `unknown_outcome`; idempotency keys are persisted and handlers must pass them to providers. | Provider receipt/idempotency audit with forced crash after provider acceptance. | Required for every side-effect handler. |
| R-007 | OS boot/reboot/crash behavior differs from sandbox | systemd and Task Scheduler installers, stop scripts and host harnesses exist. | Clean Linux and Windows reboot, crash, process-tree and permission drills. | Required for unattended operation. |
| R-008 | STT runtime/model/audio device fails | Speech-to-text configuration and acceptance workflow exist. | Whisper.cpp model install plus microphone and upload transcript validation. | Required only when voice features are enabled. |
| R-009 | Long-run resource leak or missed alert | Soak harness records health, latency, RSS and file descriptors; health watcher writes JSONL alerts. | Six-hour and overnight soak with alert backend and log retention. | Required for 24/7 production. |
| R-010 | Backup restore is incomplete or unsafe | Backup manifest checksums, retention and rollback pre-backup are implemented; path containment is enforced. | Restore drill on a disposable copy, including corrupted manifest and disk-full recovery. | Required before persistent user data is enabled. |

A production release must not mark a row complete based solely on the existence of a script. The evidence column must contain a timestamp, host identifier, command/output artifact, and operator disposition. Rows that do not apply must be explicitly marked `N/A` with a reason.
