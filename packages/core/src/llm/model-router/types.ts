import type { LLMResponse } from "@miki/config";
import type { MikiProviderMessage } from "../provider/sdk/index.js";

/**
 * Where a model choice came from. This decides failover behaviour:
 *
 * - `configured_default` — chosen by configuration (a lane's `primary`), by
 *   complexity routing, or by learned routing. The `fallbacks` chain applies.
 * - `explicit_override`  — a person/operator picked this exact model (Web UI
 *   selector, API `model` field). It is STRICT: if that model cannot serve the
 *   request the router raises a visible error; it never silently answers with a
 *   different model.
 */
export type ModelSelectionSource = "configured_default" | "explicit_override";

/**
 * Lanes are named model profiles. Built-in names (all optional in config):
 * `default` (simple main-lane work), `complex` (complex main-lane work),
 * `heartbeat` (proactive 24/7 loop — cheap), `subagent` (background sub-agents)
 * and `background` (silent housekeeping such as memory summaries).
 * Any other name is allowed; an unknown lane resolves to `default`.
 */
export const BUILTIN_LANES = [
  "default",
  "complex",
  "heartbeat",
  "subagent",
  "background",
] as const;

export interface LaneProfile {
  /** `provider/model` reference tried first. */
  primary: string;
  /** Ordered `provider/model` references tried after `primary` fails. */
  fallbacks: string[];
}

/** A role (specialist id) is bound either to a lane name or to an inline profile. */
export type RoleBinding = string | LaneProfile;

export interface ModelRouterConfig {
  /** false → every call is a single attempt on the chosen model (no fallback chain). */
  enabled: boolean;
  lanes: Record<string, LaneProfile>;
  roles: Record<string, RoleBinding>;
  /**
   * Extra credential profiles per provider id: names of secrets (env-var style
   * keys such as `GEMINI_API_KEY_2`) — never the secret values themselves.
   * Tried, in order, before hopping to the next model.
   */
  credentialProfiles: Record<string, string[]>;
  /** Hard cap on provider attempts (credential rotations + model hops) per call. */
  maxAttempts: number;
  origin: "model_router" | "legacy_model_routing" | "builtin";
  warnings: string[];
}

export type FailureKind =
  | "rate_limit"
  | "timeout"
  | "server_error"
  | "network"
  | "auth"
  | "billing"
  | "model_not_found"
  | "context_overflow"
  | "unavailable"
  | "bad_request"
  | "aborted"
  | "unknown";

export type HopAction =
  | "rotate_credential"
  | "fallback"
  | "exhausted"
  | "explicit_blocked"
  | "preflight_skip";

/** One visible failover step. Never contains secret values. */
export interface FailoverHop {
  at: string;
  lane: string;
  role?: string;
  source: ModelSelectionSource;
  action: HopAction;
  kind: FailureKind;
  from: string;
  to?: string;
  /** Credential profile label (secret *name*) that failed, when known. */
  credential?: string;
  nextCredential?: string;
  attempt: number;
  reason: string;
}

export interface ModelSelection {
  lane: string;
  role?: string;
  source: ModelSelectionSource;
  /** Full ordered candidate list, primary first. Explicit overrides have exactly one entry. */
  chain: string[];
  /** Index of the candidate the call will start with (after preflight skips). */
  index: number;
  /** `chain[index]` — the model the call starts on. */
  model: string;
  /** True once readiness of `model` was probed by `selectReady()`. */
  preflighted: boolean;
  profileOrigin: "explicit" | "role" | "lane" | "default_lane" | "default_model";
}

export interface RouterSelectInput {
  lane?: string;
  role?: string;
  /** A model chosen by a person/operator. Makes the call strict (no fallback). */
  explicitModel?: string;
  /**
   * A configured-source model to try first when it is part of the lane chain
   * (learned routing). Ignored for explicit overrides.
   */
  preferModel?: string;
}

/**
 * Provider request options. A function form lets the caller tailor options to
 * whichever model a failover lands on (e.g. local vs remote tool settings).
 */
export type RouterExtra =
  | Record<string, unknown>
  | ((model: string) => Record<string, unknown> | undefined);

export interface RouterCompletionRequest extends RouterSelectInput {
  messages: MikiProviderMessage[];
  extra?: RouterExtra;
  timeoutMs?: number;
  /**
   * Per-attempt deadline enforced by the router itself. A hung provider is
   * aborted at this deadline and classified as a timeout, so it can fail over
   * instead of blocking the whole chain. A function form sizes it per model.
   */
  attemptTimeoutMs?: number | ((model: string) => number | undefined);
  signal?: AbortSignal;
  /** Result of an earlier `selectReady()`; skips re-resolving the lane. */
  selection?: ModelSelection;
}

export interface RouterCompletion {
  response: LLMResponse;
  /** Model that actually produced the response. */
  model: string;
  selection: ModelSelection;
  hops: FailoverHop[];
  attempts: number;
  latencyMs: number;
  /** True when `model` differs from the model the call started on. */
  failedOver: boolean;
}

export interface ModelReadiness {
  available: boolean;
  reason?: string;
}

/**
 * Port to the provider layer. `ProviderRegistry` satisfies it; tests supply a
 * fake. The router is the only component allowed to call `complete()`.
 */
export interface ModelRouterProviders {
  isModelReady(model: string): Promise<ModelReadiness>;
  complete(
    model: string,
    messages: MikiProviderMessage[],
    options?: {
      extra?: Record<string, unknown>;
      timeoutMs?: number;
      signal?: AbortSignal;
      credentialProfile?: string;
    },
  ): Promise<LLMResponse>;
  /**
   * Names (not values) of credential profiles that currently hold a secret for
   * the provider serving `model`, in rotation order.
   */
  credentialProfiles?(model: string, configured?: string[]): string[];
  /** Provider id serving `model`, used to look up `credentialProfiles` config. */
  providerIdFor?(model: string): string | undefined;
}

export interface ModelRouterStats {
  calls: number;
  succeeded: number;
  failed: number;
  failovers: number;
  credentialRotations: number;
  explicitBlocked: number;
  preflightSkips: number;
  byLane: Record<string, { calls: number; failovers: number; failed: number }>;
}
