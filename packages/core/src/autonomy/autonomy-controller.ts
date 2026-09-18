import type Database from "better-sqlite3";
import type {
  AutonomyContext,
  AutonomyMode,
  AutonomyStatus,
  Objective,
  ResourceSnapshot,
} from "./types.js";
import { AutonomousGoalManager } from "./autonomous-goal-manager.js";
import { SqliteObjectiveStore } from "./objective-store.js";
import { AutonomyStateMachine } from "./state-machine.js";
import { profileForMode } from "./mode-config.js";
import { logAutonomyEvent } from "./logging.js";
import type { AutonomyConfig } from "./config.js";
import { parseAutonomyCommand } from "./command-parser.js";
import { setRuntimeAutonomyMode } from "./runtime-mode.js";

/** The minimal surface the controller needs from the host `Agent` —
 * intentionally much narrower than IOrchestrator, so HeartbeatEngine's own
 * contract doesn't have to grow to accommodate every autonomy dependency. */
export interface ScheduledTaskLike {
  id: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "dead_letter";
  lastError?: string | null;
}

export interface AutonomyControllerDeps {
  /** Sqlite handle dedicated to (or shared, with its own table for) autonomy state. */
  db: Database.Database;
  /** Bound to the existing TaskScheduler.schedule — reuses the real agent
   * loop / concurrency / retry machinery instead of a parallel executor. */
  schedule: (
    sessionId: string,
    message: string,
    cronExpression?: string,
    runAt?: number,
    options?: { maxAttempts?: number },
  ) => { id: string };
  getScheduledTask: (id: string) => ScheduledTaskLike | undefined;
  concurrentManager: { activeCount: number; maxConcurrent: number };
  /** Cheap health signal reused from elsewhere (e.g. the self-improvement
   * circuit breaker) rather than spending a real model call every pulse. */
  isProviderHealthy: () => boolean;
  /** Config-driven context hints (projects, research topics, etc.) —
   * anything live (failing tests, recent errors) can be merged in here by
   * the caller; the goal catalog only ever acts on what it's given. */
  hints: () => Record<string, unknown>;
  config: AutonomyConfig;
}

export class AutonomyController {
  private state = new AutonomyStateMachine("BOOT");
  private store: SqliteObjectiveStore;
  private manager: AutonomousGoalManager;
  private mode: AutonomyMode;
  private enabled: boolean;
  private paused = false;
  private tasksCompleted = 0;
  private tasksFailed = 0;
  private lastAction: string | null = null;
  private lastActionAt: number | null = null;
  private currentObjectiveId: string | null = null;
  private currentObjectiveStartedAt: number | null = null;
  private pulseCount = 0;

  constructor(private deps: AutonomyControllerDeps) {
    this.store = new SqliteObjectiveStore(deps.db);
    this.manager = new AutonomousGoalManager(this.store);
    this.mode = deps.config.mode;
    this.enabled = deps.config.enabled;
    setRuntimeAutonomyMode(this.mode);

    this.state.transition("INITIALIZING");
    this._resumeUnfinishedOnBoot();
    this.state.transition("ACTIVE");
    logAutonomyEvent(this.enabled ? "AUTONOMY_ENABLED" : "AUTONOMY_DISABLED", {
      mode: this.mode,
      reason: "boot",
    });
  }

  // ── Lifecycle / restart recovery (spec section 10) ──────────────────────
  private _resumeUnfinishedOnBoot(): void {
    const unfinished = this.store.listUnfinished();
    for (const objective of unfinished) {
      // If the process restarted mid-flight, whatever task id it was
      // waiting on no longer corresponds to anything the (new) scheduler
      // knows about. Clear it so the objective is picked up fresh rather
      // than waiting forever on a task that will never report back.
      if (objective.status === "in_progress" && objective.activeTaskId) {
        const task = this.deps.getScheduledTask(objective.activeTaskId);
        if (!task) {
          objective.status = "pending";
          objective.activeTaskId = undefined;
          this.store.update(objective);
        }
      }
    }
  }

