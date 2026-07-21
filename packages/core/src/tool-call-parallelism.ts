export type ToolLockMode = "shared" | "exclusive";

export interface ToolInvocationLike {
  toolName: string;
  toolArgs: Record<string, unknown>;
}

export interface ToolResourceLock {
  key: string;
  mode: ToolLockMode;
}

export interface ToolRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface ToolConcurrencyPolicy {
  toolName: string;
  readOnly: boolean;
  stateless: boolean;
  timeoutMs: number;
  retry: ToolRetryPolicy;
  locks: ToolResourceLock[];
}

export interface PlannedToolInvocation<T extends ToolInvocationLike> {
  invocation: T;
  policy: ToolConcurrencyPolicy;
  index: number;
}

export interface ToolExecutionLevel<T extends ToolInvocationLike> {
  parallel: boolean;
  items: Array<PlannedToolInvocation<T>>;
}

export interface ToolExecutionPlan<T extends ToolInvocationLike> {
  levels: Array<ToolExecutionLevel<T>>;
  totalInvocations: number;
  parallelizable: boolean;
}

export interface ToolConcurrencyStats {
  plannedInvocations: number;
  plannedLevels: number;
  parallelLevels: number;
  activeInvocations: number;
  maxObservedParallel: number;
  completedInvocations: number;
  failedInvocations: number;
  retriedInvocations: number;
  totalLockWaitMs: number;
  lockTimeouts: number;
}

interface ToolPolicyTemplate {
  readOnly: boolean;
  stateless: boolean;
  timeoutMs: number;
  retry?: Partial<ToolRetryPolicy>;
  locks: (args: Record<string, unknown>) => ToolResourceLock[];
}

interface LockWaiter {
  mode: ToolLockMode;
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

interface LockState {
  activeShared: number;
  activeExclusive: boolean;
  queue: LockWaiter[];
}

const DEFAULT_RETRY_POLICY: ToolRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
};

const DEFAULT_TIMEOUT_MS = 60_000;

