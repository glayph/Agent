import { describe, expect, it, jest } from "@jest/globals"
import express from "express"
import { wrapAsyncRoutes } from "./async-route.js"

describe("wrapAsyncRoutes", () => {
  it("forwards a rejected async route promise to Express next(error)", async () => {
    const app = wrapAsyncRoutes(express())
    const expected = new Error("provider unavailable")
    app.post("/reject", async () => {
      throw expected
    })

    const route = (app as any)._router.stack.find((layer: any) => layer.route?.path === "/reject").route
    const handler = route.stack[0].handle as (req: unknown, res: unknown, next: (error: unknown) => void) => Promise<void>
    const next = jest.fn()

    await handler({}, {}, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith(expected)
  })

  it("wraps async handlers nested in an Express handler array", async () => {
    const app = wrapAsyncRoutes(express())
    const expected = new Error("nested route failed")
    app.get("/nested", [async () => { throw expected }])

    const route = (app as any)._router.stack.find((layer: any) => layer.route?.path === "/nested").route
    const handler = route.stack[0].handle as (req: unknown, res: unknown, next: (error: unknown) => void) => Promise<void>
    const next = jest.fn()

    await handler({}, {}, next)
    expect(next).toHaveBeenCalledWith(expected)
  })
})