  // ── User interruption (spec section 9) ──────────────────────────────────
  /** Call when a real user message arrives. Pure bookkeeping/logging — it
   * does not kill an in-flight autonomous task, since that task already
   * runs through the same concurrency-managed task scheduler as user work
   * and will simply be joined by it rather than blocking it. */
  markUserInteraction(): void {
    if (this.state.current === "USER_TASK") return;
    const inFlightStates: (typeof this.state.current)[] = [
      "EXECUTING",
      "PLANNING",
      "AUTONOMOUS",
      "IDLE_DECISION",
    ];
    if (inFlightStates.includes(this.state.current)) {
      logAutonomyEvent("AUTONOMOUS_INTERRUPTED", {
        id: this.currentObjectiveId,
        state: this.state.current,
      });
    }
    this.state.transition("USER_TASK");
  }

  // ── Controls (spec sections 16/17) ───────────────────────────────────────
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    logAutonomyEvent(enabled ? "AUTONOMY_ENABLED" : "AUTONOMY_DISABLED", {
      mode: this.mode,
    });
  }

  setMode(mode: AutonomyMode): void {
    if (mode === this.mode) return;
    const from = this.mode;
    this.mode = mode;
    setRuntimeAutonomyMode(mode);
    logAutonomyEvent("MODE_CHANGED", { from, to: mode });
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getMode(): AutonomyMode {
    return this.mode;
  }

  /** Lets ordinary chat control autonomy ("miki use turbo mode") without a
   * UI. Returns a short confirmation string if the message was a command,
   * or null if it wasn't (so callers know whether to still run it through
   * the normal agent loop). */
  handleChatCommand(message: string): string | null {
    const command = parseAutonomyCommand(message);
    if (!command) return null;
    switch (command.action) {
      case "set_mode":
        if (command.mode) this.setMode(command.mode);
        return `Autonomy mode set to ${command.mode?.toUpperCase()}.`;
      case "enable":
        this.setEnabled(true);
        return "Autonomy enabled.";
      case "disable":
        this.setEnabled(false);
        return "Autonomy disabled.";
      case "pause":
        this.pause();
        return "Autonomous work paused.";
      case "resume":
        this.resume();
        return "Autonomous work resumed.";
      case "status": {
        const status = this.getStatus();
        return status.currentObjective
          ? `Current objective: ${status.currentObjective.title} (${status.state}).`
          : `Idle — no active autonomous objective (${status.state}).`;
      }
      default:
        return null;
    }
  }

  getStatus(): AutonomyStatus {
    const current = this.currentObjectiveId
      ? (this.store.get(this.currentObjectiveId) ?? null)
      : null;
    return {
      enabled: this.enabled,
      mode: this.mode,
      state: this.state.current,
      currentObjective: current,
      currentObjectiveDurationMs: this.currentObjectiveStartedAt
        ? Date.now() - this.currentObjectiveStartedAt
        : null,
      nextDecisionInMs: null,
      tasksCompleted: this.tasksCompleted,
      tasksFailed: this.tasksFailed,
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt,
    };
  }

  getObjective(id: string): Objective | undefined {
    return this.store.get(id);
  }

  getHistory(limit = 50): Objective[] {
    return this.store.listRecent(limit);
  }

  // ── The heartbeat hook (spec section 14) ────────────────────────────────
  /** Called from HeartbeatEngine._pulse(). Must never throw — any error is
   * caught and routed through ERROR_RECOVERY so a bad cycle can't take the
   * whole heartbeat down (spec section 13). */
  async tick(
    idleMins: number,
    sysState: Record<string, unknown>,
  ): Promise<void> {
    this.pulseCount++;
    try {
      await this._tickInner(idleMins, sysState);
    } catch (err) {
      this.state.transition("ERROR_RECOVERY");
      logAutonomyEvent("ACTION_FAILED", {
        phase: "tick",
        error: err instanceof Error ? err.message : String(err),
      });
      this.state.transition("ACTIVE");
    }
  }

  private async _tickInner(
    idleMins: number,
    sysState: Record<string, unknown>,
  ): Promise<void> {
    if (!this.enabled || this.paused) return;
    if (this.state.current === "SHUTDOWN") return;

    const profile = profileForMode(this.mode);

    if (this.state.current === "USER_TASK") {
      if (idleMins < profile.idleThresholdMins) return; // user still engaged
      this.state.transition("ACTIVE");
      if (this.currentObjectiveId) {
        logAutonomyEvent("AUTONOMOUS_RESUMED", { id: this.currentObjectiveId });
      }
    }

    await this._checkActiveObjective();

    if (idleMins < profile.idleThresholdMins) return;
    if (this.currentObjectiveId) return; // one autonomous objective in flight at a time
    if (this.pulseCount % profile.planningEveryNPulses !== 0) return;

    const resource: ResourceSnapshot = {
      freeMemPct: Number(sysState["free_mem_pct"]) || 0,
      cpus: Number(sysState["cpus"]) || 1,
      activeTasks: this.deps.concurrentManager.activeCount,
      maxConcurrent: this.deps.concurrentManager.maxConcurrent,
      providerAvailable: this.deps.isProviderHealthy(),
    };

    const ceiling = Math.max(
      1,
      Math.ceil(
        Math.min(
          this.deps.concurrentManager.maxConcurrent *
            profile.concurrencyMultiplier,
          this.deps.concurrentManager.maxConcurrent +
            profile.maxConcurrentAutonomousTasks,
        ),
      ),
    );
    if (resource.activeTasks >= ceiling) {
      logAutonomyEvent("RESOURCE_THROTTLED", {
        reason: "concurrency_ceiling",
        activeTasks: resource.activeTasks,
        ceiling,
      });
      return;
    }

    this.state.transition("IDLE_DECISION");

    const ctx: AutonomyContext = {
      now: Date.now(),
      idleMins,
      mode: this.mode,
      unfinishedObjectives: this.store.listUnfinished(),
      recentObjectives: this.store.listRecent(30),
      resource,
      hints: this._collectHints(),
    };

    this.state.transition("AUTONOMOUS");
    const decision = this.manager.decide(ctx);
    if (!decision) {
      // Legitimately nothing useful to do right now.
      this.state.transition("ACTIVE");
      return;
    }

    this.state.transition("PLANNING");
    this.state.transition("EXECUTING");

    const sessionId = `autonomy-${decision.objective.id}`;
    const scheduled = this.deps.schedule(
      sessionId,
      decision.taskMessage,
      undefined,
      Date.now(),
    );
    decision.objective.activeTaskId = scheduled.id;
    decision.objective.sessionId = sessionId;
    this.store.update(decision.objective);

    this.currentObjectiveId = decision.objective.id;
    this.currentObjectiveStartedAt = Date.now();
    this.lastAction = decision.objective.title;
    this.lastActionAt = Date.now();
    logAutonomyEvent("ACTION_STARTED", {
      id: decision.objective.id,
      taskId: scheduled.id,
      type: decision.objective.type,
    });
  }

  private async _checkActiveObjective(): Promise<void> {
    if (!this.currentObjectiveId) return;
    const objective = this.store.get(this.currentObjectiveId);
    if (!objective?.activeTaskId) {
      this.currentObjectiveId = null;
      return;
    }
    const task = this.deps.getScheduledTask(objective.activeTaskId);
    if (!task || task.status === "pending" || task.status === "running") {
      return; // still in flight
    }

    this.state.transition("OBSERVING");
    const success = task.status === "completed";
    logAutonomyEvent(success ? "ACTION_COMPLETED" : "ACTION_FAILED", {
      id: objective.id,
      taskId: objective.activeTaskId,
    });

    this.state.transition("MEMORY_UPDATE");
    this.manager.recordOutcome(
      objective.id,
      success
        ? { success: true, summary: "Autonomous task completed." }
        : {
            success: false,
            summary: "Autonomous task did not complete successfully.",
            error: task.lastError ?? undefined,
          },
      this.mode,
    );

    if (success) this.tasksCompleted++;
    else this.tasksFailed++;

    this.currentObjectiveId = null;
    this.currentObjectiveStartedAt = null;

    this.state.transition("IDLE_DECISION");
    this.state.transition("ACTIVE");
  }

  private _collectHints(): Record<string, unknown> {
    try {
      return this.deps.hints() ?? {};
    } catch {
      return {};
    }
  }

  /** Spec section 1: on power-off, persist state and shut down cleanly.
   * Objective state is already durable after every write, so there is
   * nothing extra to flush here beyond marking the lifecycle state. */
  async shutdown(): Promise<void> {
    this.state.forceTransition("SHUTDOWN");
    logAutonomyEvent("AUTONOMY_DISABLED", {
      reason: "shutdown",
      mode: this.mode,
    });
  }
}

export function createAutonomyController(
  deps: AutonomyControllerDeps,
): AutonomyController {
  return new AutonomyController(deps);
}
