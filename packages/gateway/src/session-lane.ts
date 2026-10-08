/**
 * Per-key FIFO lane (OpenClaw's "one serialized run per session").
 *
 * Two chat messages of the same conversation must never run at the same time:
 * the second one needs the first one's persisted answer in its history, and two
 * concurrent runs would interleave replies and tool side effects. Different
 * keys never wait for each other.
 *
 * acquire() resolves with a release function once every earlier holder of the
 * same key has released. Release is idempotent. A wait cap guarantees a stuck
 * run can never block a conversation forever.
 */
export interface KeyedLane {
  acquire(key: string, options?: { maxWaitMs?: number }): Promise<() => void>;
  /** Holders (running + waiting) currently registered for a key. */
  pending(key: string): number;
}

interface LaneEntry {
  tail: Promise<void>;
  count: number;
}

export function createKeyedLane(defaultMaxWaitMs = 15 * 60_000): KeyedLane {
  const lanes = new Map<string, LaneEntry>();

  return {
    pending: (key) => lanes.get(key)?.count ?? 0,

    async acquire(key, options = {}) {
      const entry = lanes.get(key) ?? { tail: Promise.resolve(), count: 0 };
      const previous = entry.tail;
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      entry.tail = previous.then(() => current);
      entry.count += 1;
      lanes.set(key, entry);

      let released = false;
      const done = () => {
        if (released) return;
        released = true;
        entry.count -= 1;
        release();
        if (entry.count <= 0 && lanes.get(key) === entry) lanes.delete(key);
      };

      const maxWaitMs = Math.max(0, options.maxWaitMs ?? defaultMaxWaitMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, maxWaitMs);
        // Never keep the process alive just for the wait cap.
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        await Promise.race([previous, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return done;
    },
  };
}
