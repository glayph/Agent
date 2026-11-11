import type { MemoryHookEvent, MemoryHookPayloads } from "./types.js";

type Listener<E extends MemoryHookEvent> = (
  payload: MemoryHookPayloads[E],
) => void | Promise<void>;

/**
 * Tiny typed event seam for the memory subsystem. Step 11 (lifecycle hooks)
 * subscribes here; until then it has no listeners and costs nothing.
 * A misbehaving listener can never break memory or the turn: errors and
 * rejections are swallowed and logged.
 */
export class MemoryHooks {
  private listeners = new Map<MemoryHookEvent, Set<Listener<MemoryHookEvent>>>();

  on<E extends MemoryHookEvent>(event: E, listener: Listener<E>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as Listener<MemoryHookEvent>);
    this.listeners.set(event, set);
    return () => set.delete(listener as Listener<MemoryHookEvent>);
  }

  emit<E extends MemoryHookEvent>(
    event: E,
    payload: MemoryHookPayloads[E],
  ): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        const result = listener(payload);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) =>
            console.warn(`[memory-hooks] ${event} listener failed:`, err),
          );
        }
      } catch (err) {
        console.warn(`[memory-hooks] ${event} listener failed:`, err);
      }
    }
  }
}
