/**
 * AgentRegistry — Phase 1: Agent Lifecycle Manager
 *
 * Manages named, independent agent instances — each with their own state,
 * session, and lifecycle. Replaces the implicit "one agent" assumption with
 * a proper registry that can spawn, track, reuse, and terminate specialist agents.
 */

import * as crypto from "crypto";
import { EventEmitter } from "events";
import { ConcurrentTaskManager } from "./concurrent-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentInstanceStatus = "idle" | "busy" | "dead";

export interface AgentInstance {
  /** Unique instance ID, e.g. "researcher-01", "forge-ab3c" */
  id: string;
  /** Maps to AgentSpecialistDefinition.id */
  specialistId: string;
  status: AgentInstanceStatus;
  sessionId: string;
  spawnedAt: Date;
  lastActiveAt: Date;
  taskCount: number;
  /** Per-instance concurrency budget (defaults to 1 for specialists) */
  maxConcurrent: number;
}

export interface AgentRegistryEvents {
  spawned: (instance: AgentInstance) => void;
  terminated: (instance: AgentInstance) => void;
  statusChanged: (instance: AgentInstance, prev: AgentInstanceStatus) => void;
}

// ---------------------------------------------------------------------------
// AgentFactory interface
// ---------------------------------------------------------------------------

/**
 * AgentFactory is the contract that agent.ts must implement.
 * It boots a new specialist from an already-registered AgentInstance record.
 */
export interface AgentFactory {
  boot(instance: AgentInstance): Promise<void>;
  shutdown(instance: AgentInstance): Promise<void>;
}

// ---------------------------------------------------------------------------
// AgentRegistry
// ---------------------------------------------------------------------------

export class AgentRegistry extends EventEmitter {
  private instances: Map<string, AgentInstance> = new Map();
  /** Per-agent concurrency managers — separate from the global pool */
  private concurrencyManagers: Map<string, ConcurrentTaskManager> = new Map();

  constructor(private defaultMaxConcurrent: number = 1) {
    super();
  }

  // ---- Lifecycle -----------------------------------------------------------

  /**
   * Register and return a new AgentInstance for the given specialist.
   * Does NOT boot the agent — callers must call AgentFactory.boot(instance).
   */
  spawn(specialistId: string, maxConcurrent?: number): AgentInstance {
    const suffix = crypto.randomBytes(3).toString("hex");
    const id = `${specialistId}-${suffix}`;
    const sessionId = crypto.randomUUID();

    const instance: AgentInstance = {
      id,
      specialistId,
      status: "idle",
      sessionId,
      spawnedAt: new Date(),
      lastActiveAt: new Date(),
      taskCount: 0,
      maxConcurrent: maxConcurrent ?? this.defaultMaxConcurrent,
    };

    this.instances.set(id, instance);
    this.concurrencyManagers.set(
      id,
      new ConcurrentTaskManager(instance.maxConcurrent, 60_000),
    );

    this.emit("spawned", instance);
    return instance;
  }

  /**
   * Mark an instance as dead and remove it from the registry.
   */
  terminate(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    const prev = instance.status;
    instance.status = "dead";
    this.instances.delete(instanceId);
    this.concurrencyManagers.delete(instanceId);

    this.emit("terminated", instance);
    if (prev !== "dead") {
      this.emit("statusChanged", instance, prev);
    }
  }

  // ---- Status --------------------------------------------------------------

  markBusy(instanceId: string): void {
    this._setStatus(instanceId, "busy");
  }

  markIdle(instanceId: string): void {
    this._setStatus(instanceId, "idle");
  }

  private _setStatus(instanceId: string, status: AgentInstanceStatus): void {
    const instance = this.instances.get(instanceId);
    if (!instance || instance.status === status) return;
    const prev = instance.status;
    instance.status = status;
    instance.lastActiveAt = new Date();
    if (status === "busy") {
      instance.taskCount++;
    }
    this.emit("statusChanged", instance, prev);
  }

  // ---- Concurrency (per-agent) --------------------------------------------

  /**
   * Acquire a concurrency slot for a specific agent instance.
   * Returns a release function; throws on timeout.
   */
  acquireSlot(instanceId: string): Promise<() => void> {
    const manager = this.concurrencyManagers.get(instanceId);
    if (!manager) {
      return Promise.reject(
        new Error(`No concurrency manager for instance ${instanceId}`),
      );
    }
    return manager.acquire();
  }

  // ---- Queries -------------------------------------------------------------

  /**
   * Find an idle instance for the given specialistId, or null if none is free.
   */
  getAvailable(specialistId: string): AgentInstance | null {
    for (const instance of this.instances.values()) {
      if (
        instance.specialistId === specialistId &&
        instance.status === "idle"
      ) {
        return instance;
      }
    }
    return null;
  }

  get(instanceId: string): AgentInstance | undefined {
    return this.instances.get(instanceId);
  }

  list(): AgentInstance[] {
    return Array.from(this.instances.values());
  }

  listBySpecialist(specialistId: string): AgentInstance[] {
    return this.list().filter((i) => i.specialistId === specialistId);
  }

  /** Summary counts for health endpoints */
  summary(): {
    total: number;
    idle: number;
    busy: number;
    dead: number;
    bySpecialist: Record<string, number>;
  } {
    const counts = {
      total: 0,
      idle: 0,
      busy: 0,
      dead: 0,
      bySpecialist: {} as Record<string, number>,
    };
    for (const inst of this.instances.values()) {
      counts.total++;
      counts[inst.status]++;
      counts.bySpecialist[inst.specialistId] =
        (counts.bySpecialist[inst.specialistId] ?? 0) + 1;
    }
    return counts;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const globalAgentRegistry = new AgentRegistry();
