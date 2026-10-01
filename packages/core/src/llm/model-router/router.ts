import { redactSecrets } from "@miki/config";
import { LLMTimeoutError } from "../provider/errors.js";
import {
  AllModelsFailedError,
  ExplicitModelUnavailableError,
  ModelRouterError,
} from "./errors.js";
import { classifyFailure } from "./failure.js";
import { normalizeModelRef } from "./config.js";
import type {
  FailoverHop,
  FailureKind,
  HopAction,
  LaneProfile,
  ModelReadiness,
  ModelRouterConfig,
  ModelRouterProviders,
  ModelRouterStats,
  ModelSelection,
  RouterCompletion,
  RouterCompletionRequest,
  RouterSelectInput,
} from "./types.js";

export type ModelRouterLogger = (
  level: "info" | "warn",
  event: string,
  details: Record<string, unknown>,
) => void;

export interface ModelRouterOptions {
  providers: ModelRouterProviders;
  config: ModelRouterConfig;
  /**
   * Runs before a candidate is probed or (as a failover target) called — e.g.
   * start/sync the local llama.cpp runtime. A throw marks the candidate
   * unavailable; it never fails the whole call by itself.
   */
  prepare?: (model: string) => Promise<void> | void;
  logger?: ModelRouterLogger;
  /** How many recent hops to keep for `recentHops()` (default 100). */
  hopHistory?: number;
}

const defaultLogger: ModelRouterLogger = (level, event, details) => {
  const line = `[ModelRouter] ${event}`;
  if (level === "warn") console.warn(line, details);
  else console.info(line, details);
};

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return String(redactSecrets(raw)).slice(0, 300);
}

function emptyStats(): ModelRouterStats {
  return {
    calls: 0,
    succeeded: 0,
    failed: 0,
    failovers: 0,
    credentialRotations: 0,
    explicitBlocked: 0,
    preflightSkips: 0,
    byLane: {},
  };
}

/**
 * The single entry point for every model call.
 *
 * Behaviour contract (upgrade step 03):
 *  1. Every completion goes through `complete()`; nothing else calls a provider.
 *  2. Every failover hop is logged, kept in `recentHops()` and emitted to
 *     `onHop()` listeners (which the hook/event bus of step 11 subscribes to).
 *  3. `explicit_override` selections are strict — a failure raises
 *     `ExplicitModelUnavailableError`; no other model is ever substituted.
 *  4. Lanes (`default`, `complex`, `heartbeat`, `subagent`, `background`, or any
 *     custom name) and per-role bindings choose the model profile.
 */
export class ModelRouter {
  private config: ModelRouterConfig;
  private readonly providers: ModelRouterProviders;
  private readonly prepare?: ModelRouterOptions["prepare"];
  private readonly log: ModelRouterLogger;
  private readonly historyLimit: number;
  private readonly history: FailoverHop[] = [];
  private readonly listeners = new Set<(hop: FailoverHop) => void>();
  private counters: ModelRouterStats = emptyStats();

  constructor(options: ModelRouterOptions) {
    this.providers = options.providers;
    this.config = options.config;
    this.prepare = options.prepare;
    this.log = options.logger ?? defaultLogger;
    this.historyLimit = Math.max(1, options.hopHistory ?? 100);
    for (const warning of options.config.warnings) {
      this.log("warn", "config.warning", { warning });
    }
  }

  // ── configuration ────────────────────────────────────────────────────────

  getConfig(): ModelRouterConfig {
    return this.config;
  }

  updateConfig(config: ModelRouterConfig): void {
    this.config = config;
    for (const warning of config.warnings) {
      this.log("warn", "config.warning", { warning });
    }
  }

  // ── observability ────────────────────────────────────────────────────────