function stringArg(
  args: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizedKeyPart(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/") || "default";
}

function fileLocks(
  args: Record<string, unknown>,
  mode: ToolLockMode,
): ToolResourceLock[] {
  const pathKey = normalizedKeyPart(stringArg(args, "path", "unknown"));
  return [
    { key: "workspace", mode: "shared" },
    { key: `file:${pathKey}`, mode },
  ];
}

function sharedResource(key: string): ToolResourceLock[] {
  return [{ key, mode: "shared" }];
}

function exclusiveResource(key: string): ToolResourceLock[] {
  return [{ key, mode: "exclusive" }];
}

function mergeRetryPolicy(retry?: Partial<ToolRetryPolicy>): ToolRetryPolicy {
  return {
    maxAttempts: Math.max(
      1,
      Math.floor(retry?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts),
    ),
    baseDelayMs: Math.max(
      0,
      Math.floor(retry?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs),
    ),
    maxDelayMs: Math.max(
      0,
      Math.floor(retry?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs),
    ),
  };
}

const TOOL_POLICY_TEMPLATES = new Map<string, ToolPolicyTemplate>([
  [
    "file_read",
    {
      readOnly: true,
      stateless: false,
      timeoutMs: 30_000,
      locks: (args) => fileLocks(args, "shared"),
    },
  ],
  [
    "file_write",
    {
      readOnly: false,
      stateless: false,
      timeoutMs: 60_000,
      locks: (args) => fileLocks(args, "exclusive"),
    },
  ],
  [
    "file_delete",
    {
      readOnly: false,
      stateless: false,
      timeoutMs: 60_000,
      locks: (args) => fileLocks(args, "exclusive"),
    },
  ],
  [
    "shell_execute",
    {
      readOnly: false,
      stateless: false,
      timeoutMs: 120_000,
      retry: { maxAttempts: 1 },
      locks: () => exclusiveResource("workspace"),
    },
  ],
  [
    "direct_download_search",
    {
      readOnly: true,
      stateless: true,
      timeoutMs: 10_000,
      locks: () => [],
    },
  ],
  [
    "model_list",
    {
      readOnly: true,
      stateless: false,
      timeoutMs: 15_000,
      locks: () => sharedResource("model-registry"),
    },
  ],
  [
    "model_add",
    {
      readOnly: false,
      stateless: false,
      timeoutMs: 30_000,
      locks: () => exclusiveResource("model-registry"),
    },
  ],
  [
    "model_delete",
    {
      readOnly: false,
      stateless: false,
      timeoutMs: 30_000,
      locks: () => exclusiveResource("model-registry"),
    },
  ],
  [
    "model_select",
    {
      readOnly: false,
      stateless: false,
      timeoutMs: 30_000,
      locks: () => exclusiveResource("model-registry"),
    },
  ],
  [
    "goal_status",
    {
      readOnly: true,
      stateless: false,
      timeoutMs: 15_000,
      locks: () => sharedResource("goals"),
    },
  ],
  [
    "goal_create",
    {
      readOnly: false,
      stateless: false,
      timeoutMs: 30_000,
      locks: () => exclusiveResource("goals"),
    },
  ],
  [
    "goal_update",
    {
      readOnly: false,
      stateless: false,
      timeoutMs: 30_000,
      locks: () => exclusiveResource("goals"),
    },
  ],
  [
    "project_workflow_create",
    {
      readOnly: false,
      stateless: false,
      timeoutMs: 120_000,
      retry: { maxAttempts: 1 },
      locks: () => exclusiveResource("workspace"),
    },
  ],
]);

const BROWSER_TOOLS = new Set([
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_extract",
  "browser_screenshot",
  "browser_scroll",
  "browser_close",
  "scrape_page",
  "scrape_selectors",
  "scrape_paginated",
  "scrape_infinite_scroll",
  "scrape_json",
  "scrape_table",
]);

export function getToolConcurrencyPolicy(
  toolName: string,
  args: Record<string, unknown>,
): ToolConcurrencyPolicy {
  const browserPolicy = BROWSER_TOOLS.has(toolName)
    ? {
        readOnly: false,
        stateless: false,
        timeoutMs: toolName.startsWith("scrape") ? 120_000 : 90_000,
        retry: { maxAttempts: 2 },
        locks: () => exclusiveResource("browser:default"),
      }
    : undefined;

  const template = TOOL_POLICY_TEMPLATES.get(toolName) ??
    browserPolicy ?? {
      readOnly: false,
      stateless: false,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      retry: { maxAttempts: 1 },
      locks: () => exclusiveResource(`tool:${toolName}`),
    };

  return {
    toolName,
    readOnly: template.readOnly,
    stateless: template.stateless,
    timeoutMs: template.timeoutMs,
    retry: mergeRetryPolicy(template.retry),
    locks: normalizeLocks(template.locks(args)),
  };
}

export function normalizeLocks(locks: ToolResourceLock[]): ToolResourceLock[] {
  const byKey = new Map<string, ToolLockMode>();
  for (const lock of locks) {
    const key = normalizedKeyPart(lock.key);
    const existing = byKey.get(key);
    if (existing === "exclusive" || lock.mode === "exclusive") {
      byKey.set(key, "exclusive");
    } else {
      byKey.set(key, "shared");
    }
  }
  return [...byKey.entries()]
    .map(([key, mode]) => ({ key, mode }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function locksConflict(
  left: ToolResourceLock[],
  right: ToolResourceLock[],
): boolean {
  for (const a of left) {
    for (const b of right) {
      if (
        a.key === b.key &&
        (a.mode === "exclusive" || b.mode === "exclusive")
      ) {
        return true;
      }
    }
  }
  return false;
}

export function createToolExecutionPlan<T extends ToolInvocationLike>(
  invocations: T[],
): ToolExecutionPlan<T> {
  const planned = invocations.map((invocation, index) => ({
    invocation,
    index,
    policy: getToolConcurrencyPolicy(invocation.toolName, invocation.toolArgs),
  }));

  const dependents = new Map<number, Set<number>>();
  const inDegree = new Map<number, number>();

  for (const item of planned) {
    dependents.set(item.index, new Set());
    inDegree.set(item.index, 0);
  }

  for (let i = 0; i < planned.length; i++) {
    for (let j = i + 1; j < planned.length; j++) {
      if (!locksConflict(planned[i].policy.locks, planned[j].policy.locks)) {
        continue;
      }
      dependents.get(i)!.add(j);
      inDegree.set(j, (inDegree.get(j) ?? 0) + 1);
    }
  }

  const ready = planned
    .filter((item) => (inDegree.get(item.index) ?? 0) === 0)
    .sort((a, b) => a.index - b.index);
  const levels: Array<ToolExecutionLevel<T>> = [];
  let processed = 0;

  while (ready.length > 0) {
    const levelItems = ready.splice(0, ready.length);
    levels.push({
      parallel: levelItems.length > 1,
      items: levelItems,
    });
    processed += levelItems.length;

    for (const item of levelItems) {
      for (const dependent of dependents.get(item.index) ?? []) {
        const nextDegree = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, nextDegree);
        if (nextDegree === 0) {
          ready.push(planned[dependent]);
        }
      }
    }
    ready.sort((a, b) => a.index - b.index);
  }

  if (processed !== planned.length) {
    throw new Error("Circular dependency detected in tool execution plan");
  }

  return {
    levels,
    totalInvocations: planned.length,
    parallelizable: levels.some((level) => level.parallel),
  };
}

export function resolveParallelToolCallLimit(
  value: unknown,
  fallback: number,
): number {
  const raw =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.min(100, Math.floor(raw)));
}

export async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const workerCount = Math.min(
    items.length,
    resolveParallelToolCallLimit(limit, 1),
  );
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) return;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}

