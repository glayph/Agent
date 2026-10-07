import { randomUUID } from "node:crypto"
import type { ErrorRequestHandler } from "express"
import { AgentError, errorToHttpStatus, normalizeAgentError } from "@miki/core/errors"

export interface GatewayErrorLogEntry {
  requestId: string
  method: string
  path: string
  status: number
  code: string
  message: string
}

export type GatewayErrorLogger = (entry: GatewayErrorLogEntry) => void

function statusFrom(error: unknown, code: ReturnType<typeof normalizeAgentError>["code"]): number {
  if (error instanceof AgentError) return errorToHttpStatus(error.code)
  if (error && typeof error === "object") {
    const candidate = Number((error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode)
    if (Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) return candidate
  }
  return errorToHttpStatus(code)
}

function codeFromStatus(status: number, normalizedCode: string): string {
  switch (status) {
    case 400:
    case 413:
    case 422:
      return "validation_error"
    case 401:
    case 403:
      return "auth_error"
    case 409:
      return "conflict"
    case 404:
      return "not_found"
    case 408:
    case 504:
      return "timeout"
    case 429:
      return "rate_limit"
    default:
      return normalizedCode
  }
}

function requestIdFrom(value: string | undefined): string {
  return value && /^[a-zA-Z0-9._:-]{1,128}$/.test(value) ? value : randomUUID()
}

export function createGatewayErrorMiddleware(log: GatewayErrorLogger = () => undefined): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) return next(error)

    const requestId = requestIdFrom(req.header("x-request-id"))
    const normalized = normalizeAgentError(error, { requestId })
    const status = statusFrom(error, normalized.code)
    const code = codeFromStatus(status, normalized.code)
    const retryable = normalized.retryable || [408, 429, 502, 503, 504].includes(status)
    const message = status >= 500 && !(error instanceof AgentError)
      ? "An unexpected server error occurred."
      : normalized.message

    res.setHeader("x-request-id", requestId)
    try {
      log({
        requestId,
        method: req.method,
        path: req.path,
        status,
        code,
        message: error instanceof Error ? error.message : String(error),
      })
    } catch {
      // Logging must not prevent the error response from being sent.
    }

    return res.status(status).json({ error: message, code, request_id: requestId, retryable })
  }
}
