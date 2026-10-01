# Model Router — lanes, failover, strict explicit override (upgrade step 03)

Code: `packages/core/src/llm/model-router/` · Config: `agent.model_router` in `config/agent.yaml`.

Every model call in Miki goes through **one** component, the `ModelRouter`. It decides *which* model
answers, retries on the provider's other credentials, and falls back along a configured chain when a
provider is down. The agent loop, background memory summaries, self-improvement and plugins no longer
touch a provider directly (enforced by `llm/model-router/boundary.test.ts`).

## Concepts

| Term | Meaning |
|---|---|
| **Model reference** | `provider/model`, e.g. `gemini/gemini-3.5-flash-lite`, `llama.cpp/lfm2.5-1.2b-instruct-q4_0`. |
| **Lane** | A named profile `{ primary, fallbacks[] }`. Built-in names: `default` (simple turns), `complex`, `heartbeat`, `subagent`, `background`. Any other name works too; an unknown lane resolves to `default`. |
| **Role binding** | `roles.<specialistId>` binds a specialist (`miki`, `sage`, `forge`, `scout`, …) to a lane name or to its own inline profile. A role binding wins over the lane passed by the caller. |
| **Selection source** | `configured_default` (config / complexity routing / learned routing) or `explicit_override` (a person picked the model in the UI/API). |

## Behaviour contract

1. **One entry point.** All completions use `ModelRouter.complete()` (`achatCompletion()` is a thin wrapper).
2. **Failover order** (configured selections): credential rotation on the *same* provider → next model in `fallbacks`.
   Credential rotation is tried only for failures a different key can fix (auth, rate-limit, billing).
3. **Every hop is visible**: logged (`[ModelRouter] hop.*`, secrets redacted), kept in `router.recentHops()`, emitted to
   `router.onHop(listener)` (the step-11 event bus subscribes here) and counted in `router.stats()`.
4. **Explicit override is strict.** A model chosen explicitly (`requestedModel` / `requested_model`) never falls back. If it is
   unavailable the turn fails with `ExplicitModelUnavailableError` (or, if it fails mid-call, the user sees
   *“…was selected explicitly, so no other model was substituted.”*). Credential rotation on the same model is still allowed.
5. **Cheap lanes.** `heartbeat` and `subagent` have their own profile. An autonomous (heartbeat-driven) turn uses the
   `heartbeat` lane when one is configured; specialist runs use `subagent` and the role's own profile.
6. **Not every error fails over.** Aborts, malformed requests (HTTP 400), unsupported-input errors and programmer errors are
   re-thrown unchanged — a fallback would fail identically and only hide the bug.
7. **Hung providers fail over.** Each attempt has its own deadline (local 90 s / remote 120 s by default); the router aborts the
   attempt and treats it as a timeout. The whole chain is bounded (≤ 300 s).
8. **Bounded.** `max_attempts` (default 8) caps rotations + hops per call.

| Failure | Rotates credential? | Fails over to next model? |
|---|---|---|
| rate limit / quota (429) | yes | yes |
| auth rejected / missing key (401/403) | yes | yes |
| billing / entitlement (402) | yes | yes |
| timeout, 5xx, network, unknown model (404), context overflow | no | yes |
| caller abort, HTTP 400, unsupported audio/image, any other error | — | **no** (re-thrown) |

## Configuration

```yaml
agent:
  model_router:
    enabled: true          # false → single attempt on the primary, no fallbacks
    max_attempts: 8
    lanes:
      default:   { primary: llama.cpp/lfm2.5-1.2b-instruct-q4_0, fallbacks: [gemini/gemini-3.5-flash-lite] }
      complex:   { primary: gemini/gemini-3.5-flash-lite,        fallbacks: [llama.cpp/lfm2.5-1.2b-instruct-q4_0] }
      heartbeat: { primary: gemini/gemini-3.5-flash-lite,        fallbacks: [llama.cpp/lfm2.5-1.2b-instruct-q4_0] }
      subagent:  { primary: gemini/gemini-3.5-flash-lite,        fallbacks: [llama.cpp/lfm2.5-1.2b-instruct-q4_0] }
    roles:
      forge: subagent                                   # bind a specialist to a lane…
      scout: { primary: openai/gpt-4o-mini, fallbacks: [gemini/gemini-3.5-flash-lite] }   # …or give it its own profile
    credential_profiles:
      gemini: [GEMINI_API_KEY_2]                        # secret NAMES (never values); same provider only
```

* `background` (memory summaries, self-improvement cycles) follows the globally selected model unless a `background` lane is defined.
* **Credential profiles** must be the provider's own variable or a suffixed sibling (`GEMINI_API_KEY`, `GEMINI_API_KEY_2`,
  `GEMINI_API_KEY_BACKUP`). Anything else is ignored, so a typo can never send one vendor's key to another vendor.
  Profiles without a stored secret are skipped.
* **Migration.** If `model_router` is absent, the deprecated `agent.model_routing` block (`local_model`, `complex_model`) is
  translated to equivalent `default`/`complex` lanes and a deprecation warning is logged. If both are absent, the single
  globally selected model is used (no fallbacks) — i.e. exactly the old behaviour.
* A garbled block never takes the agent down: invalid lanes are dropped with a logged warning and safe defaults apply.

## Replaced behaviour

* `_resolveTurnModel` (agent.ts) — hand-written preference/fallback list → `router.selectReady()`.
* The one-off **BUG-04** retry (“missing credentials → retry once on the local model”) → generic failover: a missing/rejected
  key on the primary rotates credentials and then hops down the lane’s chain.
* The plugin `model-router.provider-registry` forwarded `extra` as if it were provider options; it now routes through the
  router (`complete()` = strict explicit model, `completeOnLane()` = lane chain).

## Operating it

```ts
orchestrator.modelRouter.stats();        // calls / failovers / rotations / explicit-blocked per lane
orchestrator.modelRouter.recentHops(20); // last failover steps (no secrets)
orchestrator.modelRouter.onHop((hop) => …);
```

Passing a lane from code: `runAgentLoop(session, text, undefined, { lane: "heartbeat", role: "forge" })`.

## Not in scope here (later steps)

* Surfacing router stats/hops in `doctor`/CLI → step 12. Emitting hops on the hook bus → step 11 (subscribe via `onHop`).
* Heartbeat/cron/sub-agent *schedulers* (steps 08–10) should pass `lane` — the lanes exist now.
