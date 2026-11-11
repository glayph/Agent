/**
 * Per-key FIFO lane (OpenClaw's "one serialized run per session").
 *
 * Two chat messages of the same conversation must never run at the same time:
 * the second one needs the first one's persisted answer in its history, and two
 * concurrent runs would interleave replies and tool side effects. Different
 * keys never wait for each other.
 *
 * acquire() resolves with a release function once every earlier holder of the
 * same key has released. Release is idempotent. Waits are unbounded by default
 * and can be cancelled by their owning message without disturbing the holder.
 */
export interface KeyedLane {
  acquire(key: string, options?: { maxWaitMs?: number; signal?: AbortSignal }): Promise<() => void>;
  /** Holders (running + waiting) currently registered for a key. */
  pending(key: string): number;
  /** Aggregate queue snapshot; observation only, never a task lifetime limit. */
  snapshot(): {
    conversations: number;
    active: number;
    waiting: number;
    total: number;
    oldestActiveAgeMs: number;
    oldestWaitingAgeMs: number;
  };
}

/**
 * A lane wait timeout is a rejection, never permission to overlap the holder.
 * Starting a second run after a timeout would reintroduce interleaved history
 * and duplicate tool side effects, which the lane exists to prevent.
 */
export class LaneWaitAbortedError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Conversation lane '${key}' wait was cancelled by its owner.`);
    this.name = "LaneWaitAbortedError";
    this.key = key;
  }
}

export class LaneWaitTimeoutError extends Error {
  readonly key: string;
  readonly maxWaitMs: number;

  constructor(key: string, maxWaitMs: number) {
    super(`Conversation lane '${key}' did not become available within ${maxWaitMs}ms.`);
    this.name = "LaneWaitTimeoutError";
    this.key = key;
    this.maxWaitMs = maxWaitMs;
  }
}

interface LaneEntry {
  tail: Promise<void>;
  count: number;
  active: boolean;
  activeSince?: number;
  waiters: Map<symbol, number>;
}

export function createKeyedLane(defaultMaxWaitMs = 0): KeyedLane {
  const lanes = new Map<string, LaneEntry>();

  return {
    pending: (key) => lanes.get(key)?.count ?? 0,
    snapshot: () => {
      const sampledAt = Date.now();
      let active = 0;
      let waiting = 0;
      let total = 0;
      let oldestActiveAgeMs = 0;
      let oldestWaitingAgeMs = 0;
      for (const entry of lanes.values()) {
        total += entry.count;
        if (entry.active) {
          active += 1;
          oldestActiveAgeMs = Math.max(oldestActiveAgeMs, Math.max(0, sampledAt - (entry.activeSince ?? sampledAt)));
        }
        waiting += entry.waiters.size;
        for (const queuedAt of entry.waiters.values()) {
          oldestWaitingAgeMs = Math.max(oldestWaitingAgeMs, Math.max(0, sampledAt - queuedAt));
        }
      }
      return { conversations: lanes.size, active, waiting, total, oldestActiveAgeMs, oldestWaitingAgeMs };
    },

    async acquire(key, options = {}) {
      const entry = lanes.get(key) ?? { tail: Promise.resolve(), count: 0, active: false, waiters: new Map<symbol, number>() };
      const previous = entry.tail;
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      entry.tail = previous.then(() => current);
      entry.count += 1;
      const ticket = Symbol(key);
      entry.waiters.set(ticket, Date.now());
      lanes.set(key, entry);

      let released = false;
      let entered = false;
      const removeFromQueue = () => {
        entry.waiters.delete(ticket);
        entry.count -= 1;
        if (entry.count <= 0 && lanes.get(key) === entry) lanes.delete(key);
      };
      const done = () => {
        if (released) return;
        released = true;
        if (entered) {
          entry.active = false;
          entry.activeSince = undefined;
        }
        removeFromQueue();
        // A holder releases immediately. A cancelled waiter must preserve the
        // FIFO chain: resolve its private tail only after its predecessor does.
        if (entered) release();
        else void previous.then(release);
      };

      const maxWaitMs = Math.max(0, options.maxWaitMs ?? defaultMaxWaitMs);
      const signal = options.signal;
      if (signal?.aborted) {
        done();
        throw new LaneWaitAbortedError(key);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let aborted = false;
      let abortListener: (() => void) | undefined;
      const races: Array<Promise<void>> = [previous];
      if (maxWaitMs > 0) {
        races.push(new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, maxWaitMs);
          (timer as { unref?: () => void }).unref?.();
        }));
      }
      if (signal) {
        races.push(new Promise<void>((resolve) => {
          abortListener = () => { aborted = true; resolve(); };
          signal.addEventListener("abort", abortListener, { once: true });
          if (signal.aborted) abortListener();
        }));
      }
      try {
        await Promise.race(races);
      } finally {
        if (timer) clearTimeout(timer);
        if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      }
      if (aborted || signal?.aborted) {
        done();
        throw new LaneWaitAbortedError(key);
      }
      if (timedOut) {
        done();
        throw new LaneWaitTimeoutError(key, maxWaitMs);
      }
      if (signal?.aborted) {
        done();
        throw new LaneWaitAbortedError(key);
      }
      entry.waiters.delete(ticket);
      entry.active = true;
      entry.activeSince = Date.now();
      entered = true;
      return done;

    },
  };
}
