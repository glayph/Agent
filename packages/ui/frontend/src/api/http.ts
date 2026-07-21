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

    if (res.status === 401) {
      const ct = res.headers.get("content-type") || ""
      if (
        ct.includes("application/json") &&
        typeof globalThis.location !== "undefined" &&
        !isLauncherAuthPath()
      ) {
        globalThis.location.assign("/launcher-login")
      }
    } else if (showErrorToast && (res.status >= 400 || res.status >= 500)) {
      toast.error(`API Error (${res.status}): ${res.statusText || "Request failed"}`)
    }

    return res
  } catch (error) {
    if (showErrorToast) {
      toast.error("Network error: Please check your connection.")
    }
    throw error
  }
}
