# Agent Miki — 24/7 Readiness Handoff

**Status:** 24/7-ready foundation completed; production deployment remains an operator step on a persistent host.

## What is complete

The project now has a bounded local-model strategy, workspace-only security defaults, deterministic verification for common multi-step file workflows, persistent task and scheduler databases, and a restartable supervisor path. The stable local profile uses LFM2.5 1.2B because the available sandbox memory is not sufficient for reliable Gemma tool-use sessions. Gemma remains available as an opt-in profile for a larger machine.

The runtime supervisor is available through `npm run runtime:24-7`. It uses a lock file to prevent duplicate supervisors, persists status under `data/24-7-supervisor.json`, performs gateway readiness checks, restarts failed gateway processes with bounded exponential backoff, and stops after a finite restart budget unless an operator explicitly enables unlimited restarts. The supported Linux deployment path is `scripts/install-systemd.sh` together with the units in `deploy/systemd/`.

## Current verified behavior

| Area | Result |
|---|---|
| Core and gateway build | Passed |
| ESLint on modified runtime and workflow files | Passed |
| Deterministic intent and security tests | 31/31 passed |
| Previously completed full core suite | 113 suites and 723 tests passed |
| Dashboard health | `HTTP 200 OK` on `127.0.0.1:18800` |
| Local model | LFM2.5 1.2B, loopback llama-server |
| Workspace folder/file verification | Passed with exactly five numbered entries |
| Security bypass | Disabled (`bypass_restrictions: false`) |

## Recommended production architecture

Use a persistent Linux host rather than the temporary sandbox. Keep the gateway, core, local model server, scheduler, memory database, and health timer as separate supervised services. Store `data/`, `logs/`, and the model files on persistent storage. Expose the dashboard through an authenticated HTTPS reverse proxy only after the local deployment is healthy.

```text
Persistent Linux host
├── miki.target
│   ├── miki-memory.service
│   ├── miki-llama.service
│   ├── miki-core.service
│   └── miki-gateway.service
├── miki-health.timer → miki-health.service
├── persistent data/ and logs/
└── HTTPS reverse proxy with authentication
```

## Installation on the persistent host

1. Copy the project to a persistent directory and install dependencies.
2. Build the project with `npm run build:all`.
3. Review `deploy/systemd/miki.env.example` and set absolute model paths, workspace paths, API secrets, and the selected model.
4. Install the systemd stack with `sudo scripts/install-systemd.sh install`.
5. Start it with `sudo scripts/install-systemd.sh start`.
6. Confirm status with `sudo scripts/install-systemd.sh status`.
7. Confirm the local health endpoints before adding a reverse proxy.

The service should not be exposed publicly until authentication, allowed origins, restricted network policy, and HTTPS are configured. Do not set unrestricted wildcard origins or disable the workspace security boundary.

## Runtime policy

The default recovery policy is intentionally bounded:

- Maximum automatic restarts: 5.
- Restart delay: bounded exponential backoff, capped at 60 seconds.
- Readiness timeout: 45 seconds by default.
- Restart counter resets after a stable running period.
- Unlimited restarts require an explicit emergency override.
- A failed task enters a recoverable or dead-letter state instead of retrying forever.

This prevents a model crash, corrupted configuration, or repeated permission failure from consuming all CPU and memory continuously.

## Safe autonomy boundary

The agent may autonomously perform low-risk, workspace-scoped work such as reading files, creating reports, running tests, and verifying generated artifacts. It must not silently perform destructive deletion, credential changes, purchases, public posts, account-security changes, legal/medical/financial submissions, or external side effects. Those operations require an explicit approval gate.

Every multi-step file workflow must verify path existence, file type, expected content, and the final invariant before reporting success. Model text alone is not accepted as proof of completion.

## Monitoring and recovery

Check these artifacts during operations:

- `data/24-7-supervisor.json` — supervisor state and restart count.
- `data/core_backend.log` — core runtime errors and tool activity.
- `data/task-queue.db` — durable task state.
- `data/scheduled-tasks.db` — scheduler state.
- `data/audit.db` — security and operation audit records.
- `logs/` — systemd service logs when deployed on Linux.

If the supervisor enters `failed`, inspect the last failure reason before increasing restart limits. Do not enable unlimited restarts as the first response. Validate model path, available memory, permissions, and the local model health endpoint first.

## Known limitations

The temporary sandbox is not a guaranteed 24/7 host: it can hibernate, reset, or terminate long-running processes. The current LFM model is reliable for bounded local tasks but is not a replacement for a larger planning model on complex research or long tool chains. Public access is intentionally not enabled by default. A persistent host, stronger model capacity, and an authenticated reverse proxy are still required for production-grade operation.

## Next steps

### Required before real 24/7 operation

1. Move the project to a persistent Linux host or an always-on managed deployment.
2. Run the systemd installation and confirm all services remain healthy after a reboot.
3. Configure a persistent backup for `data/`, `config/`, and task artifacts.
4. Set a strong API secret and keep it outside the project archive.
5. Configure HTTPS and authentication before remote access.
6. Run a 24-hour soak test with bounded task volume and inspect restart, memory, and dead-letter metrics.

### Recommended after the baseline is stable

1. Add a stronger model profile on a machine with adequate memory.
2. Add explicit task priorities and operator controls for pause, resume, retry, and dead-letter recovery.
3. Add alert delivery for gateway crashes, model health failures, restart exhaustion, and queue growth.
4. Add idempotency keys for every external integration.
5. Add backup restore drills and verify that interrupted tasks resume from checkpoints.
6. Add a small set of approved integrations only after their permissions and failure behavior are documented.

### Do not do

- Do not expose port 18800 directly to the internet.
- Do not set `bypass_restrictions: true`.
- Do not use wildcard CORS or unrestricted network allowlists.
- Do not enable unlimited restarts without diagnosing the root cause.
- Do not give a small local model unrestricted destructive tools.
- Do not treat a model response as verification of an external side effect.

## Acceptance checklist

A deployment is ready to be called operational only when all of the following are true:

- The host survives reboot and the Miki target starts automatically.
- The local model health check passes repeatedly for at least 24 hours.
- The gateway, core, scheduler, and health timer remain active.
- A controlled task survives a process restart and resumes from a checkpoint.
- A failed task reaches dead-letter after its retry budget.
- Workspace escape attempts are rejected.
- Destructive and external operations require approval.
- Backups restore into a clean test directory.
- Remote access is authenticated and encrypted.

Until this checklist is complete, describe the system as **24/7-ready foundation**, not as a guaranteed production 24/7 service.

## Useful commands

```bash
npm run runtime:24-7:check
npm run runtime:24-7
node scripts/miki-healthcheck.mjs --no-memory
npm run model:status
npm run verify
sudo scripts/install-systemd.sh status
sudo scripts/install-systemd.sh restart
```

Never place real secrets in the ZIP archive. Configure them through the host environment or `/etc/miki/miki.env` after deployment.
