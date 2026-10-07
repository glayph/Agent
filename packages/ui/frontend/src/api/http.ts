import { toast } from "sonner"

import { isLauncherAuthPathname } from "@/lib/launcher-login-path"

function isLauncherAuthPath(): boolean {
  if (typeof globalThis.location === "undefined") {
    return false
  }
  if (isLauncherAuthPathname(globalThis.location.pathname || "/")) {
    return true
  }
  try {
    return isLauncherAuthPathname(
      new URL(globalThis.location.href).pathname || "/",
    )
  } catch {
    return false
  }
}

export interface LauncherFetchOptions extends RequestInit {
  showErrorToast?: boolean
}

export class GatewayBackendError extends Error {
  readonly backendRole: "compatibility-stub"

  constructor(
    message: string,
    backendRole: "compatibility-stub",
  ) {
    super(message)
    this.backendRole = backendRole
    this.name = "GatewayBackendError"
  }
}

function errorMessageFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined
  const record = body as Record<string, unknown>
  const nested = record.error && typeof record.error === "object"
    ? record.error as Record<string, unknown>
    : undefined
  const candidate = typeof record.error === "string"
    ? record.error
    : typeof record.message === "string"
      ? record.message
      : typeof record.detail === "string"
        ? record.detail
        : typeof nested?.message === "string"
          ? nested.message
          : undefined
  const trimmed = candidate?.trim()
  return trimmed ? trimmed.slice(0, 500) : undefined
}

async function responseErrorMessage(response: Response): Promise<string> {
  try {
    const message = errorMessageFromBody(await response.clone().json())
    if (message) return message
  } catch {
    // Do not surface non-JSON bodies such as an HTML server error page.
  }
  return `API Error (${response.status}): ${response.statusText || "Request failed"}`
}

/**
 * Same-origin fetch that sends cookies; redirects to launcher login on 401 JSON responses,
 * and displays error toasts on unexpected 5xx or 4xx responses when enabled.
 */
export async function launcherFetch(
  input: RequestInfo | URL,
  init?: LauncherFetchOptions,
): Promise<Response> {
  const { showErrorToast, ...fetchInit } = init || {}
  try {
    const res = await fetch(input, {
      credentials: "same-origin",
      ...fetchInit,
    })

    const backendRole = res.headers.get("x-miki-backend-role")
    if (
      backendRole === "compatibility-stub" &&
      !String(input).includes("/api/auth/")
    ) {
      throw new GatewayBackendError(
        "The Web UI is connected to the Go compatibility stub. Start the Node Gateway on the configured gateway port.",
        backendRole,
      )
    }

    if (res.status === 401) {
      const ct = res.headers.get("content-type") || ""
      if (
        ct.includes("application/json") &&
        typeof globalThis.location !== "undefined" &&
        !isLauncherAuthPath()
      ) {
        globalThis.location.assign("/launcher-login")
      }
    } else if (showErrorToast && !res.ok) {
      toast.error(await responseErrorMessage(res))
    }

    return res
  } catch (error) {
    if (showErrorToast) {
      toast.error(error instanceof GatewayBackendError
        ? error.message
        : "Network error: Please check your connection.")
    }
    throw error
  }
}
