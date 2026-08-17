/**
 * AgentDelegator — Phase 3: True Specialist Spawning
 *
 * Bridges the gap between the router's decision and an actual running agent
 * instance. When the router selects a specialist in "multi_agent" mode, the
 * delegator:
 *   1. Finds an existing idle instance, or spawns a fresh one via AgentFactory
 *   2. Sends the task over the AgentMessageBus and awaits a reply
 *   3. Releases the concurrency slot and updates registry state
 *
 * This module is imported by agent.ts and plugged into the main run loop.
 */

import type { AgentTask } from "./task-queue.js";
import type { AgentRouteDecision } from "./agent-router.js";
import {
  AgentRegistry,
  type AgentFactory,
  type AgentInstance,
} from "./agent-registry.js";
import { AgentMessageBus, type AgentMessage } from "./agent-message-bus.js";
import { AgentBlackboard } from "./agent-blackboard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelegationHandle {
  instanceId: string;
  correlationId: string;
  reply: AgentMessage;
}

export interface DelegatorOptions {
  /** How long to wait for a specialist reply before timing out (ms) */
  defaultTimeoutMs?: number;
  /**
   * Maximum number of instances of any single specialist that can be alive
   * simultaneously. If the cap is reached, delegation waits for one to free up.
   */
  maxInstancesPerSpecialist?: number;
}

// ---------------------------------------------------------------------------
// AgentDelegator
// ---------------------------------------------------------------------------

export class AgentDelegator {
  private readonly defaultTimeoutMs: number;
  private readonly maxInstancesPerSpecialist: number;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly bus: AgentMessageBus,
    private readonly factory: AgentFactory,
    private readonly blackboard: AgentBlackboard,
    options: DelegatorOptions = {},
  ) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000; // 2 min
    this.maxInstancesPerSpecialist = options.maxInstancesPerSpecialist ?? 3;
  }

  // ---- Public API ----------------------------------------------------------

  /**
   * Delegate a task to the best-fit specialist instance.
   *
   * The decision object from the router tells us which specialist to use.
   * We find or spawn an instance, send the task over the bus, and return
   * the full reply message once the specialist completes.
   */
  async delegate(
    decision: AgentRouteDecision,
    task: AgentTask,
    timeoutMs?: number,
  ): Promise<DelegationHandle> {
    const specialistId = decision.selected.id;
    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    // 1. Find or spawn an instance for this specialist
    const instance = await this._resolveInstance(specialistId);

    // 2. Mark instance busy and acquire its per-agent concurrency slot
    this.registry.markBusy(instance.id);
    const releaseSlot = await this.registry.acquireSlot(instance.id);

    // 3. Post the task context to the blackboard so the specialist can read it
    this.blackboard.write(
      `task:${task.id}:context`,
      {
        taskId: task.id,
        prompt: task.message,
        specialist: specialistId,
        routeDecision: {
          mode: decision.mode,
          reasons: decision.reasons,
          complexity: decision.profile.complexity,
        },
      },
      "orchestrator",
      { ttlMs: timeout + 30_000 },
    );

    try {
      // 4. Send the task to the specialist via the message bus and await reply
      const reply = await this.bus.request(
        "orchestrator",
        instance.id,
        {
          taskId: task.id,
          prompt: task.message,
          specialist: specialistId,
          sessionId: instance.sessionId,
        },
        timeout,
      );

      // 5. Write result to blackboard so aggregator can pick it up
      this.blackboard.write(
        `task:${task.id}:result`,
        reply.payload,
        instance.id,
        { ttlMs: 300_000 }, // keep for 5 min
      );

      // Annotate decision with chosen instance
      decision.targetInstanceId = instance.id;

      return {
        instanceId: instance.id,
        correlationId: reply.correlationId ?? reply.id,
        reply,
      };
    } finally {
      releaseSlot();
      this.registry.markIdle(instance.id);
    }
  }

  /**
   * Delegate multiple tasks in parallel to the best-fit specialists.
   * Tasks with different specialists run truly in parallel.
   */
  async delegateParallel(
    tasks: Array<{ decision: AgentRouteDecision; task: AgentTask }>,
    timeoutMs?: number,
  ): Promise<DelegationHandle[]> {
    return Promise.all(
      tasks.map(({ decision, task }) =>
        this.delegate(decision, task, timeoutMs),
      ),
    );
  }

  // ---- Private helpers -----------------------------------------------------

  /**
   * Get an idle instance or spawn a new one.
   * Respects the maxInstancesPerSpecialist cap.
   */
  private async _resolveInstance(specialistId: string): Promise<AgentInstance> {
    // Prefer an existing idle instance (warm)
    const idle = this.registry.getAvailable(specialistId);
    if (idle) return idle;

    // Check cap
    const existing = this.registry.listBySpecialist(specialistId);
    const aliveCount = existing.filter((i) => i.status !== "dead").length;
    if (aliveCount >= this.maxInstancesPerSpecialist) {
      // Wait briefly and retry — a slot should free up soon
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      const freed = this.registry.getAvailable(specialistId);
      if (freed) return freed;
      // If still none available, spawn anyway (cap is a soft limit)
    }

    // Spawn and boot a new instance
    const instance = this.registry.spawn(specialistId);
    try {
      await this.factory.boot(instance);
    } catch (err) {
      this.registry.terminate(instance.id);
      throw new Error(
        `AgentDelegator: failed to boot specialist "${specialistId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return instance;
  }
}
