import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  Router,
  type Request,
  type Response as ExpressResponse,
} from "express";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_REDIRECTS = 2;
const FETCH_TIMEOUT_MS = 5_000;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export type LinkPreviewProvider =
  "youtube" | "x" | "instagram" | "tiktok" | "web";

export interface LinkPreview {
  url: string;
  provider: LinkPreviewProvider;
  title: string;
  description?: string;
  image?: string;
  siteName?: string;
  unavailable?: boolean;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && b >= 18 && b <= 19) ||
    a >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  if (normalized === "::" || normalized === "::1") return true;
  if (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  )
    return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIpv4(mapped[1]) : false;
}

async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("A valid URL is required");
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol))
    throw new Error("Only HTTP(S) URLs are supported");
  if (parsed.username || parsed.password)
    throw new Error("URLs with embedded credentials are not supported");
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443")
    throw new Error("Only standard HTTP(S) ports are supported");
  const hostname = normalizeHostname(parsed.hostname);
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  )
    throw new Error("Private network hosts are not supported");
  if (isIP(hostname) && isPrivateAddress(hostname))
    throw new Error("Private network addresses are not supported");
  if (!isIP(hostname)) {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (
      addresses.length === 0 ||
      addresses.some((entry) => isPrivateAddress(entry.address))
    )
      throw new Error("The destination resolves to a private network");
  }
  return parsed;
}

function providerFor(url: URL): LinkPreviewProvider {
  const host = normalizeHostname(url.hostname);
  if (
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com")
  )
    return "youtube";
  if (
    host === "x.com" ||
    host.endsWith(".x.com") ||
    host === "twitter.com" ||
    host.endsWith(".twitter.com")
  )
    return "x";
  if (host === "instagram.com" || host.endsWith(".instagram.com"))
    return "instagram";
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok";
  return "web";
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function metaContent(html: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*>`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeEntities(match[1]).slice(0, 1_000);
  }
  return undefined;
}

function htmlTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeEntities(match[1]).slice(0, 300) : undefined;
}

async function readLimitedBody(response: globalThis.Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES)
        throw new Error("Preview document is too large");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function fetchPublicOEmbed(
  requested: URL,
  provider: LinkPreviewProvider,
): Promise<LinkPreview | undefined> {
  if (provider !== "youtube" && provider !== "x") return undefined;
  const endpoint =
    provider === "youtube"
      ? "https://www.youtube.com/oembed"
      : "https://publish.twitter.com/oembed";
  const endpointUrl = await assertPublicUrl(endpoint);
  endpointUrl.searchParams.set("url", requested.toString());
  endpointUrl.searchParams.set("format", "json");
  const response = await fetch(endpointUrl, {
    headers: {
      accept: "application/json",
      "user-agent": "Agent-Miki-LinkPreview/1.0",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return undefined;
  const body = JSON.parse(await readLimitedBody(response)) as Record<
    string,
    unknown
  >;
  const title =
    typeof body.title === "string"
      ? decodeEntities(body.title).slice(0, 300)
      : "";
  if (!title) return undefined;
  const author =
    typeof body.author_name === "string"
      ? decodeEntities(body.author_name).slice(0, 300)
      : undefined;
  const thumbnail =
    typeof body.thumbnail_url === "string"
      ? safeImageUrl(body.thumbnail_url)
      : undefined;
  return {
    url: requested.toString(),
    provider,
    title,
    ...(author ? { siteName: author } : {}),
    ...(thumbnail ? { image: thumbnail } : {}),
  };
}

async function fetchPublicHtml(
  initialUrl: URL,
): Promise<{ url: URL; html: string }> {
  let current = initialUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Agent-Miki-LinkPreview/1.0",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS)
        throw new Error("Too many redirects");
      current = await assertPublicUrl(new URL(location, current).toString());
      continue;
    }
    const contentType = response.headers.get("content-type") || "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    )
      throw new Error("The URL is not an HTML page");
    return { url: current, html: await readLimitedBody(response) };
  }
  throw new Error("Unable to fetch preview");
}

function safeImageUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return ALLOWED_PROTOCOLS.has(parsed.protocol)
      ? parsed.toString().slice(0, 2_000)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function getLinkPreview(rawUrl: string): Promise<LinkPreview> {
  const requested = await assertPublicUrl(rawUrl);
  const provider = providerFor(requested);
  try {
    const oembed = await fetchPublicOEmbed(requested, provider);
    if (oembed) return oembed;
    const { url, html } = await fetchPublicHtml(requested);
    const title =
      metaContent(html, "og:title") ||
      metaContent(html, "twitter:title") ||
      htmlTitle(html) ||
      url.hostname;
    const description =
      metaContent(html, "og:description") ||
      metaContent(html, "twitter:description");
    const image = safeImageUrl(
      metaContent(html, "og:image") || metaContent(html, "twitter:image"),
    );
    const siteName = metaContent(html, "og:site_name");
    return {
      url: requested.toString(),
      provider,
      title,
      ...(description ? { description } : {}),
      ...(image ? { image } : {}),
      ...(siteName ? { siteName } : {}),
    };
  } catch {
    return {
      url: requested.toString(),
      provider,
      title: requested.hostname,
      unavailable: true,
    };
  }
}

export function createLinkPreviewRouter(): Router {
  const router = Router();
  router.get("/", async (req: Request, res: ExpressResponse) => {
    const rawUrl =
      typeof req.query.url === "string" ? req.query.url.trim() : "";
    if (!rawUrl) {
      res.status(400).json({ error: "url is required" });
      return;
    }
    try {
      res.json(await getLinkPreview(rawUrl));
    } catch (error: unknown) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return router;
}
