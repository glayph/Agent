import * as fs from "node:fs";
import * as path from "node:path";
import { stableEventFingerprint } from "./event-envelope.js";

export interface WatcherObservation {
  changed: boolean;
  fingerprint: string;
  summary: string;
  data?: Record<string, unknown>;
}

export interface DeterministicWatcher {
  id: string;
  intervalMs: number;
  check(
    signal: AbortSignal,
  ): Promise<Omit<WatcherObservation, "changed" | "fingerprint"> | unknown>;
}

export interface WatcherState {
  id: string;
  status: "healthy" | "degraded";
  lastFingerprint?: string;
  lastSummary?: string;
  lastCheckedAt?: string;
  lastChangedAt?: string;
  consecutiveFailures: number;
  lastError?: string;
}

interface WatcherFile {
  version: 1;
  states: WatcherState[];
}

export class WatcherRegistry {
  private readonly watchers = new Map<string, DeterministicWatcher>();
  private readonly states = new Map<string, WatcherState>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly filePath: string) {
    this.load();
  }

  register(watcher: DeterministicWatcher): void {
    if (!watcher.id.trim()) throw new Error("watcher id is required");
    if (!Number.isFinite(watcher.intervalMs) || watcher.intervalMs < 100) {
      throw new Error("watcher intervalMs must be at least 100ms");
    }
    this.watchers.set(watcher.id, watcher);
    if (!this.states.has(watcher.id)) {
      this.states.set(watcher.id, {
        id: watcher.id,
        status: "healthy",
        consecutiveFailures: 0,
      });
      this.save();
    }
  }

  start(
    onChanged: (
      watcher: DeterministicWatcher,
      observation: WatcherObservation,
    ) => void,
  ): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick(onChanged);
    }, this.nextInterval());
    void this.tick(onChanged);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(
    onChanged: (
      watcher: DeterministicWatcher,
      observation: WatcherObservation,
    ) => void,
  ): Promise<void> {
    const now = Date.now();
    for (const watcher of this.watchers.values()) {
      const state = this.states.get(watcher.id);
      if (
        state?.lastCheckedAt &&
        now - Date.parse(state.lastCheckedAt) < watcher.intervalMs
      ) {
        continue;
      }
      const controller = new AbortController();
      try {
        const raw = await watcher.check(controller.signal);
        const normalized = normalizeObservation(raw);
        const fingerprint = stableEventFingerprint(normalized);
        const changed =
          state?.lastFingerprint !== undefined &&
          state.lastFingerprint !== fingerprint;
        const observation: WatcherObservation = {
          ...normalized,
          fingerprint,
          changed,
        };
        const nextState: WatcherState = {
          id: watcher.id,
          status: "healthy",
          lastFingerprint: fingerprint,
          lastSummary: normalized.summary,
          lastCheckedAt: new Date().toISOString(),
          lastChangedAt: changed
            ? new Date().toISOString()
            : state?.lastChangedAt,
          consecutiveFailures: 0,
        };
        this.states.set(watcher.id, nextState);
        this.save();
        if (changed) onChanged(watcher, observation);
      } catch (error: unknown) {
        const nextState: WatcherState = {
          ...(state ?? { id: watcher.id }),
          status: "degraded",
          lastCheckedAt: new Date().toISOString(),
          consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
          lastError: error instanceof Error ? error.message : String(error),
        };
        this.states.set(watcher.id, nextState);
        this.save();
      } finally {
        controller.abort();
      }
    }
  }

  list(): WatcherState[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  health(): { healthy: number; degraded: number; total: number } {
    const states = this.list();
    return {
      healthy: states.filter((state) => state.status === "healthy").length,
      degraded: states.filter((state) => state.status === "degraded").length,
      total: states.length,
    };
  }

  private nextInterval(): number {
    return Math.max(
      100,
      Math.min(
        ...[...this.watchers.values()].map((watcher) => watcher.intervalMs),
        60_000,
      ),
    );
  }

  private load(): void {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf-8"),
      ) as WatcherFile;
      for (const state of Array.isArray(parsed.states) ? parsed.states : []) {
        if (state && typeof state.id === "string")
          this.states.set(state.id, state);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      temp,
      `${JSON.stringify({ version: 1, states: [...this.states.values()] }, null, 2)}\n`,
      "utf-8",
    );
    fs.renameSync(temp, this.filePath);
  }
}

function normalizeObservation(
  value: unknown,
): Omit<WatcherObservation, "changed" | "fingerprint"> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      summary:
        typeof record.summary === "string"
          ? record.summary
          : JSON.stringify(record),
      data: record,
    };
  }
  return { summary: String(value) };
}
