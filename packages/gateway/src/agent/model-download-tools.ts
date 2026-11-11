import type { EngineTool } from "@miki/core/engine"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { promises as fs } from "node:fs"
import { isIP } from "node:net"
import path from "node:path"
import { lookup } from "node:dns/promises"
import https from "node:https"

const DEFAULT_MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024 * 1024
const MAX_SEARCH_RESULTS = 10
const MAX_SEARCH_REPOS = 30
const MAX_REDIRECTS = 3
const PROGRESS_INTERVAL_BYTES = 64 * 1024 * 1024
const PROGRESS_INTERVAL_MS = 5_000
const MIN_FREE_SPACE_RESERVE_BYTES = 512 * 1024 * 1024
const GGUF_MAGIC = Buffer.from("GGUF", "ascii")

export interface ModelRegistrationInput {
  alias: string
  path: string
  bytes: number
  sha256: string
  signal: AbortSignal
}

export interface ModelDownloadToolsOptions {
  dataRoot: string
  registerModel?: (input: ModelRegistrationInput) => Promise<unknown> | unknown
  /** Existing gateway callback form; adapted to the same async registration path. */
  registerLocalModel?: (input: { name: string; modelPath: string; sha256: string; bytes: number }) => Promise<unknown> | unknown
  /** Maximum bytes accepted per installation. Defaults to MIKI_MODEL_MAX_DOWNLOAD_BYTES or 8 GiB. */
  maxDownloadBytes?: number
  /** Injectable public HF API transport. */
  fetchImpl?: typeof fetch
  /** Injectable DNS lookup. Every returned address is checked and the chosen address is pinned. */
  resolveHost?: (hostname: string) => Promise<string[]>
  /** Injectable pinned HTTPS request, primarily for deterministic tests. */
  requestImpl?: (url: URL, pinnedAddress: string, signal: AbortSignal) => Promise<PinnedResponse>
}

export interface PinnedResponse {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body?: AsyncIterable<Uint8Array>
}

function asError(message: string): Error {
  // Deliberately never include URL objects, response bodies, or lower-level errors here.
  return new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSafeAlias(alias: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias) && alias !== "." && alias !== ".."
}

function parseSha256(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw asError(`${label} must be exactly 64 hexadecimal SHA-256 characters.`)
  }
  return value.toLowerCase()
}

function ipv4Number(value: string): number {
  return value.split(".").reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0)
}

function inV4Range(address: number, network: string, prefix: number): boolean {
  const shift = 32 - prefix
  return (address >>> shift) === (ipv4Number(network) >>> shift)
}

