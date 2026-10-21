/**
 * Automatic retries for a failed model call.
 *
 * Waits 1s, 2s, 4s, 8s, 16s between attempts. Retries are bounded by `maxRetries`
 * (five by default) so persistent provider failures cannot hold a turn indefinitely. Stop ends a wait at once.
 */
export const MODEL_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const

/** Delay before the retry with this zero-based index (0 = the first retry). */
export function modelRetryDelayMs(retryIndex: number): number {
  const index = Math.max(0, Math.floor(Number(retryIndex) || 0))
  return MODEL_RETRY_DELAYS_MS[index % MODEL_RETRY_DELAYS_MS.length]
}

/** Resolves after `ms`, or as soon as `signal` aborts, whichever comes first. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener("abort", finish, { once: true })
  })
}

export interface RetryModelCallOptions<T> {
  /** One model attempt. */
  attempt: () => Promise<T>
  /** True when this result is a failure that another attempt may fix. */
  shouldRetry: (result: T) => boolean
  /** Called before each wait. `retry` counts from 1. */
  onRetry?: (info: { retry: number; delayMs: number; result: T }) => void
  /** Called after a wait, just before the next attempt starts. */
  onResumed?: () => void
  /** Aborting this stops the retries. */
  signal: AbortSignal
  /** Delay before each retry, by zero-based retry index. Defaults to `modelRetryDelayMs`. */
  delayMs?: (retryIndex: number) => number
  /** Maximum retries after the initial attempt. Defaults to 5 to avoid unbounded provider outages. */
  maxRetries?: number
  /** Wait implementation. Defaults to `sleepUnlessAborted`. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface RetryModelCallOutcome<T> {
  /** The last attempt's result. */
  result: T
  /** True when the turn was stopped while a retry was pending; `result` is then the failed attempt. */
  stopped: boolean
}

export async function retryModelCall<T>(options: RetryModelCallOptions<T>): Promise<RetryModelCallOutcome<T>> {
  const delayFor = options.delayMs ?? modelRetryDelayMs
  const sleep = options.sleep ?? sleepUnlessAborted
  let result = await options.attempt()
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 5))
  for (let retryIndex = 0; retryIndex < maxRetries && options.shouldRetry(result); retryIndex += 1) {
    if (options.signal.aborted) return { result, stopped: true }
    const delayMs = delayFor(retryIndex)
    options.onRetry?.({ retry: retryIndex + 1, delayMs, result })
    await sleep(delayMs, options.signal)
    if (options.signal.aborted) return { result, stopped: true }
    options.onResumed?.()
    result = await options.attempt()
  }
  return { result, stopped: false }
}