export class ToolConcurrencyMetrics {
  private stats: ToolConcurrencyStats = {
    plannedInvocations: 0,
    plannedLevels: 0,
    parallelLevels: 0,
    activeInvocations: 0,
    maxObservedParallel: 0,
    completedInvocations: 0,
    failedInvocations: 0,
    retriedInvocations: 0,
    totalLockWaitMs: 0,
    lockTimeouts: 0,
  };

  recordPlan<T extends ToolInvocationLike>(plan: ToolExecutionPlan<T>): void {
    this.stats.plannedInvocations += plan.totalInvocations;
    this.stats.plannedLevels += plan.levels.length;
    this.stats.parallelLevels += plan.levels.filter(
      (level) => level.parallel,
    ).length;
  }

  beginInvocation(): void {
    this.stats.activeInvocations++;
    this.stats.maxObservedParallel = Math.max(
      this.stats.maxObservedParallel,
      this.stats.activeInvocations,
    );
  }

  endInvocation(ok: boolean): void {
    this.stats.activeInvocations = Math.max(
      0,
      this.stats.activeInvocations - 1,
    );
    if (ok) this.stats.completedInvocations++;
    else this.stats.failedInvocations++;
  }

  recordRetry(): void {
    this.stats.retriedInvocations++;
  }

  recordLockWait(waitMs: number): void {
    this.stats.totalLockWaitMs += Math.max(0, Math.floor(waitMs));
  }

  recordLockTimeout(): void {
    this.stats.lockTimeouts++;
  }

  snapshot(): ToolConcurrencyStats {
    return { ...this.stats };
  }
}

export class ToolResourceLockManager {
  private states = new Map<string, LockState>();

  constructor(private acquireTimeoutMs = 30_000) {}

  setAcquireTimeoutMs(timeoutMs: number): void {
    this.acquireTimeoutMs = Math.max(1_000, Math.min(300_000, timeoutMs));
  }

