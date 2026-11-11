/**
 * Gate in front of a run's model capture while the managed local model server is being switched.
 *
 * Only a run that will actually use the managed local model has to wait for the switch; runs on
 * remote/cloud models start at once, so one long local run can never hold back every other
 * conversation. The wait is bounded: when the transition does not finish in time the run starts
 * anyway and a real local-server failure shows up as a normal, visible run error instead of a
 * silent hang.
 */
export interface LocalRuntimeGateOptions {
  /** The transition currently in progress, or undefined when none is. Re-read after every wait. */
  getPending: () => Promise<void> | undefined
  /** True when the requested model (or the default one) is served by the managed local runtime. */
  usesManagedLocalModel: (requested?: string, requestedIndex?: number) => boolean
  /** Longest a single run waits for the transition. */
  maxWaitMs: number
  log?: (message: string) => void
  now?: () => number
}

export type LocalRuntimeGate = (requested?: string, requestedIndex?: number) => Promise<void>

export function createLocalRuntimeGate(options: LocalRuntimeGateOptions): LocalRuntimeGate {
  const now = options.now ?? Date.now
  return async (requested, requestedIndex) => {
    if (!options.getPending()) return
    if (!options.usesManagedLocalModel(requested, requestedIndex)) return
    const deadline = now() + options.maxWaitMs
    for (;;) {
      const pending = options.getPending()
      if (!pending) return
      const remaining = deadline - now()
      if (remaining <= 0) {
        options.log?.(`Local runtime transition still pending after ${options.maxWaitMs}ms; starting the run without waiting longer.`)
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      await Promise.race([
        pending.catch(() => undefined).then(() => { settled = true }),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining) }),
      ])
      if (timer) clearTimeout(timer)
      if (!settled) {
        options.log?.(`Local runtime transition still pending after ${options.maxWaitMs}ms; starting the run without waiting longer.`)
        return
      }
      // A newer transition may have been queued while we waited: wait for that one too (within the deadline).
      if (options.getPending() === pending) return
    }
  }
}
