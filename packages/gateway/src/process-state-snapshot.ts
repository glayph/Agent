import * as fs from "fs";
import * as path from "path";

/**
 * Process-level state snapshot for the gateway's core-process supervisor.
 *
 * Scope note: conversation content itself does NOT need to be snapshotted
 * here. `_messageHistory` in `packages/core/src/agent.ts` (a protected
 * file) is pure in-memory, but every completed turn is already written to
 * the durable Knowledge Graph memory system via `memory-bridge.ts` before
 * the turn returns - so a crash only loses an in-flight/unfinished turn,
 * never confirmed history. What this snapshot exists for is
 * process-supervision state that would otherwise be lost across a
 * kill+restart cycle and would slow or corrupt recovery: restart
 * bookkeeping and the last confirmed-healthy timestamp, so the gateway
 * (and anyone inspecting `data/process-state.json` after an unclean exit)
 * can tell a fresh cold start apart from a supervised recovery.
 *
 * Written atomically (tmp file + rename) following the same pattern as
 * `packages/core/src/safety/safe-mode.ts`.
 */

export interface ProcessStateSnapshot {
  /** ISO timestamp of the last time the core process answered /health. */
  lastHealthyAt: string | null;
  /** Cumulative restart attempts since the gateway itself last cold-started. */
  restartAttempts: number;
  /** Set right before a clean, intentional shutdown; cleared on boot. */
  cleanShutdown: boolean;
  /** ISO timestamp this snapshot was written. */
  updatedAt: string;
}

function emptySnapshot(): ProcessStateSnapshot {
  return {
    lastHealthyAt: null,
    restartAttempts: 0,
    cleanShutdown: false,
    updatedAt: new Date().toISOString(),
  };
}

function sanitizeSnapshot(value: unknown): ProcessStateSnapshot {
  if (!value || typeof value !== "object") return emptySnapshot();
  const parsed = value as Partial<ProcessStateSnapshot>;
  const lastHealthyAt =
    typeof parsed.lastHealthyAt === "string" &&
    !Number.isNaN(Date.parse(parsed.lastHealthyAt))
      ? parsed.lastHealthyAt
      : null;
  const restartAttempts =
    typeof parsed.restartAttempts === "number" &&
    Number.isFinite(parsed.restartAttempts) &&
    parsed.restartAttempts >= 0
      ? Math.floor(parsed.restartAttempts)
      : 0;
  const cleanShutdown = parsed.cleanShutdown === true;
  const updatedAt =
    typeof parsed.updatedAt === "string" &&
    !Number.isNaN(Date.parse(parsed.updatedAt))
      ? parsed.updatedAt
      : new Date().toISOString();
  return { lastHealthyAt, restartAttempts, cleanShutdown, updatedAt };
}

export class ProcessStateStore {
  constructor(private readonly statePath: string) {}

  read(): ProcessStateSnapshot {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf-8"));
      return sanitizeSnapshot(parsed);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return emptySnapshot();
      }
      // A corrupt snapshot must never block startup - treat it as absent
      // and let the gateway proceed with a cold-start baseline.
      return emptySnapshot();
    }
  }

  private write(next: ProcessStateSnapshot): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmpPath = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, this.statePath);
  }

  /** Call once per successful /health poll. */
  recordHealthy(): void {
    const current = this.read();
    this.write({
      ...current,
      lastHealthyAt: new Date().toISOString(),
      cleanShutdown: false,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Call each time attemptCoreRestart() actually schedules a restart. */
  recordRestartAttempt(): void {
    const current = this.read();
    this.write({
      ...current,
      restartAttempts: current.restartAttempts + 1,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Call on graceful shutdown so the next boot can tell it wasn't a crash. */
  recordCleanShutdown(): void {
    const current = this.read();
    this.write({
      ...current,
      cleanShutdown: true,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Call once on gateway boot, after reading the prior snapshot. */
  resetForColdStart(): void {
    this.write({
      lastHealthyAt: null,
      restartAttempts: 0,
      cleanShutdown: false,
      updatedAt: new Date().toISOString(),
    });
  }
}

export function createProcessStateStore(
  workspaceDir: string,
): ProcessStateStore {
  return new ProcessStateStore(
    path.join(workspaceDir, "data", "process-state.json"),
  );
}
