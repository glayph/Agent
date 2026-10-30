import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createLiveCaptureLoop } from "./live-capture-loop"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("createLiveCaptureLoop", () => {
  it("captures immediately and schedules the next frame after the request settles", async () => {
    const capture = vi.fn().mockResolvedValue(undefined)
    const loop = createLiveCaptureLoop(capture, 1000)

    loop.start()
    expect(capture).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(capture).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(capture).toHaveBeenCalledTimes(2)
    loop.stop()
  })

  it("never overlaps slow captures", async () => {
    let finishFirst!: () => void
    const capture = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve }))
      .mockResolvedValue(undefined)
    const loop = createLiveCaptureLoop(capture, 500)

    loop.start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(capture).toHaveBeenCalledTimes(1)

    finishFirst()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(500)
    expect(capture).toHaveBeenCalledTimes(2)
    loop.stop()
  })

  it("pauses scheduled frames and resumes with an immediate capture", async () => {
    const capture = vi.fn().mockResolvedValue(undefined)
    const loop = createLiveCaptureLoop(capture, 1000)

    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    loop.pause()
    await vi.advanceTimersByTimeAsync(3000)
    expect(capture).toHaveBeenCalledTimes(1)

    loop.resume()
    expect(capture).toHaveBeenCalledTimes(2)
    loop.stop()
    await vi.advanceTimersByTimeAsync(3000)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it("continues after a rejected capture", async () => {
    const capture = vi.fn()
      .mockRejectedValueOnce(new Error("capture failed"))
      .mockResolvedValue(undefined)
    const loop = createLiveCaptureLoop(capture, 1000)

    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(capture).toHaveBeenCalledTimes(2)
    loop.stop()
  })
})
