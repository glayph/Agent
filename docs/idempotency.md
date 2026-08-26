# External Side-Effect Idempotency

Agent Miki’s durable queue now treats an external delivery as a logical operation identified by a caller-supplied `idempotencyKey`. The key must be unique for one intended side effect and must remain unchanged across transport retries. It must not contain a secret.

## Contract

| Situation | Queue behavior |
|---|---|
| Same key and same immutable request | The original durable receipt is returned; a second delivery is not created. |
| Same key and different destination, body, channel, or delivery metadata | The request is rejected with an idempotency conflict. |
| A receipt is `sending` when the process restarts | It is converted to `unknown_outcome`; no automatic resend is attempted. |
| Sender throws after dispatch begins | The receipt becomes `unknown_outcome`; the provider outcome must be reconciled before replay. |
| Deterministic failure reaches the attempt limit | The receipt becomes `dead_letter`; intentional replay requires a new idempotency key and fresh approval where applicable. |
| A terminal receipt is settled again | The terminal state is preserved; a late duplicate result cannot change `sent` or `unknown_outcome`. |

The delivery queue stores a request fingerprint alongside the key. The persistent agent-job queue also stores a stable type/payload fingerprint, preventing an active job key from silently being reused for a different payload.

## Safe retry and recovery sequence

A delivery handler should pass the same idempotency key, or a provider-supported equivalent, to the external provider on every retry. If the client loses the response, inspect the durable receipt and reconcile the provider by that key or provider message ID. Do not replay an `unknown_outcome` receipt automatically. Create a new replay lineage only after reconciliation establishes that no external side effect occurred, and obtain any required approval again.

A process crash after the queue marks a receipt `sending` is intentionally conservative. The system cannot know whether the remote provider accepted the request, so it records `unknown_outcome` instead of risking a duplicate. A provider-side idempotency API or transaction key is required to move from this conservative outcome to a verified result.

## Exactly-once boundary

The repository can provide durable request identity, duplicate enqueue suppression, conflict detection, crash-safe unknown-outcome handling, and receiver-side deduplication metadata. It cannot mathematically guarantee exactly-once execution at an arbitrary external provider that does not implement idempotent requests or outcome reconciliation. The current safe guarantee is therefore:

> **At most one automatic dispatch attempt after an uncertain external outcome, with durable reconciliation required before replay.**

For a true end-to-end exactly-once effect, the external system must atomically deduplicate the supplied operation key with the side effect, or expose a reliable status lookup keyed by that operation. Without that provider capability, “send exactly once” is not truthfully verifiable from Agent Miki alone.

## API usage rules

The inbound event API derives a stable key from the channel and event ID when the provider supplies no explicit key. External delivery APIs require an explicit `idempotencyKey`; this prevents a retrying caller from accidentally creating a new logical operation. The replay endpoint requires a new key by design and records the original receipt as the replay lineage.

Do not derive keys from mutable text alone if two distinct actions can have identical content. Prefer a stable provider event ID, workflow run ID plus step ID, or a securely generated operation ID. Do not place tokens, API keys, passwords, or private response content in the key.

## Testing evidence

The focused suite verifies same-key deduplication, same-key conflict rejection, persistence across restart, crash-after-claim conversion to `unknown_outcome`, thrown-sender safety, terminal-state immutability, replay lineage, and approval-bound unknown-outcome blocking. These tests use local temporary files and mock senders; no real provider side effect is performed.
