# Miki Documentation Index

## Final handoff

- [24/7 Final Handoff](./24-7-final-handoff.md) — completed changes, deployment architecture, safety rules, recovery policy, acceptance checklist, and the next implementation steps.
- [24/7 Supervisor Smoke Test](./24-7-soak-smoke-test.md) — live startup, intentional child crash, bounded restart, and recovery evidence.
- [Release Validation](./release-validation.md) — build and verification evidence.
- [Verification Report](./verification-report.md) — task and artifact verification history.

## Operations

- [Durable Scheduler](./durable-scheduler.md) — persisted schedules, missed-run policy, retries, and health metrics.
- [Autonomous Workflow](./autonomous-workflow.md) — tool execution and verification behavior.
- [Provider Gateway](./provider-gateway.md) — local provider and gateway behavior.
- [Performance Observation](./miki-performance-observation-report.md) — resource and model observations.

## Deployment materials

- `../scripts/install-systemd.sh` — install, start, stop, restart, status, and uninstall the Linux service stack.
- `../deploy/systemd/` — systemd units and health timer templates.
- `../deploy/reverse-proxy/` — reverse-proxy example; configure authentication and TLS before remote access.
- `../deploy/firewall/` — firewall examples.

Do not store production secrets in the project archive. Put them in the host environment or `/etc/miki/miki.env` after deployment.
