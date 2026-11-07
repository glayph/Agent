/**
 * Fair, abortable lock for stateful desktop/browser resources shared by the
 * gateway process. A lock is owned by a run (not an individual tool call), so
 * multi-step UI workflows cannot be interleaved with another run's actions.
 */
type Release = () => void;

/** Browser/computer state is run-scoped; immutable capability metadata is not. */
export function usesSharedInteractiveResource(toolName: string): boolean {
  return toolName.startsWith("browser_")
    || (toolName.startsWith("computer_") && toolName !== "computer_capabilities");
}

interface Waiter {
  runId: string;
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
  settled: boolean;
}

export class RunResourceLock {
  private owner: string | undefined;
  private readonly queue: Waiter[] = [];

  get queued(): number { return this.queue.length; }
  get currentOwner(): string | undefined { return this.owner; }

  acquire(runId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Release> {
    if (!runId.trim()) return Promise.reject(new Error("A run ID is required to acquire a shared resource."));
    if (options.signal?.aborted) return Promise.reject(this.abortError(options.signal.reason));
    if (this.owner === runId) return Promise.resolve(() => undefined);
    if (!this.owner) {
      this.owner = runId;
      return Promise.resolve(this.releaseFor(runId));
    }

    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, Math.floor(options.timeoutMs!)) : 0;
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { runId, resolve, reject, signal: options.signal, settled: false };
      const remove = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      };
      const fail = (error: Error) => {
        if (waiter.settled) return;
        waiter.settled = true;
        remove();
        cleanup();
        reject(error);
      };
      waiter.resolve = (release) => {
        if (waiter.settled) { release(); return; }
        waiter.settled = true;
        cleanup();
        resolve(release);
      };
      waiter.reject = fail;
      waiter.onAbort = () => fail(this.abortError(options.signal?.reason));
      options.signal?.addEventListener("abort", waiter.onAbort, { once: true });
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => fail(new Error(`Timed out waiting ${timeoutMs}ms for the shared browser/computer resource.`)), timeoutMs);
        waiter.timer.unref?.();
      }
      this.queue.push(waiter);
    });
  }

  private releaseFor(runId: string): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.owner !== runId) return;
      this.owner = undefined;
      while (this.queue.length) {
        const next = this.queue.shift()!;
        if (next.settled || next.signal?.aborted) continue;
        this.owner = next.runId;
        next.resolve(this.releaseFor(next.runId));
        break;
      }
    };
  }

  private abortError(reason: unknown): Error {
    if (reason instanceof Error) return reason;
    return new Error(reason ? String(reason) : "Shared resource lock acquisition was cancelled.");
  }
}


/** Serialize stateful browser/desktop tool calls within one run without blocking other runs. */
export class RunScopedSerialExecutor {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(runId: string, signal: AbortSignal, execute: () => Promise<T> | T): Promise<T> {
    if (!runId.trim()) throw new Error("A run ID is required to serialize an interactive action.");
    if (signal.aborted) throw this.abortError(signal.reason);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tails.get(runId) ?? Promise.resolve();
    this.tails.set(runId, current);
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(this.abortError(signal.reason)); return; }
        let settled = false;
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(this.abortError(signal.reason));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        previous.then(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        }, (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
      });
      if (signal.aborted) throw this.abortError(signal.reason);
      return await execute();
    } finally {
      release();
      if (this.tails.get(runId) === current) this.tails.delete(runId);
    }
  }

  private abortError(reason: unknown): Error {
    return reason instanceof Error ? reason : new Error(reason ? String(reason) : "Interactive action was cancelled.");
  }
}
