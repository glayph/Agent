import { describe, expect, it, jest } from "@jest/globals"
import { AgentError } from "@miki/core/errors"
import { createGatewayErrorMiddleware } from "./error-middleware.js"

type MockResponse = {
  headersSent: boolean
  setHeader: jest.Mock
  status: jest.Mock
  json: jest.Mock
}

function response(): MockResponse {
  const value: MockResponse = {
    headersSent: false,
    setHeader: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
  }
  value.status.mockImplementation(() => value)
  return value
}

describe("createGatewayErrorMiddleware", () => {
  it("returns a stable JSON response and hides unexpected 500 details", () => {
    const res = response()
    const log = jest.fn()
    const middleware = createGatewayErrorMiddleware(log)
    const req = { header: () => "invalid request id!", method: "GET", path: "/api/private", originalUrl: "/api/private" }

    middleware(new Error("database password=do-not-leak"), req as never, res as never, jest.fn())

    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>
    expect(res.status).toHaveBeenCalledWith(500)
    expect(body).toMatchObject({ error: "An unexpected server error occurred.", code: "internal_error", retryable: false })
    expect(body.request_id).toEqual(expect.any(String))
    expect(String(body.error)).not.toContain("do-not-leak")
    expect(res.setHeader).toHaveBeenCalledWith("x-request-id", body.request_id)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ status: 500, path: "/api/private" }))
  })

  it("maps typed validation errors to safe client-visible JSON", () => {
    const res = response()
    const middleware = createGatewayErrorMiddleware()

    middleware(new AgentError("validation_error", "Invalid payload"), { header: () => "req-123", method: "POST", originalUrl: "/api/test" } as never, res as never, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid payload", code: "validation_error", request_id: "req-123", retryable: false })
  })

  it("maps authentication errors to the same request-ID response schema", () => {
    const res = response()
    const middleware = createGatewayErrorMiddleware()
    const error = Object.assign(new Error("Authentication required."), { status: 401 })

    middleware(error, { header: () => "req-auth", method: "GET", path: "/api/private" } as never, res as never, jest.fn())

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: "Authentication required.", code: "auth_error", request_id: "req-auth", retryable: false })
  })
})
