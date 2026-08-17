/**
 * Session Turn Lock
 *
 * `AgentOrchestrator.runAgentLoop()` / `runAgentLoopWithTask()` read and
 * mutate `_messageHistory` for a given sessionId with no synchronization of
 * their own. Two entry points can independently start a turn for the same
 * sessionId at any time:
 *
 *   1. A channel adapter (Telegram, Discord, WhatsApp, Slack, Feishu,
 *      DingTalk, Line, QQ, Matrix, IRC, MQTT, OneBot) receiving a message
 *      via `collectAgentResponse()`.
 *   2. The scheduler running a cron/scheduled task via
 *      `TaskScheduler._runScheduledTask` / `_runQueuedTask`.
 *
 * If both fire for the same sessionId at the same time (e.g. a scheduled
 * task is mid-run in a session and the user messages that same chat), the
 * two turns interleave against the same shared history array with no
 * isolation - the second turn can read history before the first has saved
 * its reply, tool calls can race, and results become inconsistent.
 *
 * This module provides a simple per-sessionId FIFO queue: whoever calls
 * `acquire(sessionId)` first runs first; every later caller for the *same*
 * sessionId waits for the current turn to fully finish (including its
 * history write) before starting. Different sessionIds never block each
 * other - only same-session turns are serialized. Callers do not need to
 * know whether the previous holder was a channel message or a scheduled
 * task; the lock treats every turn the same way.
 */

type Release = () => void;

interface QueueEntry {
  resolve: (release: Release) => void;
}

class SessionTurnLock {
  private readonly _queues = new Map<string, QueueEntry[]>();
  private readonly _locked = new Set<string>();

  /**
   * Wait for exclusive access to `sessionId`. Resolves with a release
   * function that MUST be called (typically in a `finally`) once the turn
   * is done, so the next queued caller (if any) can proceed.
   */
  acquire(sessionId: string): Promise<Release> {
    if (!this._locked.has(sessionId)) {
      this._locked.add(sessionId);
      return Promise.resolve(() => this._release(sessionId));
    }

    return new Promise<Release>((resolve) => {
      const queue = this._queues.get(sessionId) ?? [];
      queue.push({ resolve });
      this._queues.set(sessionId, queue);
    });
  }

  /**
   * Convenience wrapper: acquire the lock for `sessionId`, run `fn`, and
   * release afterwards even if `fn` throws.
   */
  async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(sessionId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private _release(sessionId: string): void {
    const queue = this._queues.get(sessionId);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) this._queues.delete(sessionId);
      // Lock stays held (for the next caller) - just hand off.
      next.resolve(() => this._release(sessionId));
      return;
    }
    this._queues.delete(sessionId);
    this._locked.delete(sessionId);
  }

  /** Test/diagnostic helper: is any turn currently holding this session? */
  isLocked(sessionId: string): boolean {
    return this._locked.has(sessionId);
  }

  /** Test/diagnostic helper: how many turns are waiting behind the current one? */
  waitingCount(sessionId: string): number {
    return this._queues.get(sessionId)?.length ?? 0;
  }
}

/**
 * Shared singleton. Every channel adapter (via `collectAgentResponse`) and
 * the scheduler both import this same instance so a channel message and a
 * scheduled task for the same sessionId always serialize against each
 * other, not just against callers of the same kind.
 */
export const sessionTurnLock = new SessionTurnLock();

// Exported for tests that need an isolated lock instead of the shared one.
export { SessionTurnLock };
