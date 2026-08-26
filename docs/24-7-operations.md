# Agent Miki 24/7 Operations Runbook

**Version:** 1.0

এই runbook Agent Miki-কে Windows বা Linux host-এ unattended ভাবে চালানোর জন্য। Repository-level scripts crash restart, boot registration, process cleanup, readiness checks, model smoke tests এবং soak observations সরবরাহ করে। **Credentialed third-party delivery, operating-system reboot, firewall/TLS, native Windows llama.cpp এবং multi-hour production soak-এর প্রমাণ target host-এই সংগ্রহ করতে হবে।**

## Operational contract

| Concern | Repository behavior | Evidence required on target host |
|---|---|---|
| Gateway crash | Node supervisor restarts the gateway with bounded exponential backoff; restart limit is configurable. | Kill only the gateway process, then show the supervisor log and healthy service state. |
| Boot/reboot start | Linux systemd user unit or Windows Task Scheduler task starts the supervisor. | Reboot the host and record service/task state plus dashboard health. |
| Process cleanup | Supervisor uses process-group control on Linux; Windows stop script uses `taskkill /T /F` only for the known supervisor command line. | Stop the service and confirm no matching supervisor/gateway processes remain. |
| Durable external delivery | Delivery records carry an idempotency key, deduplicate enqueue/replay, and preserve `unknown_outcome` until reconciliation. | Use a provider or test endpoint that records the key and verify retry does not create a second side effect. |
| Model smoke path | `npm run model:smoke -- --local` tests local llama.cpp/LFM; `npm run model:smoke -- --gemini` tests Gemini. | Configure an operator-owned model/key through environment or dashboard; never commit secrets. |
| Soak observation | `npm run soak -- ...` writes JSONL health, latency, RSS and Linux file-descriptor observations. | Run for at least one hour first, then repeat for the intended production duration. |

## Linux installation

Build the gateway first on the target host:

```bash
npm install
MIKI_LLAMA_BUILD_JOBS=1 npm run build:all
npm run runtime:24-7:check
```

Install the user service. `--enable-linger` is optional and should be used only when the user service must start without an interactive login:

```bash
./deploy/linux/install-systemd.sh --repo "$PWD" --workspace "$PWD" --enable-linger
systemctl --user status agent-miki.service
journalctl --user -u agent-miki.service -f
```

The generated unit uses `Restart=always`, `KillMode=control-group`, a bounded stop timeout, and explicit Miki workspace variables. It does not expose the gateway publicly; retain loopback binding unless a separately secured reverse proxy and CIDR policy are intentionally configured.

Run the safe host checks:

```bash
./deploy/linux/validate-host.sh
./deploy/linux/validate-host.sh --service-drill
```

The service drill restarts the user service and checks that it becomes active. It is not a reboot test. For a reboot test, record before-and-after output:

```bash
systemctl --user is-enabled agent-miki.service
systemctl --user is-active agent-miki.service
sudo reboot
# after reconnecting
systemctl --user is-active agent-miki.service
curl --fail http://127.0.0.1:18800/api/health
```

## Windows installation

From an elevated Windows PowerShell session, build the runtime:

```powershell
npm install
$env:MIKI_LLAMA_BUILD_JOBS="1"
npm run build:all
npm run runtime:24-7:check
```

Register the task under the local SYSTEM account. The script is written for Windows PowerShell 5.1 and does not use the PowerShell 7 null-coalescing operator:

```powershell
.\deploy\windows\install-task.ps1 -RepoRoot $PWD -WorkspaceDir "$PWD\data"
Get-ScheduledTask -TaskPath "\AgentMiki\" -TaskName "Agent Miki"
Get-ScheduledTaskInfo -TaskPath "\AgentMiki\" -TaskName "Agent Miki"
```

The task starts at boot and logon, while the supervisor performs in-process crash recovery. The runtime log is written to `data\supervisor.log`. Stop or unregister cleanly with:

```powershell
.\deploy\windows\stop-task.ps1 -TaskName "Agent Miki" -WorkspaceDir "$PWD\data"
.\deploy\windows\stop-task.ps1 -TaskName "Agent Miki" -WorkspaceDir "$PWD\data" -Unregister
```

Validate the host and optionally exercise the registered task:

