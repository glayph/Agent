import net from "node:net";
import os from "node:os";

/**
 * "Is this request a direct connection from the machine the gateway runs on?"
 *
 * Two things are only safe before a dashboard password exists, and only for the owner:
 * the first-time password setup, and the agent WebSocket that accepts commands without a login.
 * This decides who counts as the owner at that point.
 *
 * A reverse proxy on the same machine also connects from loopback, but it adds forwarding headers
 * and every visitor then looks like 127.0.0.1. A request carrying those headers did not come from
 * this machine, so it is NOT treated as local.
 *
 * DNS rebinding: a web page can make the browser on this machine send requests to the gateway
 * with a Host header the attacker controls (`Host: evil.example`), and those requests do arrive
 * from loopback with no forwarding headers. The Origin check cannot catch this because Origin and
 * Host both name the attacker. So a request only counts as local when its Host header is a name the
 * attacker cannot rebind: an IP literal, `localhost`, this machine's own hostname, or a name the
 * owner listed in MIKI_ALLOWED_HOSTS.
 */

const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "forwarded",
  "via",
  "cf-connecting-ip",
] as const;

const stripMappedPrefix = (address: string): string => {
  const value = address.trim().toLowerCase();
  return value.startsWith("::ffff:") ? value.slice(7) : value;
};

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const ip = stripMappedPrefix(address);
  if (ip === "::1") return true;
  const parts = ip.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(parts[0]) === 127
  );
}

/** Host name of a Host-header value (port, brackets and a trailing dot removed), or null if malformed. */
function hostnameOf(hostHeader: string): string | null {
  try {
    const url = new URL(`http://${hostHeader.trim()}`);
    // A real Host header is just host[:port]: no user-info, path, query or fragment.
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    const name = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Parses MIKI_ALLOWED_HOSTS (comma separated host names, ports ignored). Wildcards are not
 * supported and are ignored, so `*` can never switch the check off.
 */
export function parseAllowedHosts(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const allowed: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry || entry.includes("*")) continue;
    const name = hostnameOf(entry);
    if (name) allowed.push(name);
  }
  return allowed;
}

/** Names this machine answers to on a LAN: its hostname, the short form and the mDNS `.local` form. */
export function localMachineNames(): string[] {
  const full = os.hostname().trim().toLowerCase();
  if (!full) return [];
  const short = full.split(".")[0] || full;
  return [...new Set([full, short, `${short}.local`])];
}

/**
 * Is the Host header one an attacker's DNS cannot be rebound to? Browsers always send Host, so a
 * missing header means a non-browser client (not a rebinding victim) and is accepted.
 */
export function isTrustedLocalHost(
  hostHeader: string | string[] | undefined,
  allowedHosts: readonly string[] = [],
  machineNames: readonly string[] = localMachineNames(),
): boolean {
  if (hostHeader === undefined) return true;
  if (Array.isArray(hostHeader)) return false;
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (net.isIP(name)) return true;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  return machineNames.includes(name) || allowedHosts.includes(name);
}

export interface LocalRequestOptions {
  /** Extra host names that count as this machine (from parseAllowedHosts). */
  allowedHosts?: readonly string[];
  /** Override this machine's own host names (tests). */
  machineNames?: readonly string[];
}

/**
 * @param remoteAddress  socket.remoteAddress - who connected
 * @param localAddress   socket.localAddress  - which of this machine's addresses they connected to
 * @param headers        the request headers
 * @param options        extra trusted host names (MIKI_ALLOWED_HOSTS)
 */
export function isLocalDirectRequest(
  remoteAddress: string | undefined,
  localAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  options: LocalRequestOptions = {},
): boolean {
  const fromThisMachine =
    isLoopbackAddress(remoteAddress) ||
    // Browsing to the machine's own LAN address from the machine itself: source and destination match.
    (Boolean(remoteAddress) &&
      Boolean(localAddress) &&
      stripMappedPrefix(remoteAddress as string) ===
        stripMappedPrefix(localAddress as string));
  if (!fromThisMachine) return false;
  if (FORWARDING_HEADERS.some((name) => headers[name] !== undefined)) return false;
  return isTrustedLocalHost(headers.host, options.allowedHosts, options.machineNames);
}

/** MIKI_ALLOW_REMOTE_SETUP: lets the first-time password be set from a non-local address. Off by default. */
export function isRemoteSetupAllowed(value: string | undefined): boolean {
  const flag = String(value ?? "")
    .trim()
    .toLowerCase();
  return flag === "1" || flag === "true";
}
