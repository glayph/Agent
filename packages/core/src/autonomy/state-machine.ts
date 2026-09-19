import type { AutonomyState } from "./types.js";
import { logAutonomyEvent } from "./logging.js";

/**
 * Legal transitions, matching the diagrams in the spec:
 *  - BOOT → INITIALIZING → ACTIVE is the power-on sequence.
 *  - ACTIVE ⇄ USER_TASK is ordinary conversation.
 *  - ACTIVE → IDLE_DECISION → AUTONOMOUS → PLANNING → EXECUTING →
 *    OBSERVING → MEMORY_UPDATE → (IDLE_DECISION | ACTIVE) is the
 *    autonomous cycle.
 *  - EXECUTING → USER_TASK lets a new user message interrupt autonomous
 *    work at any point (section 9); resuming goes back through ACTIVE.
 *  - ERROR_RECOVERY is reachable from anywhere action is taken.
 *  - SLEEP/SHUTDOWN are reachable from ACTIVE (and SLEEP can wake back up).
 */
const TRANSITIONS: Record<AutonomyState, AutonomyState[]> = {
  BOOT: ["INITIALIZING", "ERROR_RECOVERY"],
  INITIALIZING: ["ACTIVE", "ERROR_RECOVERY"],
  ACTIVE: [
    "USER_TASK",
    "IDLE_DECISION",
    "OBSERVING",
    "SLEEP",
    "SHUTDOWN",
    "ERROR_RECOVERY",
  ],
  USER_TASK: ["ACTIVE", "ERROR_RECOVERY", "SHUTDOWN"],
  IDLE_DECISION: [
    "AUTONOMOUS",
    "ACTIVE",
    "USER_TASK",
    "SLEEP",
    "ERROR_RECOVERY",
  ],
  AUTONOMOUS: ["PLANNING", "ACTIVE", "USER_TASK", "ERROR_RECOVERY"],
  PLANNING: ["EXECUTING", "ERROR_RECOVERY", "USER_TASK"],
  EXECUTING: ["OBSERVING", "USER_TASK", "ERROR_RECOVERY"],
  OBSERVING: ["MEMORY_UPDATE", "PLANNING", "ERROR_RECOVERY", "USER_TASK"],
  MEMORY_UPDATE: ["IDLE_DECISION", "ACTIVE", "USER_TASK"],
  SLEEP: ["ACTIVE", "SHUTDOWN"],
  SHUTDOWN: [],
  ERROR_RECOVERY: ["IDLE_DECISION", "ACTIVE", "SHUTDOWN"],
};

export type AutonomyStateListener = (
  from: AutonomyState,
  to: AutonomyState,
  meta?: Record<string, unknown>,
) => void;

export class InvalidTransitionError extends Error {
  constructor(from: AutonomyState, to: AutonomyState) {
    super(`Invalid autonomy state transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class AutonomyStateMachine {
  private state: AutonomyState;
  private listeners: AutonomyStateListener[] = [];
  private history: { state: AutonomyState; at: number }[] = [];

  constructor(initial: AutonomyState = "BOOT") {
    this.state = initial;
    this.history.push({ state: initial, at: Date.now() });
  }

  get current(): AutonomyState {
    return this.state;
  }

  canTransition(to: AutonomyState): boolean {
    return TRANSITIONS[this.state]?.includes(to) ?? false;
  }

  /**
   * Attempt a transition. Returns false (and logs, but does not throw) if
   * the transition is not legal from the current state — callers should
   * treat this as "stay put" rather than crash the controller.
   */
  transition(to: AutonomyState, meta?: Record<string, unknown>): boolean {
    if (this.state === to) return true;
    if (!this.canTransition(to)) {
      logAutonomyEvent("RESOURCE_THROTTLED", {
        reason: "invalid_transition",
        from: this.state,
        to,
      });
      return false;
    }
    const from = this.state;
    this.state = to;
    this.history.push({ state: to, at: Date.now() });
    if (this.history.length > 500) this.history.shift();
    for (const listener of this.listeners) {
      try {
        listener(from, to, meta);
      } catch {
        // Listener failures must never break the state machine itself.
      }
    }
    return true;
  }

  /** Force a transition regardless of the graph — reserved for
   * ERROR_RECOVERY paths and shutdown, where we must not get stuck. */
  forceTransition(to: AutonomyState, meta?: Record<string, unknown>): void {
    const from = this.state;
    this.state = to;
    this.history.push({ state: to, at: Date.now() });
    for (const listener of this.listeners) {
      try {
        listener(from, to, { ...meta, forced: true });
      } catch {
        // ignore listener errors
      }
    }
  }

  onChange(listener: AutonomyStateListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  recentHistory(limit = 50): { state: AutonomyState; at: number }[] {
    return this.history.slice(-limit);
  }
}