  async acquireMany(
    locks: ToolResourceLock[],
    signal?: AbortSignal,
  ): Promise<{ release: () => void; waitMs: number }> {
    const normalized = normalizeLocks(locks);
    if (normalized.length === 0) return { release: () => {}, waitMs: 0 };

    const startedAt = Date.now();
    const releases: Array<() => void> = [];

    try {
      for (const lock of normalized) {
        const release = await this.acquireOne(lock, signal);
        releases.push(release);
      }
      return {
        release: () => {
          for (const release of releases.reverse()) release();
        },
        waitMs: Date.now() - startedAt,
      };
    } catch (err) {
      for (const release of releases.reverse()) release();
      throw err;
    }
  }

  getStats(): { lockedResources: number; waitingLocks: number } {
    let waitingLocks = 0;
    for (const state of this.states.values()) {
      waitingLocks += state.queue.length;
    }
    return { lockedResources: this.states.size, waitingLocks };
  }

  private acquireOne(
    lock: ToolResourceLock,
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new Error("Tool execution cancelled"));
    }

    const state = this.stateFor(lock.key);
    if (this.canAcquireImmediately(state, lock.mode)) {
      this.activate(state, lock.mode);
      return Promise.resolve(() => this.release(lock.key, lock.mode));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: LockWaiter = {
        mode: lock.mode,
        resolve: () => {
          cleanup();
          this.activate(state, lock.mode);
          resolve(() => this.release(lock.key, lock.mode));
        },
        reject,
      };

      const onAbort = () => {
        cleanup();
        const index = state.queue.indexOf(waiter);
        if (index >= 0) state.queue.splice(index, 1);
        reject(new Error("Tool execution cancelled"));
      };

      const cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        signal?.removeEventListener("abort", onAbort);
      };

      if (this.acquireTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          cleanup();
          const index = state.queue.indexOf(waiter);
          if (index >= 0) state.queue.splice(index, 1);
          reject(
            new Error(
              `Tool resource lock timeout after ${this.acquireTimeoutMs}ms for ${lock.key}`,
            ),
          );
        }, this.acquireTimeoutMs);
      }

      signal?.addEventListener("abort", onAbort, { once: true });
      state.queue.push(waiter);
    });
  }

  private stateFor(key: string): LockState {
    let state = this.states.get(key);
    if (!state) {
      state = { activeShared: 0, activeExclusive: false, queue: [] };
      this.states.set(key, state);
    }
    return state;
  }

  private canAcquireImmediately(state: LockState, mode: ToolLockMode): boolean {
    if (state.queue.length > 0) return false;
    if (mode === "shared") return !state.activeExclusive;
    return !state.activeExclusive && state.activeShared === 0;
  }

  private activate(state: LockState, mode: ToolLockMode): void {
    if (mode === "shared") state.activeShared++;
    else state.activeExclusive = true;
  }

  private release(key: string, mode: ToolLockMode): void {
    const state = this.states.get(key);
    if (!state) return;
    if (mode === "shared")
      state.activeShared = Math.max(0, state.activeShared - 1);
    else state.activeExclusive = false;
    this.drainQueue(state);
    if (
      state.activeShared === 0 &&
      !state.activeExclusive &&
      state.queue.length === 0
    ) {
      this.states.delete(key);
    }
  }

  private drainQueue(state: LockState): void {
    while (state.queue.length > 0) {
      const next = state.queue[0];
      if (next.mode === "exclusive") {
        if (state.activeExclusive || state.activeShared > 0) return;
        state.queue.shift();
        next.resolve();
        return;
      }

      if (state.activeExclusive) return;
      const sharedWaiters: LockWaiter[] = [];
      while (state.queue[0]?.mode === "shared") {
        sharedWaiters.push(state.queue.shift()!);
      }
      for (const waiter of sharedWaiters) waiter.resolve();
    }
  }
}
