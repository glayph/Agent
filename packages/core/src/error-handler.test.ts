import { afterEach, describe, expect, it, jest } from "@jest/globals"
import { AdvancedErrorHandler } from "./error-handler.js"

afterEach(() => jest.restoreAllMocks())

describe("AdvancedErrorHandler", () => {
  it("uses the fallback after a primary failure", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const handler = new AdvancedErrorHandler()
    const fallback = jest.fn().mockResolvedValue("fallback result")

    await expect(handler.executeWithFallback(
      async () => { throw new Error("primary unavailable") },
      fallback,
      "model-service",
    )).resolves.toBe("fallback result")

    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it("keeps the primary error when the fallback also fails", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const handler = new AdvancedErrorHandler()
    const primaryError = new Error("primary unavailable")
    const fallbackError = new Error("fallback unavailable")

    await expect(handler.executeWithFallback(
      async () => { throw primaryError },
      async () => { throw fallbackError },
      "model-service",
    )).rejects.toMatchObject({
      name: "AggregateError",
      errors: [primaryError, fallbackError],
      cause: primaryError,
    })
  })
})
