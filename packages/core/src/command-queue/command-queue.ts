/**
 * Lane-aware command queue with per-session_key serialization and
 * followup / collect / interrupt / steer modes (Step 07).
 */

import { randomUUID } from "node:crypto";
import { resolveQueueMode } from "./resolve-mode.js";
import { getLifecycleBus } from "../hooks/index.js";
import type {
  ActiveRun,
  CommandQueueConfig,
  CommandStatus,
  EnqueueOptions,
  EnqueueResult,
  LaneId,
  QueueEvent,
  QueueListener,
  QueueMode,
  QueuedCommand,
  RunContext,
} from "./types.js";
import { DEFAULT_QUEUE_CONFIG } from "./types.js";

interface PendingEntry {
  command: QueuedCommand;
  execute?: EnqueueOptions["execute"];
}

interface SessionState {
  active?: ActiveRun;
  pending: PendingEntry[];
  /** Collect-mode buffer + timer. */
  collectBuffer: string[];
  collectTimer?: ReturnType<typeof setTimeout>;
  collectMeta?: { surface?: string; lane: LaneId; execute?: EnqueueOptions["execute"] };
}

function mergeConfig(partial?: Partial<CommandQueueConfig>): CommandQueueConfig {
  const base = { ...DEFAULT_QUEUE_CONFIG, ...partial };
  return {
    ...base,
    lanes: {
      main: { ...DEFAULT_QUEUE_CONFIG.lanes.main, ...partial?.lanes?.main },
      subagent: {
        ...DEFAULT_QUEUE_CONFIG.lanes.subagent,
        ...partial?.lanes?.subagent,
      },
      heartbeat: {
        ...DEFAULT_QUEUE_CONFIG.lanes.heartbeat,
        ...partial?.lanes?.heartbeat,
      },
    },
    surfaceModes: { ...DEFAULT_QUEUE_CONFIG.surfaceModes, ...partial?.surfaceModes },
    sessionModes: { ...DEFAULT_QUEUE_CONFIG.sessionModes, ...partial?.sessionModes },
  };
}

export class CommandQueue {
  private readonly config: CommandQueueConfig;
  private readonly sessions = new Map<string, SessionState>();
  /** Active run counts per lane (across sessions). */
  private readonly laneActive = new Map<LaneId, number>();
  /** Sessions waiting to start because lane is at capacity. */
  private readonly laneWaiters = new Map<LaneId, Array<() => void>>();
  private readonly listeners = new Set<QueueListener>();
  private globalPending = 0;
  private readonly eventLog: QueueEvent[] = [];
  private readonly maxEventLog = 200;

  constructor(config?: Partial<CommandQueueConfig>) {
    this.config = mergeConfig(config);
    for (const lane of Object.keys(this.config.lanes) as LaneId[]) {
      this.laneActive.set(lane, 0);
      this.laneWaiters.set(lane, []);
    }
  }

