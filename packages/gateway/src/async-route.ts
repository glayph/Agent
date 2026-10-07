import type { Express, Router } from "express"

const ROUTE_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "all"] as const

type Handler = (...args: any[]) => any

function wrapHandler(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wrapHandler)
  if (typeof value !== "function" || value.constructor?.name !== "AsyncFunction") return value

  const handler = value as Handler
  return function asyncRouteForwarder(this: unknown, ...args: any[]) {
    const next = args.at(-1)
    try {
      return Promise.resolve(handler.apply(this, args)).catch((error: unknown) => {
        if (typeof next === "function") return next(error)
        throw error
      })
    } catch (error) {
      if (typeof next === "function") return next(error)
      throw error
    }
  }
}

/**
 * Express 4 does not forward rejected promises from async route handlers.
 * Wrap async callbacks registered after this call while leaving normal handlers
 * and non-route Express APIs unchanged.
 */
export function wrapAsyncRoutes<T extends Express | Router>(target: T): T {
  const mutable = target as unknown as Record<string, unknown>
  for (const method of ROUTE_METHODS) {
    const original = mutable[method]
    if (typeof original !== "function") continue
    mutable[method] = function wrappedRegistrar(this: unknown, ...args: unknown[]) {
      return (original as (...values: unknown[]) => unknown).apply(target, args.map(wrapHandler))
    }
  }
  return target
}
