/** A single-flight capture loop with an interval measured after each request settles. */
export interface LiveCaptureLoop {
  start(): void
  pause(): void
  resume(): void
  stop(): void
}

export function createLiveCaptureLoop(
  capture: () => Promise<unknown>,
  intervalMs: number,
): LiveCaptureLoop {
  let active = false
  let paused = true
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const scheduleNext = () => {
    if (!active || paused || inFlight) return
    clearTimer()
    timer = setTimeout(() => {
      timer = undefined
      void runCapture()
    }, Math.max(250, intervalMs))
  }

  const runCapture = async () => {
    if (!active || paused || inFlight) return
    inFlight = true
    try {
      await capture()
    } catch {
      // The capture owner presents errors; a failed frame must not stop live updates.
    } finally {
      inFlight = false
      scheduleNext()
    }
  }

  return {
    start() {
      active = true
      paused = false
      clearTimer()
      void runCapture()
    },
    pause() {
      paused = true
      clearTimer()
    },
    resume() {
      if (!active) return
      paused = false
      clearTimer()
      void runCapture()
    },
    stop() {
      active = false
      paused = true
      clearTimer()
    },
  }
}
