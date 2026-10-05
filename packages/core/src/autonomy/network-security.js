import { promises as dns } from "node:dns";
import { isIP } from "node:net";
function normalizeDomain(value) {
    return value.trim().toLowerCase().replace(/^\.+/, "").replace(/\.$/, "");
}
function ipv4ToInt(value) {
    const parts = value.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
        return null;
    return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}
function ipv4InRange(value, network, bits) {
    const ip = ipv4ToInt(value);
    const base = ipv4ToInt(network);
    if (ip == null || base == null)
        return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
}
function ipv6ToBigInt(value) {
    const input = value.toLowerCase().split("%")[0];
    const parts = input.split("::");
    if (parts.length > 2)
        return null;
    const left = parts[0] ? parts[0].split(":") : [];
    const right = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
    const expandCount = 8 - left.length - right.length;
    if (expandCount < 0)
        return null;
    const groups = [...left, ...Array(expandCount).fill("0"), ...right];
    if (groups.length !== 8)
        return null;
    let out = 0n;
    for (const group of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(group))
            return null;
        out = (out << 16n) | BigInt(parseInt(group, 16));
    }
    return out;
}
function ipv6InRange(value, network, bits) {
    const ip = ipv6ToBigInt(value);
    const base = ipv6ToBigInt(network);
    if (ip == null || base == null)
        return false;
    const shift = 128 - bits;
    return (ip >> BigInt(shift)) === (base >> BigInt(shift));
}
export function isPrivateOrReservedIp(address) {
    if (isIP(address) === 4) {
        return [
            ["0.0.0.0", 8],
            ["10.0.0.0", 8],
            ["100.64.0.0", 10],
            ["127.0.0.0", 8],
            ["169.254.0.0", 16],
            ["172.16.0.0", 12],
            ["192.0.0.0", 24],
            ["192.0.2.0", 24],
            ["192.168.0.0", 16],
            ["198.18.0.0", 15],
            ["198.51.100.0", 24],
            ["203.0.113.0", 24],
            ["224.0.0.0", 4],
            ["240.0.0.0", 4],
        ].some(([network, bits]) => ipv4InRange(address, network, bits));
    }
    if (isIP(address) === 6) {
        const normalized = address.toLowerCase();
        if (normalized === "::1" || normalized === "::")
            return true;
        if (normalized.startsWith("::ffff:")) {
            const mapped = normalized.slice(7);
            if (isIP(mapped) === 4)
                return isPrivateOrReservedIp(mapped);
        }
        return [
            ["fc00::", 7],
            ["fe80::", 10],
            ["ff00::", 8],
            ["2001:db8::", 32],
        ].some(([network, bits]) => ipv6InRange(address, network, bits));
    }
    return true;
}
export function isAllowedDomain(hostname, allowedDomains = []) {
    const host = normalizeDomain(hostname);
    if (!allowedDomains.length)
        return true;
    return allowedDomains.some((domain) => {
        const normalized = normalizeDomain(domain);
        return normalized && (host === normalized || host.endsWith(`.${normalized}`));
    });
}
export async function validateNetworkUrl(input, options = {}) {
    let url;
    try {
        url = new URL(input);
    }
    catch {
        throw new Error("Invalid network URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only http:// and https:// URLs are allowed");
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const localName = hostname === "localhost" || hostname === "localhost.localdomain" || hostname.endsWith(".localhost");
    if (localName && !options.allowLocalhost)
        throw new Error("Localhost access is blocked by network security policy");
    if (!isAllowedDomain(hostname, options.allowedDomains ?? [])) {
        throw new Error(`Domain '${hostname}' is not in the autonomous allowlist`);
    }
    if (options.allowPrivateNetworks)
        return url;
    const ipKind = isIP(hostname);
    if (ipKind) {
        if (isPrivateOrReservedIp(hostname))
            throw new Error(`Private or reserved network address '${hostname}' is blocked`);
        return url;
    }
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length)
        throw new Error(`Could not resolve '${hostname}'`);
    for (const address of addresses) {
        if (isPrivateOrReservedIp(address.address)) {
            throw new Error(`Hostname '${hostname}' resolves to a private or reserved network address`);
        }
    }
    return url;
}