function ipv6Number(value: string): bigint | undefined {
  let text = value.toLowerCase().split("%", 1)[0]
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":")
    const v4 = text.slice(lastColon + 1)
    if (isIP(v4) !== 4) return undefined
    const n = ipv4Number(v4)
    text = `${text.slice(0, lastColon)}:${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(":") : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined
  const groups = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right]
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined
  return groups.reduce((acc, part) => (acc << 16n) | BigInt(`0x${part}`), 0n)
}

/** Accept only globally routable unicast IP addresses for a remote model host. */
export function isPublicUnicastAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const n = ipv4Number(address)
    const blocked: Array<[string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.175.48.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ]
    return !blocked.some(([network, prefix]) => inV4Range(n, network, prefix))
  }
  if (family !== 6) return false
  const n = ipv6Number(address)
  if (n === undefined) return false
  // Global unicast is 2000::/3. Exclude special-purpose/documentation/transition blocks.
  const globalUnicast = (n >> 125n) === 1n
  const blocked = [
    [0x20010db8000000000000000000000000n, 32n], // documentation
    [0x20010000000000000000000000000000n, 23n], // protocol assignments / special use
    [0x20020000000000000000000000000000n, 16n], // 6to4
    [0x3fff0000000000000000000000000000n, 20n], // documentation
  ] as const
  const excluded = blocked.some(([network, bits]) => (n >> (128n - bits)) === (network >> (128n - bits)))
  return globalUnicast && !excluded
}

function normalizedHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
}

function validateHttpsUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw asError("A valid direct HTTPS GGUF URL is required.")
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw asError("GGUF downloads require an HTTPS URL without embedded credentials.")
  }
  if (url.hash) url.hash = ""
  return url
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname]
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)
}

async function defaultPinnedRequest(url: URL, pinnedAddress: string, signal: AbortSignal): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      signal,
      family: isIP(pinnedAddress),
      headers: { "accept-encoding": "identity", "user-agent": "miki-model-installer" },
      lookup: ((_hostname: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => {
        callback(null, pinnedAddress, isIP(pinnedAddress))
      }) as never,
    }, (response) => {
      const headers: Record<string, string | string[] | undefined> = {}
      for (const [name, value] of Object.entries(response.headers)) headers[name.toLowerCase()] = value
      resolve({ statusCode: response.statusCode ?? 0, headers, body: response })
    })
    request.once("error", () => reject(asError("HTTPS download request failed.")))
    request.end()
  })
}

async function getPinnedAddresses(url: URL, resolveHost: (hostname: string) => Promise<string[]>): Promise<string[]> {
  const host = normalizedHost(url)
  let addresses: string[]
  try {
    addresses = await resolveHost(host)
  } catch {
    throw asError("The download host could not be resolved safely.")
  }
  if (!addresses.length || addresses.some((address) => !isPublicUnicastAddress(address))) {
    throw asError("The download host resolves to a local, private, or reserved network address.")
  }
  return addresses
}

function contentLength(response: PinnedResponse): number | undefined {
  const raw = response.headers["content-length"]
  if (raw === undefined) return undefined
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value || !/^\d+$/.test(value.trim())) throw asError("The server returned an invalid Content-Length.")
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw asError("The server returned an invalid Content-Length.")
  return parsed
}

async function openDownloadResponse(
  initial: URL,
  signal: AbortSignal,
  resolveHost: (hostname: string) => Promise<string[]>,
  requestImpl: (url: URL, pinnedAddress: string, signal: AbortSignal) => Promise<PinnedResponse>,
): Promise<PinnedResponse> {
  let current = initial
  for (let redirects = 0; ; redirects++) {
    if (signal.aborted) throw asError("Model download cancelled.")
    const addresses = await getPinnedAddresses(current, resolveHost)
    let response: PinnedResponse
    try {
      response = await requestImpl(current, addresses[0], signal)
    } catch {
      if (signal.aborted) throw asError("Model download cancelled.")
      throw asError("HTTPS download request failed.")
    }
    if (![301, 302, 303, 307, 308].includes(response.statusCode)) return response
    if (redirects >= MAX_REDIRECTS) throw asError("The download exceeded the redirect limit.")
    const rawLocation = response.headers.location
    const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation
    if (!location) throw asError("The download server returned an invalid redirect.")
    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      throw asError("The download server returned an invalid redirect.")
    }
    if (next.protocol !== "https:" || next.username || next.password) {
      throw asError("The download redirect must use HTTPS without embedded credentials.")
    }
    current = next
  }
}

async function sha256File(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256")
  let bytes = 0
  const handle = await fs.open(filePath, "r")
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let position = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      bytes += bytesRead
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
  return { bytes, sha256: hash.digest("hex") }
}

async function verifyGguf(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r")
  try {
    const magic = Buffer.alloc(4)
    const { bytesRead } = await handle.read(magic, 0, 4, 0)
    if (bytesRead !== 4 || !magic.equals(GGUF_MAGIC)) throw asError("The downloaded file is not a GGUF model.")
  } finally {
    await handle.close()
  }
}

function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex")
  const right = Buffer.from(b, "hex")
  return left.length === right.length && timingSafeEqual(left, right)
}

async function isSameVerifiedFile(existing: string, part: string, expectedBytes?: number, expectedSha?: string): Promise<boolean> {
  try {
    const [existingStat, partStat] = await Promise.all([fs.lstat(existing), fs.lstat(part)])
    if (!existingStat.isFile() || existingStat.isSymbolicLink() || existingStat.size !== partStat.size) return false
    if (expectedBytes !== undefined && existingStat.size !== expectedBytes) return false
    await verifyGguf(existing)
    const [oldDigest, newDigest] = await Promise.all([sha256File(existing), sha256File(part)])
    return oldDigest.bytes === newDigest.bytes && sameDigest(oldDigest.sha256, newDigest.sha256)
      && (!expectedSha || sameDigest(oldDigest.sha256, expectedSha))
  } catch {
    return false
  }
}

function getSearchModelsTool(options: ModelDownloadToolsOptions, fetchImpl: typeof fetch): EngineTool {
  return {
    name: "model_search_gguf",
    description: "Search public Hugging Face models and their file metadata for GGUF files matching the supplied natural-language query. This is read-only and returns bounded candidate repository, filename, HTTPS URL, size, and published LFS SHA-256 metadata when available.",
    risk: "read",
    approval: "auto",
    parallelSafe: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Natural-language description of the model you want." },
        limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS, description: `Maximum candidates to return (up to ${MAX_SEARCH_RESULTS}).` },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const query = typeof input.query === "string" ? input.query.trim() : ""
      if (!query) throw asError("A non-empty natural-language model query is required.")
      const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(Number(input.limit) || 5)))
      const api = new URL("https://huggingface.co/api/models")
      api.searchParams.set("search", query)
      api.searchParams.set("limit", String(MAX_SEARCH_REPOS))
      api.searchParams.set("sort", "downloads")
      api.searchParams.set("direction", "-1")
      let searchResponse: Response
      try {
        searchResponse = await fetchImpl(api, { signal: context.signal, redirect: "error", headers: { accept: "application/json" } })
      } catch {
        if (context.signal.aborted) throw context.signal.reason ?? asError("Model search cancelled.")
        throw asError("The public model search service could not be reached.")
      }
      if (!searchResponse.ok) throw asError("The public model search service returned an error.")
      let repos: unknown
      try { repos = await searchResponse.json() } catch { throw asError("The public model search service returned invalid metadata.") }
      if (!Array.isArray(repos)) throw asError("The public model search service returned invalid metadata.")
      const candidates: Array<{ repo: string; filename: string; url: string; bytes: number | null; sha256?: string }> = []
      for (const row of repos.slice(0, MAX_SEARCH_REPOS)) {
        if (context.signal.aborted) throw context.signal.reason ?? asError("Model search cancelled.")
        if (!isRecord(row) || typeof row.id !== "string" || !/^[^\s/]+\/[^\s/]+$/.test(row.id)) continue
        const repo = row.id
        const metadataUrl = new URL(`https://huggingface.co/api/models/${repo.split("/").map(encodeURIComponent).join("/")}`)
        metadataUrl.searchParams.set("files_metadata", "true")
        let metadata: unknown
        try {
          const response = await fetchImpl(metadataUrl, { signal: context.signal, redirect: "error", headers: { accept: "application/json" } })
          if (!response.ok) continue
          metadata = await response.json()
        } catch {
          if (context.signal.aborted) throw context.signal.reason ?? asError("Model search cancelled.")
          continue
        }
        if (!isRecord(metadata) || !Array.isArray(metadata.siblings)) continue
        const revision = typeof metadata.sha === "string" && /^[a-f0-9]{7,64}$/i.test(metadata.sha) ? metadata.sha : "main"
        for (const file of metadata.siblings) {
          if (!isRecord(file) || typeof file.rfilename !== "string" || !file.rfilename.toLowerCase().endsWith(".gguf")) continue
          const filename = file.rfilename
          const url = `https://huggingface.co/${repo.split("/").map(encodeURIComponent).join("/")}/resolve/${encodeURIComponent(revision)}/${filename.split("/").map(encodeURIComponent).join("/")}`
          const lfs = isRecord(file.lfs) ? file.lfs : undefined
          const rawDigest = typeof lfs?.oid === "string" ? lfs.oid.replace(/^sha256:/i, "") : typeof file.sha256 === "string" ? file.sha256 : undefined
          const sha256 = rawDigest && /^[a-f0-9]{64}$/i.test(rawDigest) ? rawDigest.toLowerCase() : undefined
          const size = typeof lfs?.size === "number" && Number.isSafeInteger(lfs.size) ? lfs.size
            : typeof file.size === "number" && Number.isSafeInteger(file.size) ? file.size : null
          candidates.push({ repo, filename, url, bytes: size, ...(sha256 ? { sha256 } : {}) })
          if (candidates.length >= limit) break
        }
        if (candidates.length >= limit) break
      }
      return { query, candidates }
    },
  }
}

