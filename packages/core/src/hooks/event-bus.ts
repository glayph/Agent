/**
 * Lightweight lifecycle EventBus (Step 11).
 *
 * - Deterministic order: higher priority first, then registration order.
 * - Handlers are request-scoped: no persistent timers/sockets here.
 * - Failures / timeouts never crash the core loop — logged only.
 */

import type { HookControlResult, LifecycleEventName } from "./events.js";

export type HookHandler<P = unknown> = (
  payload: P,
) => void | HookControlResult | Promise<void | HookControlResult>;

export interface SubscribeOptions {
  /** Higher runs first. Default 0. */
  priority?: number;
  /** Per-handler timeout in ms. Default from bus options. */
  timeoutMs?: number;
}

interface Registration {
  id: number;
  event: string;
  handler: HookHandler<unknown>;
  priority: number;
  timeoutMs: number;
  order: number;
}

export interface EventBusOptions {
  /** Default handler timeout (ms). 0 = no timeout. Default 2000. */
  defaultTimeoutMs?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface EmitResult {
  /** True if any handler requested block. */
  blocked: boolean;
  blockReason?: string;
  /** Handler errors/timeouts (for tests/diagnostics). */
  errors: Array<{ event: string; message: string }>;
}

let nextOrder = 0;
let nextId = 1;

export class EventBus {
  private readonly regs = new Map<string, Registration[]>();
  private readonly defaultTimeoutMs: number;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;

  constructor(options?: EventBusOptions) {
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 2000;
    this.log = options?.log ?? ((msg, meta) => console.warn(msg, meta ?? ""));
  }

  /**
   * Subscribe to an event. Returns unsubscribe function.
   * Execution order: priority DESC, then registration order ASC.
   */
  on<P = unknown>(
    event: LifecycleEventName | string,
    handler: HookHandler<P>,
    options?: SubscribeOptions,
  ): () => void {
    const reg: Registration = {
      id: nextId++,
      event,
      handler: handler as HookHandler<unknown>,
      priority: options?.priority ?? 0,
      timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs,
      order: nextOrder++,
    };
    const list = this.regs.get(event) ?? [];
    list.push(reg);
    // Keep sorted for deterministic iteration
    list.sort((a, b) => b.priority - a.priority || a.order - b.order);
    this.regs.set(event, list);
    return () => {
      const cur = this.regs.get(event);
      if (!cur) return;
      const next = cur.filter((r) => r.id !== reg.id);
      if (next.length === 0) this.regs.delete(event);
      else this.regs.set(event, next);
    };
  }

  /** Number of handlers for an event (tests). */
  listenerCount(event: string): number {
    return this.regs.get(event)?.length ?? 0;
  }

  /** Snapshot of handler ids in execution order (tests). */
  handlerOrder(event: string): number[] {
    return (this.regs.get(event) ?? []).map((r) => r.id);
  }

  /**
   * Fire-and-forget emit (errors swallowed). Prefer emitAsync when
   * block/cancel control is needed (tool:before_call).
   */
  emit(event: LifecycleEventName | string, payload: unknown): void {
    void this.emitAsync(event, payload);
  }

  /**
   * Await all handlers (with timeout). Aggregates block requests.
   */
  async emitAsync(
    event: LifecycleEventName | string,
    payload: unknown,
  ): Promise<EmitResult> {
    const list = this.regs.get(event);
    const errors: EmitResult["errors"] = [];
    if (!list || list.length === 0) {
      return { blocked: false, errors };
    }

    let blocked = false;
    let blockReason: string | undefined;

    // Copy so unsubscribes mid-emit don't break iteration
    for (const reg of [...list]) {
      try {
        const result = await this.runHandler(reg, payload);
        if (result && typeof result === "object" && result.block) {
          blocked = true;
          blockReason = result.reason ?? blockReason ?? "blocked by hook";
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ event, message });
        this.log(`[hooks] ${event} handler failed`, {
          error: message,
          handlerId: reg.id,
        });
      }
    }

    return { blocked, blockReason, errors };
  }

  private async runHandler(
    reg: Registration,
    payload: unknown,
  ): Promise<HookControlResult | void> {
    const run = Promise.resolve().then(() => reg.handler(payload));
    if (!reg.timeoutMs || reg.timeoutMs <= 0) {
      return run;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`hook timeout after ${reg.timeoutMs}ms`)),
        reg.timeoutMs,
      );
    });
    try {
      return await Promise.race([run, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Remove all handlers (tests). */
  clear(): void {
    this.regs.clear();
  }
}

/** Process-wide lifecycle bus. */
let globalBus: EventBus | null = null;

export function getLifecycleBus(): EventBus {
  if (!globalBus) globalBus = new EventBus();
  return globalBus;
}

/** Replace global bus (tests). */
export function setLifecycleBus(bus: EventBus | null): void {
  globalBus = bus;
}

/** Create an isolated bus (tests / scoped runtimes). */
export function createEventBus(options?: EventBusOptions): EventBus {
  return new EventBus(options);
}
