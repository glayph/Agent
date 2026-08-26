# External Integration Readiness

## Scope

This document records the safe repository-level readiness of the six requested external integrations: Telegram, Discord, Slack, WhatsApp, Facebook Pages, and YouTube. The status is intentionally split between the **channel runtime adapter** and the **platform connection/publishing surface**. A bot channel can be present while browser/OAuth publishing remains blocked.

| Provider | Channel runtime | Platform publishing implementation | Current safe status |
|---|---|---|---|
| Telegram | Functional bot channel adapter | Planned platform-connection publisher | Configuration and read-only/preflight testing are supported; external delivery remains credential- and destination-dependent. |
| Discord | Functional bot channel adapter | Planned platform-connection publisher | Configuration and safe adapter checks are supported; external delivery remains credential-, server-, and channel-permission-dependent. |
| Slack | Functional Socket Mode channel adapter | Planned platform-connection publisher | Configuration and safe adapter checks are supported; external delivery remains credential-, workspace-, and channel-permission-dependent. |
| WhatsApp | Partial bridge-based channel adapter | Planned native Cloud API publisher | The bridge URL/webhook path can be configured and preflighted; native WhatsApp Cloud API delivery is not implemented. |
| Facebook Pages | Unavailable | Planned | No executable Page publishing adapter is wired. The capability remains blocked and automation rejects this target. |
| YouTube | Unavailable | Planned | No executable upload/publishing adapter is wired. The capability remains blocked and automation rejects this target. |

## Preflight and outbound safety

Channel probes now distinguish three modes: `mock`, `sandbox`, and `live`. Mock probes do not execute provider validation or send traffic. Sandbox probes may execute only an explicitly supplied plugin probe under the existing plugin execution policy; they do not authorize provider traffic. Live provider validation is invoked only when live mode is explicitly selected.

The outbound check is a **contract/preflight signal**, not a delivery receipt. In live mode it remains skipped unless the explicit live-send environment gate is enabled. Even when the gate is enabled, the probe does not claim that a message was delivered; provider calls remain adapter-controlled and must still be protected by destination allow-lists, provider permissions, and an explicit per-action approval policy.

All probe responses expose required-field failures, runtime status, check mode, setup steps, and a non-secret failure code. Raw tokens and private provider responses must not be written to logs, model context, chat history, or platform metadata. Platform connection records store only opaque credential references; validation of a provider whose publishing adapter is still planned remains `needs_validation` and never becomes `connected`.

## External prerequisites that cannot be completed in this repository

Credentialed delivery requires provider-owned accounts, valid credentials or secure connector references, approved destinations, and provider-side permissions. Facebook Pages and YouTube additionally require their respective production adapters before any publish/upload operation can be considered available. Those prerequisites were not fabricated or simulated here, and no external message, post, upload, or webhook delivery was performed during this remediation.

For a production rollout, configure credentials through the managed secret boundary, run a read-only identity/permission validation, set a narrow test recipient or destination allow-list, and obtain explicit approval for one harmless test action. A successful preflight must not be interpreted as proof of exactly-once delivery; the durable queue remains at-least-once until provider handlers enforce idempotency keys.