function getDownloadTool(options: ModelDownloadToolsOptions, maxBytes: number): EngineTool {
  const resolveHost = options.resolveHost ?? defaultResolveHost
  const requestImpl = options.requestImpl ?? defaultPinnedRequest
  return {
    name: "model_download_gguf",
    description: "Download a direct HTTPS GGUF file to the managed models directory, validate file magic, byte size, and optional SHA-256, then register it. Requires approval. Use a candidate returned by model_search_gguf and provide its published checksum when available.",
    risk: "install",
    approval: "required",
    timeoutMs: 0,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1, description: "Direct HTTPS URL of a GGUF file." },
        alias: { type: "string", minLength: 1, maxLength: 64, description: "Safe local model alias used for the installed filename." },
        sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$", description: "Optional expected SHA-256 digest." },
        expected_bytes: { type: "integer", minimum: 1, description: "Optional expected exact file size in bytes." },
      },
      required: ["url", "alias"],
      additionalProperties: false,
    },
    async execute(input, context) {
      let initial: URL
      if (typeof input.url !== "string") throw asError("A direct HTTPS GGUF URL is required.")
      initial = validateHttpsUrl(input.url)
      const alias = typeof input.alias === "string" ? input.alias.trim() : ""
      if (!isSafeAlias(alias)) throw asError("Alias must start with a letter or digit and contain only letters, digits, dots, underscores, or hyphens (maximum 64 characters).")
      const expectedSha = parseSha256(input.sha256, "sha256")
      const expectedBytes = input.expected_bytes === undefined ? undefined : Number(input.expected_bytes)
      if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1)) throw asError("expected_bytes must be a positive safe integer.")
      if (expectedBytes !== undefined && expectedBytes > maxBytes) throw asError(`expected_bytes exceeds the configured ${maxBytes}-byte download limit.`)
      if (context.signal.aborted) throw asError("Model download cancelled.")

      const modelsDir = path.resolve(options.dataRoot, "models")
      const destination = path.join(modelsDir, `${alias}.gguf`)
      const partPath = path.join(modelsDir, `.${alias}.${randomUUID()}.part`)
      let installedByThisCall = false
      let partExists = false
      let finalInstalled = false
      try {
        await fs.mkdir(modelsDir, { recursive: true })
        const directoryInfo = await fs.lstat(modelsDir)
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw asError("The managed model directory is not a safe directory.")
        const diskInfo = await fs.statfs(modelsDir)
        const availableBytes = Number(diskInfo.bavail) * Number(diskInfo.bsize)
        const downloadLimit = Math.min(maxBytes, availableBytes - MIN_FREE_SPACE_RESERVE_BYTES)
        if (!Number.isSafeInteger(downloadLimit) || downloadLimit < 4) throw asError("There is not enough free storage to safely download a model.")
        const response = await openDownloadResponse(initial, context.signal, resolveHost, requestImpl)
        if (response.statusCode !== 200 || !response.body) throw asError("The model server did not return a complete file.")
        const announcedBytes = contentLength(response)
        if (announcedBytes !== undefined && announcedBytes > downloadLimit) throw asError("The server's Content-Length exceeds the safe download limit for this workspace.")
        if (announcedBytes !== undefined && expectedBytes !== undefined && announcedBytes !== expectedBytes) throw asError("The server Content-Length does not match expected_bytes.")
        const handle = await fs.open(partPath, "wx", 0o600)
        partExists = true
        const hash = createHash("sha256")
        let bytes = 0
        let nextProgress = PROGRESS_INTERVAL_BYTES
        let nextProgressAt = Date.now() + PROGRESS_INTERVAL_MS
        try {
          for await (const chunk of response.body) {
            if (context.signal.aborted) throw asError("Model download cancelled.")
            const data = Buffer.from(chunk)
            bytes += data.length
            if (bytes > downloadLimit) throw asError("The download exceeded the safe model-size limit for this workspace.")
            if (announcedBytes !== undefined && bytes > announcedBytes) throw asError("The downloaded size exceeded Content-Length.")
            if (expectedBytes !== undefined && bytes > expectedBytes) throw asError("The downloaded size exceeded expected_bytes.")
            hash.update(data)
            let offset = 0
            while (offset < data.length) {
              const written = await handle.write(data, offset, data.length - offset, null)
              if (!written.bytesWritten) throw asError("The model file could not be written safely.")
              offset += written.bytesWritten
            }
            if (bytes >= nextProgress || Date.now() >= nextProgressAt) {
              context.heartbeat?.(`Downloaded ${bytes} bytes${expectedBytes !== undefined ? ` of ${expectedBytes}` : ""}.`)
              if (context.extendLease && !context.extendLease(60_000)) throw asError("Model download cancelled.")
              nextProgress = bytes + PROGRESS_INTERVAL_BYTES
              nextProgressAt = Date.now() + PROGRESS_INTERVAL_MS
            }
          }
          if (context.signal.aborted) throw asError("Model download cancelled.")
          if (bytes < 4) throw asError("The downloaded file is not a GGUF model.")
          if (announcedBytes !== undefined && bytes !== announcedBytes) throw asError("The downloaded size does not match Content-Length.")
          if (expectedBytes !== undefined && bytes !== expectedBytes) throw asError("The downloaded size does not match expected_bytes.")
          await handle.sync()
        } finally {
          await handle.close()
        }
        const sha256 = hash.digest("hex")
        if (expectedSha && !sameDigest(sha256, expectedSha)) throw asError("The downloaded SHA-256 does not match the supplied checksum.")
        await verifyGguf(partPath)
        const checksumVerified = expectedSha !== undefined

        let existing = false
        try {
          const stat = await fs.lstat(destination)
          if (!stat.isFile() || stat.isSymbolicLink()) throw asError("An unsafe file already exists at the model destination.")
          existing = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        if (existing) {
          if (!await isSameVerifiedFile(destination, partPath, expectedBytes, expectedSha)) throw asError("A different file already exists at the model destination; it was not overwritten.")
          await fs.unlink(partPath)
          partExists = false
        } else {
          try {
            await fs.link(partPath, destination)
            finalInstalled = true
            installedByThisCall = true
            await fs.unlink(partPath)
            partExists = false
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !await isSameVerifiedFile(destination, partPath, expectedBytes, expectedSha)) throw asError("The model destination already exists or could not be installed safely.")
            await fs.unlink(partPath)
            partExists = false
            existing = true
          }
        }
        if (context.signal.aborted) throw asError("Model download cancelled.")
        context.heartbeat?.(`Verified ${bytes} bytes; registering model.`)
        if (context.extendLease && !context.extendLease(60_000)) throw asError("Model download cancelled.")
        let registration: unknown
        try {
          registration = options.registerModel
            ? await options.registerModel({ alias, path: destination, bytes, sha256, signal: context.signal })
            : await options.registerLocalModel!({ name: alias, modelPath: destination, bytes, sha256 })
        } catch {
          throw asError("The downloaded model was verified but registration failed.")
        }
        context.heartbeat?.(`Model ${alias} installed and registered (${bytes} bytes).`)
        return { success: true, confirmed: true, installed: true, path: destination, bytes, sha256, checksum_verified: checksumVerified, registration }
      } catch (error) {
        if (installedByThisCall && finalInstalled) {
          try { await fs.unlink(destination) } catch { /* Preserve the original safe failure. */ }
        }
        throw error instanceof Error && error.message && !/[?&](token|key|auth|signature)=/i.test(error.message)
          ? error : asError("GGUF download failed safely; sensitive URL details were omitted.")
      } finally {
        if (partExists) {
          try { await fs.unlink(partPath) } catch { /* Best-effort cleanup on every failure. */ }
        }
      }
    },
  }
}

export function createModelDownloadTools(options: ModelDownloadToolsOptions): EngineTool[] {
  if (!options || typeof options.dataRoot !== "string" || !options.dataRoot.trim()) throw new Error("dataRoot is required.")
  if (typeof options.registerModel !== "function" && typeof options.registerLocalModel !== "function") throw new Error("A model registration callback is required.")
  const configured = options.maxDownloadBytes ?? (Number(process.env.MIKI_MODEL_MAX_DOWNLOAD_BYTES) || DEFAULT_MAX_DOWNLOAD_BYTES)
  const maxBytes = Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_DOWNLOAD_BYTES
  const fetchImpl = options.fetchImpl ?? fetch
  return [getSearchModelsTool(options, fetchImpl), getDownloadTool(options, maxBytes)]
}
