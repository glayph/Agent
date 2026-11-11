/**
 * Origin policy for the dashboard/agent WebSocket (/miki/ws).
 *
 * The session cookie is SameSite=None, so a browser attaches it to a socket that ANY web page
 * opens. Browsers always send an Origin header on a WebSocket handshake, so the gateway has to
 * check it - otherwise a page the signed-in user happens to visit could drive the agent.
 *
 *  - No Origin header                      -> not a browser (CLI, scripts, bridges): allowed.
 *  - Origin host equals the Host header    -> the page came from this gateway: allowed.
 *  - Anything else                         -> allowed only if listed in MIKI_ALLOWED_ORIGINS.
 */

const HTTP_PROTOCOL = /^https?:$/;

function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    return HTTP_PROTOCOL.test(parsed.protocol)
      ? parsed.origin.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/**
 * Parses MIKI_ALLOWED_ORIGINS (comma separated). Entries must be exact http(s) origins such as
 * `https://miki.example.com:8443`, or the literal `null`. Wildcards are not supported and are
 * ignored, so `*` can never switch the check off.
 */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const allowed: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry || entry.includes("*")) continue;
    if (entry.toLowerCase() === "null") {
      allowed.push("null");
      continue;
    }
    const normalized = normalizeOrigin(entry);
    if (normalized) allowed.push(normalized);
  }
  return allowed;
}

/**
 * @param origin  the request's Origin header (undefined when the header is absent)
 * @param host    the request's Host header
 * @param allowedOrigins  already-normalized origins from parseAllowedOrigins()
 */
export function isWsOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigins: readonly string[] = [],
): boolean {
  if (origin === undefined) return true;
  const value = origin.trim();
  if (value.toLowerCase() === "null") return allowedOrigins.includes("null");

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (!HTTP_PROTOCOL.test(parsed.protocol)) return false;
  const canonical = parsed.origin.toLowerCase();
  // A real Origin header is exactly a serialized origin: no user-info, path or query.
  if (value.toLowerCase() !== canonical) return false;

  const requestHost = String(host ?? "")
    .trim()
    .toLowerCase();
  if (requestHost && parsed.host.toLowerCase() === requestHost) return true;
  return allowedOrigins.includes(canonical);
}
