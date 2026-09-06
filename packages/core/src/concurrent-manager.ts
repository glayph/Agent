import { EventEmitter } from "events";

interface WaitingItem {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export class ConcurrentTaskManager extends EventEmitter {
  private _maxConcurrent: number;
  private _active: number = 0;
  private _waiting: WaitingItem[] = [];

  constructor(
    maxConcurrent: number = 3,
    private acquireTimeoutMs?: number,
  ) {
    super();
    this._maxConcurrent = maxConcurrent;
  }

  setMaxConcurrent(maxConcurrent: number): void {
    const oldMax = this._maxConcurrent;
    this._maxConcurrent = maxConcurrent;
    // Only fulfill waiting tasks when INCREASING the limit (more capacity available)
    // Lowering limit should NOT trigger new task starts
    if (maxConcurrent > oldMax) {
      this._tryFulfillWaiting();
    }
  }

  private _tryFulfillWaiting(): void {
    while (this._waiting.length > 0 && this._active < this._maxConcurrent) {
      const waiter = this._waiting.shift()!;
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      this._active++;
      this.emit("acquire", this._active);
      waiter.resolve(() => this.release());
    }
  }

  acquire(): Promise<() => void> {
    if (this._active < this._maxConcurrent) {
      this._active++;
      this.emit("acquire", this._active);

      return Promise.resolve(() => {
        this.release();
      });
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: WaitingItem = { resolve, reject };

      if (this.acquireTimeoutMs && this.acquireTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this._waiting.indexOf(waiter);
          if (idx >= 0) {
            this._waiting.splice(idx, 1);
            reject(
              new Error(`Acquire timeout after ${this.acquireTimeoutMs}ms`),
            );
          }
        }, this.acquireTimeoutMs);
      }

      this._waiting.push(waiter);
    });
  }

  release(): void {
    this._active = Math.max(0, this._active - 1);
    this.emit("release", this._active);

    // After releasing, try to fulfill waiting tasks if capacity allows
    // The while loop in _tryFulfillWaiting ensures we only fulfill up to capacity
    this._tryFulfillWaiting();
  }

  get activeCount(): number {
    return this._active;
  }

  get maxConcurrent(): number {
    return this._maxConcurrent;
  }

  get waitingCount(): number {
    return this._waiting.length;
  }

  isAtCapacity(): boolean {
    return this._active >= this._maxConcurrent;
  }
}