  on(listener: QueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getConfig(): CommandQueueConfig {
    return this.config;
  }

  /** Recent queue events (for diagnostics / acceptance tests). */
  events(): readonly QueueEvent[] {
    return this.eventLog;
  }

  isActive(session_key: string): boolean {
    return Boolean(this.sessions.get(session_key)?.active);
  }

  activeRunId(session_key: string): string | undefined {
    return this.sessions.get(session_key)?.active?.runId;
  }

  pendingCount(session_key?: string): number {
    if (session_key) {
      return this.sessions.get(session_key)?.pending.length ?? 0;
    }
    return this.globalPending;
  }

  laneActiveCount(lane: LaneId): number {
    return this.laneActive.get(lane) ?? 0;
  }

  /**
   * Enqueue a command for a session_key.
   * Guarantees at most one active run per session_key.
   */
  async enqueue(options: EnqueueOptions): Promise<EnqueueResult> {
    const session_key = options.session_key.trim();
    if (!session_key) {
      return { accepted: false, reason: "session_key is required" };
    }
    const lane: LaneId = options.lane ?? "main";
    const mode = resolveQueueMode(this.config, {
      session_key,
      surface: options.surface,
      inlineMode: options.mode,
    });

    const state = this.getSession(session_key);

    // ── interrupt: abort active, clear pending, run new immediately ──
    if (mode === "interrupt") {
      const abortedRunId = await this.abortSession(session_key, "interrupt");
      this.clearPending(session_key, "dropped");
      const command = this.makeCommand(session_key, lane, mode, options);
      return this.startOrQueue(state, command, options.execute, abortedRunId);
    }

    // ── active run present ──
    if (state.active) {
      if (mode === "steer") {
        if (state.active.inject) {
          state.active.inject([options.message]);
          this.emit({
            type: "steered",
            session_key,
            runId: state.active.runId,
            commandId: state.active.commandId,
            mode,
            detail: options.message.slice(0, 120),
            at: Date.now(),
          });
          const command = this.makeCommand(session_key, lane, mode, options);
          command.status = "coalesced";
          command.coalescedInto = state.active.commandId;
          command.runId = state.active.runId;
          return { accepted: true, command, mode };
        }
        // No inject hook — fall back
        const fallback = this.config.steerFallback;
        if (fallback === "interrupt") {
          const abortedRunId = await this.abortSession(session_key, "steer-fallback-interrupt");
          this.clearPending(session_key, "dropped");
          const command = this.makeCommand(session_key, lane, "interrupt", options);
          return this.startOrQueue(state, command, options.execute, abortedRunId);
        }
        if (fallback === "collect") {
          return this.enqueueCollect(state, session_key, lane, options);
        }
        // followup fallback
        return this.enqueueFollowup(state, session_key, lane, "followup", options);
      }

      if (mode === "collect") {
        return this.enqueueCollect(state, session_key, lane, options);
      }

      // followup (default path when active)
      return this.enqueueFollowup(state, session_key, lane, mode, options);
    }

    // ── no active run: collect still debounces; others start ──
    if (mode === "collect") {
      return this.enqueueCollect(state, session_key, lane, options);
    }

    const command = this.makeCommand(session_key, lane, mode, options);
    return this.startOrQueue(state, command, options.execute);
  }

  /** Abort the active run for a session (if any). */
  async abortSession(session_key: string, reason = "abort"): Promise<string | undefined> {
    const state = this.sessions.get(session_key);
    if (!state?.active) return undefined;
    const run = state.active;
    run.abort.abort(reason);
    this.emit({
      type: "cancelled",
      session_key,
      runId: run.runId,
      commandId: run.commandId,
      detail: reason,
      at: Date.now(),
    });
    // Active slot cleared by run.finally; wait briefly for cleanup
    const start = Date.now();
    while (state.active && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (state.active?.runId === run.runId) {
      // Force clear if executor ignored abort
      this.finishRun(session_key, run, "cancelled");
    }
    return run.runId;
  }

  /** Test helper: wait until session has no active run and no pending. */
  async drain(session_key: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const state = this.sessions.get(session_key);
      if (!state?.active && (!state || state.pending.length === 0) && !state?.collectTimer) {
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`drain timeout for ${session_key}`);
  }

  // ── internals ──────────────────────────────────────────

  private getSession(session_key: string): SessionState {
    let state = this.sessions.get(session_key);
    if (!state) {
      state = { pending: [], collectBuffer: [] };
      this.sessions.set(session_key, state);
    }
    return state;
  }

  private makeCommand(
    session_key: string,
    lane: LaneId,
    mode: QueueMode,
    options: EnqueueOptions,
  ): QueuedCommand {
    return {
      id: randomUUID(),
      session_key,
      lane,
      mode,
      message: options.message,
      payload: options.payload,
      surface: options.surface,
      enqueuedAt: Date.now(),
      status: "queued",
    };
  }

  private enqueueFollowup(
    state: SessionState,
    session_key: string,
    lane: LaneId,
    mode: QueueMode,
    options: EnqueueOptions,
  ): EnqueueResult {
    if (state.pending.length >= this.config.maxQueuePerSession) {
      return this.applyDropPolicy(state, session_key, lane, mode, options);
    }
    if (this.globalPending >= this.config.maxQueueGlobal) {
      return this.applyDropPolicy(state, session_key, lane, mode, options, true);
    }
    const command = this.makeCommand(session_key, lane, mode, options);
    state.pending.push({ command, execute: options.execute });
    this.globalPending++;
    this.emit({
      type: "enqueued",
      session_key,
      commandId: command.id,
      mode,
      at: Date.now(),
    });
    return { accepted: true, command, mode };
  }

  private enqueueCollect(
    state: SessionState,
    session_key: string,
    lane: LaneId,
    options: EnqueueOptions,
  ): EnqueueResult {
    state.collectBuffer.push(options.message);
    state.collectMeta = {
      surface: options.surface,
      lane,
      execute: options.execute ?? state.collectMeta?.execute,
    };
    if (state.collectTimer) {
      clearTimeout(state.collectTimer);
    }
    const command = this.makeCommand(session_key, lane, "collect", options);
    command.status = "queued";
    this.emit({
      type: "enqueued",
      session_key,
      commandId: command.id,
      mode: "collect",
      detail: `buffer=${state.collectBuffer.length}`,
      at: Date.now(),
    });

    state.collectTimer = setTimeout(() => {
      state.collectTimer = undefined;
      void this.flushCollect(session_key);
    }, this.config.collectDebounceMs);

    return { accepted: true, command, mode: "collect" };
  }

  private async flushCollect(session_key: string): Promise<void> {
    const state = this.sessions.get(session_key);
    if (!state || state.collectBuffer.length === 0) return;
    const messages = state.collectBuffer.splice(0, state.collectBuffer.length);
    const meta = state.collectMeta;
    state.collectMeta = undefined;
    const merged = messages.join("\n");
    const command = this.makeCommand(
      session_key,
      meta?.lane ?? "main",
      "collect",
      { session_key, message: merged, surface: meta?.surface },
    );
    this.emit({
      type: "coalesced",
      session_key,
      commandId: command.id,
      mode: "collect",
      detail: `${messages.length} messages`,
      at: Date.now(),
    });
    if (state.active) {
      // Active appeared during debounce — queue as followup
      if (state.pending.length < this.config.maxQueuePerSession) {
        state.pending.push({ command, execute: meta?.execute });
        this.globalPending++;
      }
      return;
    }
    await this.startOrQueue(state, command, meta?.execute);
  }

  private applyDropPolicy(
    state: SessionState,
    session_key: string,
    lane: LaneId,
    mode: QueueMode,
    options: EnqueueOptions,
    global = false,
  ): EnqueueResult {
    if (this.config.dropPolicy === "drop_oldest" && state.pending.length > 0) {
      const oldest = state.pending.shift()!;
      oldest.command.status = "dropped";
      this.globalPending = Math.max(0, this.globalPending - 1);
      this.emit({
        type: "dropped",
        session_key,
        commandId: oldest.command.id,
        mode,
        detail: global ? "global_full_drop_oldest" : "session_full_drop_oldest",
        at: Date.now(),
      });
      const command = this.makeCommand(session_key, lane, mode, options);
      state.pending.push({ command, execute: options.execute });
      this.globalPending++;
      this.emit({
        type: "enqueued",
        session_key,
        commandId: command.id,
        mode,
        at: Date.now(),
      });
      return { accepted: true, command, mode };
    }
    const command = this.makeCommand(session_key, lane, mode, options);
    command.status = "dropped";
    this.emit({
      type: "dropped",
      session_key,
      commandId: command.id,
      mode,
      detail: global ? "global_full_reject_new" : "session_full_reject_new",
      at: Date.now(),
    });
    return {
      accepted: false,
      command,
      mode,
      reason: global ? "global queue full" : "session queue full",
    };
  }

  private async startOrQueue(
    state: SessionState,
    command: QueuedCommand,
    execute?: EnqueueOptions["execute"],
    abortedRunId?: string,
  ): Promise<EnqueueResult> {
    if (state.active) {
      // Should not happen for interrupt path after abort; queue as safety
      state.pending.unshift({ command, execute });
      this.globalPending++;
      return { accepted: true, command, mode: command.mode, abortedRunId };
    }

    // Wait for lane capacity
    await this.acquireLaneSlot(command.lane);

    // Re-check: another start may have raced
    if (state.active) {
      state.pending.unshift({ command, execute });
      this.globalPending++;
      this.releaseLaneSlot(command.lane);
      return { accepted: true, command, mode: command.mode, abortedRunId };
    }

    const runId = randomUUID();
    const abort = new AbortController();
    const run: ActiveRun = {
      runId,
      session_key: command.session_key,
      lane: command.lane,
      commandId: command.id,
      startedAt: Date.now(),
      abort,
    };
    command.status = "active";
    command.runId = runId;
    state.active = run;

    this.emit({
      type: "started",
      session_key: command.session_key,
      commandId: command.id,
      runId,
      mode: command.mode,
      at: Date.now(),
    });
    getLifecycleBus().emit("session:start", {
      session_key: command.session_key,
      surface: command.surface,
      runId,
      mode: command.mode,
    });

    // Fire and forget execution — queue continues scheduling others
    void this.runCommand(state, command, run, execute);

    return { accepted: true, command, mode: command.mode, abortedRunId };
  }

  private async runCommand(
    state: SessionState,
    command: QueuedCommand,
    run: ActiveRun,
    execute?: EnqueueOptions["execute"],
  ): Promise<void> {
    const ctx: RunContext = {
      runId: run.runId,
      command,
      signal: run.abort.signal,
      onSteerInject: (inject) => {
        run.inject = inject;
      },
    };

    try {
      if (execute) {
        await execute(ctx);
      } else {
        // No executor: idle until aborted or microtask end (tests)
        await new Promise<void>((resolve, reject) => {
          if (run.abort.signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          const onAbort = () => {
            cleanup();
            reject(new Error("aborted"));
          };
          const cleanup = () => {
            run.abort.signal.removeEventListener("abort", onAbort);
          };
          run.abort.signal.addEventListener("abort", onAbort);
          // Complete immediately when no work — still holds session until next tick
          queueMicrotask(() => {
            cleanup();
            resolve();
          });
        });
      }
      if (!run.abort.signal.aborted) {
        command.status = "completed";
        this.emit({
          type: "completed",
          session_key: command.session_key,
          commandId: command.id,
          runId: run.runId,
          mode: command.mode,
          at: Date.now(),
        });
      } else {
        command.status = "cancelled";
      }
    } catch {
      command.status = run.abort.signal.aborted ? "cancelled" : "completed";
      if (command.status === "cancelled") {
        this.emit({
          type: "cancelled",
          session_key: command.session_key,
          commandId: command.id,
          runId: run.runId,
          mode: command.mode,
          at: Date.now(),
        });
      }
    } finally {
      this.finishRun(command.session_key, run, command.status);
      // Drain next pending for this session
      void this.pumpSession(command.session_key);
    }
  }

  private finishRun(
    session_key: string,
    run: ActiveRun,
    status: CommandStatus,
  ): void {
    const state = this.sessions.get(session_key);
    if (state?.active?.runId === run.runId) {
      state.active = undefined;
    }
    this.releaseLaneSlot(run.lane);
    getLifecycleBus().emit("session:end", {
      session_key,
      runId: run.runId,
      status,
      lane: run.lane,
    });
  }

  private async pumpSession(session_key: string): Promise<void> {
    const state = this.sessions.get(session_key);
    if (!state || state.active) return;
    const next = state.pending.shift();
    if (!next) return;
    this.globalPending = Math.max(0, this.globalPending - 1);
    await this.startOrQueue(state, next.command, next.execute);
  }

  private clearPending(session_key: string, status: CommandStatus): void {
    const state = this.sessions.get(session_key);
    if (!state) return;
    for (const entry of state.pending) {
      entry.command.status = status;
      this.emit({
        type: "dropped",
        session_key,
        commandId: entry.command.id,
        detail: "cleared_on_interrupt",
        at: Date.now(),
      });
    }
    this.globalPending = Math.max(0, this.globalPending - state.pending.length);
    state.pending = [];
    if (state.collectTimer) {
      clearTimeout(state.collectTimer);
      state.collectTimer = undefined;
    }
    state.collectBuffer = [];
    state.collectMeta = undefined;
  }

  private async acquireLaneSlot(lane: LaneId): Promise<void> {
    const cap = this.config.lanes[lane]?.concurrency ?? 1;
    const current = this.laneActive.get(lane) ?? 0;
    if (current < cap) {
      this.laneActive.set(lane, current + 1);
      return;
    }
    await new Promise<void>((resolve) => {
      const waiters = this.laneWaiters.get(lane) ?? [];
      waiters.push(() => {
        const c = this.laneActive.get(lane) ?? 0;
        this.laneActive.set(lane, c + 1);
        resolve();
      });
      this.laneWaiters.set(lane, waiters);
    });
  }

  private releaseLaneSlot(lane: LaneId): void {
    const current = this.laneActive.get(lane) ?? 0;
    const waiters = this.laneWaiters.get(lane) ?? [];
    if (waiters.length > 0) {
      const next = waiters.shift()!;
      // next waiter increments the count itself
      this.laneActive.set(lane, Math.max(0, current - 1));
      next();
      return;
    }
    this.laneActive.set(lane, Math.max(0, current - 1));
  }

  private emit(event: QueueEvent): void {
    this.eventLog.push(event);
    if (this.eventLog.length > this.maxEventLog) {
      this.eventLog.splice(0, this.eventLog.length - this.maxEventLog);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listeners must not break the queue
      }
    }
  }
}