  onHop(listener: (hop: FailoverHop) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recentHops(limit = this.historyLimit): FailoverHop[] {
    return this.history.slice(-Math.max(0, limit));
  }

  stats(): ModelRouterStats {
    return {
      ...this.counters,
      byLane: Object.fromEntries(
        Object.entries(this.counters.byLane).map(([lane, value]) => [
          lane,
          { ...value },
        ]),
      ),
    };
  }

  resetStats(): void {
    this.counters = emptyStats();
  }

  // ── selection ────────────────────────────────────────────────────────────

  /** Resolve which profile applies: role binding → lane → default lane. */
  resolveProfile(
    lane?: string,
    role?: string,
  ): {
    lane: string;
    profile: LaneProfile;
    origin: ModelSelection["profileOrigin"];
  } {
    const roleId = role?.trim().toLowerCase();
    const binding = roleId ? this.config.roles[roleId] : undefined;
    if (binding !== undefined) {
      if (typeof binding !== "string") {
        return { lane: lane?.trim().toLowerCase() || "default", profile: binding, origin: "role" };
      }
      const bound = this.config.lanes[binding];
      if (bound) return { lane: binding, profile: bound, origin: "role" };
    }
    const name = lane?.trim().toLowerCase() || "default";
    const direct = this.config.lanes[name];
    if (direct) return { lane: name, profile: direct, origin: "lane" };
    const fallback = this.config.lanes.default;
    if (fallback) {
      return { lane: name, profile: fallback, origin: "default_lane" };
    }
    return {
      lane: name,
      profile: { primary: "", fallbacks: [] },
      origin: "default_model",
    };
  }

  /**
   * Choose the candidate chain without probing anything. An explicit model
   * always yields a single-entry chain (strict); configured selections yield
   * `primary` + `fallbacks` (or just `primary` when failover is disabled).
   */
  select(input: RouterSelectInput = {}): ModelSelection {
    const explicit = normalizeModelRef(input.explicitModel);
    const roleId = input.role?.trim().toLowerCase() || undefined;
    if (explicit) {
      return {
        lane: input.lane?.trim().toLowerCase() || "default",
        role: roleId,
        source: "explicit_override",
        chain: [explicit],
        index: 0,
        model: explicit,
        preflighted: false,
        profileOrigin: "explicit",
      };
    }

    const resolved = this.resolveProfile(input.lane, roleId);
    let chain = [resolved.profile.primary, ...resolved.profile.fallbacks].filter(
      Boolean,
    );
    if (!this.config.enabled) chain = chain.slice(0, 1);

    const prefer = normalizeModelRef(input.preferModel);
    if (prefer && chain.includes(prefer)) {
      chain = [prefer, ...chain.filter((model) => model !== prefer)];
    }
    if (chain.length === 0) {
      throw new AllModelsFailedError([], {
        failureKind: "unavailable",
        hops: [],
        cause: undefined,
      });
    }
    return {
      lane: resolved.lane,
      role: roleId,
      source: "configured_default",
      chain,
      index: 0,
      model: chain[0]!,
      preflighted: false,
      profileOrigin: resolved.origin,
    };
  }

  /**
   * `select()` plus a readiness probe: walks the chain to the first candidate
   * that is ready. An explicit override that is not ready raises instead.
   */
  async selectReady(input: RouterSelectInput = {}): Promise<ModelSelection> {
    const selection = this.select(input);
    const hops: FailoverHop[] = [];
    let firstReason = "";
    for (let i = selection.index; i < selection.chain.length; i += 1) {
      const model = selection.chain[i]!;
      const readiness = await this.checkReady(model);
      if (readiness.available) {
        return { ...selection, index: i, model, preflighted: true };
      }
      const reason = readiness.reason || "provider runtime is not ready";
      if (!firstReason) firstReason = reason;
      if (selection.source === "explicit_override") {
        const hop = this.recordHop(selection, {
          action: "explicit_blocked",
          kind: "unavailable",
          from: model,
          attempt: 0,
          reason,
        });
        hops.push(hop);
        this.counters.explicitBlocked += 1;
        throw new ExplicitModelUnavailableError(model, reason, {
          failureKind: "unavailable",
          hops,
        });
      }
      const next = selection.chain[i + 1];
      hops.push(
        this.recordHop(selection, {
          action: next ? "preflight_skip" : "exhausted",
          kind: "unavailable",
          from: model,
          to: next,
          attempt: 0,
          reason,
        }),
      );
      this.counters.preflightSkips += 1;
    }
    throw new AllModelsFailedError(selection.chain.slice(selection.index), {
      failureKind: "unavailable",
      hops,
      cause: undefined,
    });
  }

  // ── completion ───────────────────────────────────────────────────────────

  async complete(request: RouterCompletionRequest): Promise<RouterCompletion> {
    const startedAt = Date.now();
    const selection = request.selection ?? this.select(request);
    const laneStats = (this.counters.byLane[selection.lane] ??= {
      calls: 0,
      failovers: 0,
      failed: 0,
    });
    this.counters.calls += 1;
    laneStats.calls += 1;

    const hops: FailoverHop[] = [];
    const attemptedModels: string[] = [];
    let attempts = 0;
    let lastError: unknown;
    let lastKind: FailureKind = "unavailable";
    const explicit = selection.source === "explicit_override";
    const startModel = selection.model;

    try {
      for (let i = selection.index; i < selection.chain.length; i += 1) {
        const model = selection.chain[i]!;

        // The start candidate is the caller's responsibility (selectReady);
        // every failover target is prepared and probed before use.
        if (i !== selection.index) {
          const readiness = await this.checkReady(model);
          if (!readiness.available) {
            const next = selection.chain[i + 1];
            hops.push(
              this.recordHop(selection, {
                action: next ? "preflight_skip" : "exhausted",
                kind: "unavailable",
                from: model,
                to: next,
                attempt: attempts,
                reason: readiness.reason || "provider runtime is not ready",
              }),
            );
            this.counters.preflightSkips += 1;
            continue;
          }
        }

        attemptedModels.push(model);
        const slots = this.credentialSlots(model);
        let modelFailed = false;

        for (let s = 0; s < slots.length; s += 1) {
          if (attempts >= this.config.maxAttempts) {
            modelFailed = true;
            break;
          }
          attempts += 1;
          try {
            const response = await this.attempt(model, request, slots[s]);
            this.counters.succeeded += 1;
            const failedOver = model !== startModel;
            if (failedOver) {
              this.log("info", "failover.served", {
                lane: selection.lane,
                requested: startModel,
                served: model,
                attempts,
              });
            }
            return {
              response,
              model,
              selection,
              hops,
              attempts,
              latencyMs: Date.now() - startedAt,
              failedOver,
            };
          } catch (error) {
            if (request.signal?.aborted) throw error;
            const failure = classifyFailure(error);
            if (!failure.failover) throw error; // not a failover-class error
            lastError = error;
            lastKind = failure.kind;
            const canRotate =
              failure.rotateCredential && s + 1 < slots.length;
            if (canRotate) {
              hops.push(
                this.recordHop(selection, {
                  action: "rotate_credential",
                  kind: failure.kind,
                  from: model,
                  credential: slots[s],
                  nextCredential: slots[s + 1],
                  attempt: attempts,
                  reason: errorText(error),
                }),
              );
              this.counters.credentialRotations += 1;
              continue;
            }
            modelFailed = true;
            if (explicit) {
              hops.push(
                this.recordHop(selection, {
                  action: "explicit_blocked",
                  kind: failure.kind,
                  from: model,
                  credential: slots[s],
                  attempt: attempts,
                  reason: errorText(error),
                }),
              );
              this.counters.explicitBlocked += 1;
              throw this.explicitError(model, error, failure.kind, hops);
            }
            const next = selection.chain[i + 1];
            hops.push(
              this.recordHop(selection, {
                action: next ? "fallback" : "exhausted",
                kind: failure.kind,
                from: model,
                to: next,
                credential: slots[s],
                attempt: attempts,
                reason: errorText(error),
              }),
            );
            if (next) {
              this.counters.failovers += 1;
              laneStats.failovers += 1;
            }
            break;
          }
        }
        if (modelFailed && attempts >= this.config.maxAttempts) break;
      }
    } catch (error) {
      this.counters.failed += 1;
      laneStats.failed += 1;
      throw error;
    }

    this.counters.failed += 1;
    laneStats.failed += 1;
    throw new AllModelsFailedError(attemptedModels, {
      failureKind: lastKind,
      hops,
      cause: lastError,
      providerId: (lastError as { providerId?: string } | undefined)?.providerId,
      status: (lastError as { status?: number } | undefined)?.status,
      retryable: (lastError as { retryable?: boolean } | undefined)?.retryable,
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** One provider call with a router-enforced deadline (see `attemptTimeoutMs`). */
  private async attempt(
    model: string,
    request: RouterCompletionRequest,
    credentialProfile: string | undefined,
  ) {
    const limit =
      typeof request.attemptTimeoutMs === "function"
        ? request.attemptTimeoutMs(model)
        : request.attemptTimeoutMs;
    const extra =
      typeof request.extra === "function" ? request.extra(model) : request.extra;
    if (!limit || limit <= 0) {
      return this.providers.complete(model, request.messages, {
        extra,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        credentialProfile,
      });
    }
    const controller = new AbortController();
    const forward = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) controller.abort(request.signal.reason);
    else request.signal?.addEventListener("abort", forward, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`attempt timed out after ${limit}ms`));
    }, limit);
    try {
      return await this.providers.complete(model, request.messages, {
        extra,
        timeoutMs: request.timeoutMs ?? limit,
        signal: controller.signal,
        credentialProfile,
      });
    } catch (error) {
      if (timedOut && !request.signal?.aborted) {
        throw new LLMTimeoutError(
          `Provider ${this.providers.providerIdFor?.(model) ?? model} did not answer within ${limit}ms.`,
          {
            providerId: this.providers.providerIdFor?.(model),
            cause: error,
          },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", forward);
    }
  }

  hasLane(name: string | undefined): boolean {
    return Boolean(name && this.config.lanes[name.trim().toLowerCase()]);
  }

  private explicitError(
    model: string,
    cause: unknown,
    kind: FailureKind,
    hops: readonly FailoverHop[],
  ): ExplicitModelUnavailableError {
    return new ExplicitModelUnavailableError(model, errorText(cause), {
      cause,
      failureKind: kind,
      hops,
      providerId: (cause as { providerId?: string }).providerId,
      status: (cause as { status?: number }).status,
      retryable: (cause as { retryable?: boolean }).retryable,
    });
  }

  private async checkReady(model: string): Promise<ModelReadiness> {
    try {
      await this.prepare?.(model);
      return await this.providers.isModelReady(model);
    } catch (error) {
      return { available: false, reason: errorText(error) };
    }
  }

  /** Credential profile labels to try for `model`; `[undefined]` = provider default. */
  private credentialSlots(model: string): Array<string | undefined> {
    const providerId = this.providers.providerIdFor?.(model);
    const configured = providerId
      ? this.config.credentialProfiles[providerId.toLowerCase()]
      : undefined;
    const profiles = this.providers.credentialProfiles?.(model, configured) ?? [];
    return profiles.length > 1 ? profiles : [undefined];
  }

  private recordHop(
    selection: ModelSelection,
    hop: {
      action: HopAction;
      kind: FailureKind;
      from: string;
      to?: string;
      credential?: string;
      nextCredential?: string;
      attempt: number;
      reason: string;
    },
  ): FailoverHop {
    const entry: FailoverHop = {
      at: new Date().toISOString(),
      lane: selection.lane,
      role: selection.role,
      source: selection.source,
      ...hop,
    };
    this.history.push(entry);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
    this.log("warn", `hop.${entry.action}`, { ...entry });
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // A listener must never break routing.
      }
    }
    return entry;
  }
}

export { ModelRouterError };
