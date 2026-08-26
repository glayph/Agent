# Agent Miki Production-Readiness Report

**Assessment date:** 26 August 2026
**Repository:** `glayph/Agent`
**Release line:** `1.3.6`
**Assessment scope:** latest GitHub-integrated `main`, Linux x64 offline packaging, mixed Jest/Vitest verification, local gateway startup, deployment-script validation, and bounded runtime soak.

## Executive assessment

Agent Miki is **release-ready for the verified Linux x64 offline path**, with the qualification that production deployment still requires target-host validation for Windows, systemd reboot/restart behavior, externally authenticated integrations, TLS/reverse-proxy exposure, and a separately supplied answer-model GGUF. The application now has a reproducible release gate, secret-safe runtime packaging, a real gateway smoke test, deterministic mixed-runner test orchestration, and a clean extracted-archive startup path. It should not be described as universally production-certified across every supported operating system and optional integration until those target-host checks are completed.

> **Release decision:** Linux x64 offline artifact may proceed to controlled deployment. Windows and externally exposed deployments remain conditional on the target-host checks listed below.

## Verified gates

| Gate | Result | Evidence |
|---|---:|---|
| Release lint | PASS | `npm run verify:release` completed with zero ESLint errors and zero warnings. |
| Jest release suites | PASS | 141 suites, 826 tests passed. |
| Repository Vitest suites | PASS | 17 files, 69 tests passed. |
| Frontend Vitest workspace | PASS | 12 files, 55 tests passed. |
| Installer workspace tests | PASS | 10 suites, 51 tests passed. |
| Memory package tests | PASS | Included in the release verification workspace run. |
| Standard verification | PASS | `npm run verify` completed successfully, including build, acceptance, frontend tests, and Doctor. |
| Release build | PASS | `npm run verify:release` built all production workspaces and prepared `dist/runtime`. |
| Runtime pack contents | PASS | Required runtime files present; no `.env` or `secret-vault.json` in the runtime tree. |
| Production dependency audit | PASS | `npm audit --omit=dev --audit-level=moderate` reported zero vulnerabilities. |
| Gateway smoke | PASS | Isolated launcher booted on temporary ports; `/gateway/health` returned OK and dashboard returned HTTP 200. |
| 24/7 supervisor configuration | PASS | `npm run runtime:24-7:check` validated entrypoint, restart budget, backoff, and readiness timeout. |
| Linux deployment scripts | PASS | `bash -n deploy/linux/install-systemd.sh deploy/linux/uninstall-systemd.sh`. |
| Model manager | PASS | Three offline-safe model-manager tests passed; the pinned catalog is LFM-only. |
| Bounded soak | PASS | Three repeated health/metrics samples over approximately three seconds; zero health failures and zero metrics failures. |
| Final Linux archive checksum | PASS | Both `.tgz` and `.tar.gz` matched `SHA256SUMS`. |
| Clean extracted archive startup | PASS | `install-offline.sh`, packaged Doctor, launcher start, live health, dashboard fetch, status, and graceful shutdown all passed in an isolated HOME/XDG data directory. |

The release verifier’s final successful run completed in approximately 65 seconds. The clean archive used embedded Node `v22.23.2`, found the bundled llama.cpp server executable, and did not download an answer-model GGUF.

## Repairs completed in this pass

The release verifier was repaired to discover test files by runner type instead of passing a fragile collection of Jest ignore flags. Non-Vitest suites now run through Jest with the dedicated `jest.release.config.cjs`; repository Vitest suites run explicitly with Vitest; frontend Vitest suites run through the frontend workspace; and workspace tests remain part of the gate. A Jest ESM compatibility setup and an ESM-safe memory-bridge mock were added for suites that use `jest` globals and module mocking.

The production token-budget defect was corrected so an explicitly configured context window limits actual available output capacity rather than only changing reporting. Stale assertions were reconciled with the current Gemini/llama.cpp provider policy and the pinned LFM model catalogue. A corrupted trailing `EOF;` test sentinel, incorrect computer-grid imports, and an obsolete Claude-native provider test were corrected; the latter is now a policy regression that ensures removed Claude functionality is not silently reintroduced.

Inbound event idempotency was hardened by making event IDs deterministic when an explicit idempotency key is provided and excluding non-semantic `receivedAt` values from stable event fingerprints. Duplicate webhook delivery now returns the original queued job instead of failing because retry timestamps differed.

Runtime preparation now excludes local `.env` and data content from the immutable runtime package. The new pack assertion validates required runtime files and rejects credential files. The release verifier now includes a real isolated gateway smoke test rather than silently skipping that phase.

## Artifact and security notes

The final Linux archive was created at `/tmp/agent-miki-linux-x64-offline-1.3.6/` during verification. The archive contains the production runtime, embedded Node, bundled native llama.cpp executable, and production dependencies. It intentionally does **not** contain an answer-model GGUF or voice-to-text model. The operator must explicitly supply a compatible model or configure an approved cloud provider; no API credential is embedded in the release.

The archive checksum file validated both the npm-compatible `.tgz` and extracted-layout `.tar.gz`. Archive inspection found no root or nested `.env`, `secret-vault.json`, or runtime `data` directory. First-run dashboard credentials are created in the operator’s writable data area and are not stored in the immutable package tree.

## Target-host validation still required

| Area | Current status | Required before broad production rollout |
|---|---|---|
| Windows installer and supervisor | Not executable in this Linux sandbox | Run the PowerShell installer and supervisor on supported Windows versions, then verify service startup, stop, restart, path quoting, and upgrade/uninstall behavior. |
| Linux systemd lifecycle | Script syntax PASS only | Install on a representative Linux host, enable the unit, reboot, kill the gateway, and verify systemd recovery, logs, permissions, and resource limits. |
| Local LFM inference | Runtime executable PASS; model not bundled | Supply the approved LFM GGUF on the target host and verify llama.cpp inference quality, context size, memory use, and restart recovery. |
| Gemini test path | No credential intentionally persisted | Supply a separately managed Gemini credential in the target environment and run the model smoke test without writing it to the repository or artifact. |
| External channels and MCP | Unit and contract coverage only | Validate real credentials, TLS, reconnect, rate limits, delivery receipts, and approval-gated side effects for every integration that will be enabled. |
| External TLS/reverse proxy | Configuration example only | Validate certificate renewal, forwarded headers, WebSocket upgrade, origin policy, firewalling, and dashboard authentication behind the chosen proxy. |
| Long-duration soak | Bounded smoke only | Run a multi-hour or overnight soak on the target host with the intended model and integrations, tracking RSS, file descriptors, active resources, queue growth, and restart counts. |
| Operational backup/restore | Code and checks covered, target operation not executed | Test backup, restore, migration, rollback, and secret-vault recovery using the operator’s actual storage and service-management procedures. |

Doctor may report a warning when no Gemini credential is configured; this is expected for the local-first release and does not prevent the no-key llama.cpp path. The optional Go CLI is also reported as unavailable in this sandbox; the Node launcher path is the verified fallback.

## Reproduction commands

```bash
npm run verify
npm run verify:release
npm run runtime:24-7:check
npm run test:model-manager
npm run build:release:linux
```

For a clean extracted archive, use the README shipped inside the generated `.tar.gz` and run `./install-offline.sh`, followed by the embedded Node Doctor and offline launcher commands. Keep the package tree immutable and provide writable runtime/workspace paths through the documented environment variables.