```powershell
.\deploy\windows\validate-host.ps1 -RepoRoot $PWD -WorkspaceDir "$PWD\data"
.\deploy\windows\validate-host.ps1 -RepoRoot $PWD -WorkspaceDir "$PWD\data" -TaskDrill
```

The Windows validation script parses every deployment PowerShell file using the host parser, checks runtime files, confirms a writable workspace, reports disk headroom, and optionally starts/stops the scheduled task. It cannot honestly prove a reboot or native llama.cpp run without the real Windows machine.

## LFM and Gemini smoke tests

These are transport tests only. They send a short prompt and do not exercise a large agent workload.

For local LFM through a loopback llama.cpp OpenAI-compatible server:

```bash
MIKI_LOCAL_MODEL_ENDPOINT=http://127.0.0.1:8080/v1 \
MIKI_LOCAL_MODEL=lfm2-local \
npm run model:smoke -- --local
```

For Gemini, inject the key through the host environment or a secret manager:

```bash
GEMINI_API_KEY="$GEMINI_API_KEY" \
GEMINI_MODEL=gemini-3.5-flash-lite \
npm run model:smoke -- --gemini
```

The script never prints the API key. A successful result proves only that the selected transport and model path answered a bounded request. It does not prove tool calling, channel delivery, MCP behavior, voice transcription, or answer quality.

## Durable delivery and exactly-once boundary

Agent Miki’s durable delivery queue is **at-least-once**. A process crash after a provider accepts a request but before the local receipt is settled creates an `unknown_outcome` record. The queue deliberately refuses automatic replay of that record. An operator or provider lookup must reconcile it first:

```ts
queue.reconcile(receiptId, { status: "sent", providerMessageId: "..." });
```

Every external side-effect handler must send the persisted `idempotencyKey` in the provider’s supported idempotency field or implement an equivalent provider-side dedupe. A local queue alone cannot provide exactly-once external effects. If a provider has no idempotency support, keep the operation in a reviewable `unknown_outcome` state rather than pretending that a retry is safe.

## Soak testing

Run the health endpoint for a bounded period and retain the JSONL output as evidence:

```bash
npm run soak -- \
  --url http://127.0.0.1:18800/api/health \
  --duration-minutes 60 \
  --interval-seconds 30 \
  --output data/soak-60m.jsonl
```

For a real production qualification, repeat with the intended duration, inspect the RSS and file-descriptor series, and correlate failures with gateway logs. The harness reports observations; it does not replace a metrics backend, alerting service, or provider-side delivery audit.

## Acceptance checklist

A release is not considered fully validated until the target-host operator attaches evidence for each applicable row.

| Check | Pass condition | Status field |
|---|---|---|
| Build | `npm run build:all` completes on the target OS, including the native local runtime when required. | `build` |
| Readiness | `npm run runtime:24-7:check` reports the built gateway entrypoint. | `readiness` |
| Boot | Service/task is enabled, reboot is performed, and the dashboard health endpoint responds afterward. | `boot_recovery` |
| Crash | Gateway is terminated and is restarted by the supervisor without duplicate supervisors. | `crash_recovery` |
| Permissions | Service account cannot write to a deliberately protected directory and logs a clear failure. | `permission_failure` |
| Disk | Low-disk drill is run in a disposable environment and recovery behavior is recorded. | `disk_full` |
| Channels | Each credentialed provider test receives one intentional test message and records provider receipt details. | `channel_delivery` |
| Voice | whisper.cpp runtime/model processes a microphone or upload sample and returns a transcript. | `voice_stt` |
| MCP | External MCP auth, reconnect and side-effect policy are exercised against the approved server. | `mcp` |
| Network | TLS/reverse proxy, firewall and CIDR exposure are reviewed from an external client. | `network_security` |
| Soak | Multi-hour/day JSONL and log evidence has no unexplained failure or resource slope. | `soak` |
| Exactly-once | Provider-side dedupe or explicit operator reconciliation evidence exists for every side-effect handler. | `side_effects` |

## Stop conditions and rollback

If the gateway repeatedly crashes, the supervisor writes a restart-exhaustion marker when a finite restart limit is configured. Stop the service, preserve `data\supervisor.log` or the systemd journal, correct the underlying configuration, and restart deliberately. Do not delete queue, audit, or receipt files as a first response; they are the evidence needed to reconcile incomplete side effects.
