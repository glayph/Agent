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

/**
 * @param remoteAddress  socket.remoteAddress - who connected
 * @param localAddress   socket.localAddress  - which of this machine's addresses they connected to
 * @param headers        the request headers
 */
export function isLocalDirectRequest(
  remoteAddress: string | undefined,
  localAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const fromThisMachine =
    isLoopbackAddress(remoteAddress) ||
    // Browsing to the machine's own LAN address from the machine itself: source and destination match.
    (Boolean(remoteAddress) &&
      Boolean(localAddress) &&
      stripMappedPrefix(remoteAddress as string) ===
        stripMappedPrefix(localAddress as string));
  if (!fromThisMachine) return false;
  return !FORWARDING_HEADERS.some((name) => headers[name] !== undefined);
}

/** MIKI_ALLOW_REMOTE_SETUP: lets the first-time password be set from a non-local address. Off by default. */
export function isRemoteSetupAllowed(value: string | undefined): boolean {
  const flag = String(value ?? "")
    .trim()
    .toLowerCase();
  return flag === "1" || flag === "true";
}
