import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { createModelDownloadTools, isPublicUnicastAddress, type PinnedResponse } from "./model-download-tools.js"

const payload = Buffer.concat([Buffer.from("GGUF", "ascii"), Buffer.from("sample-model-data")])
const digest = createHash("sha256").update(payload).digest("hex")
const tempRoots: string[] = []

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "miki-model-tools-"))
  tempRoots.push(root)
  return root
}

async function* chunks(data: Uint8Array = payload): AsyncGenerator<Uint8Array> {
  yield data.subarray(0, 2)
  yield data.subarray(2, 9)
  yield data.subarray(9)
}

function response(data: Uint8Array = payload, headers: Record<string, string> = { "content-length": String(data.length) }): PinnedResponse {
  return { statusCode: 200, headers, body: chunks(data) }
}

function downloadTool(opts: Parameters<typeof createModelDownloadTools>[0]) {
  return createModelDownloadTools(opts).find((tool) => tool.name === "model_download_gguf")!
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

describe("createModelDownloadTools", () => {
  it("validates public destination addresses and rejects private/reserved ranges", () => {
    expect(isPublicUnicastAddress("8.8.8.8")).toBe(true)
    expect(isPublicUnicastAddress("2606:4700:4700::1111")).toBe(true)
    for (const address of ["127.0.0.1", "10.2.3.4", "169.254.1.1", "172.20.0.1", "192.168.1.9", "100.64.0.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "2001:db8::1"]) {
      expect(isPublicUnicastAddress(address)).toBe(false)
    }
  })

  it("returns a bounded set of GGUF candidates with published metadata", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === "/api/models") {
        return new Response(JSON.stringify([{ id: "owner/one" }, { id: "owner/two" }, { id: "owner/three" }]), { status: 200 })
      }
      return new Response(JSON.stringify({
        sha: "abcdef1234567890",
        siblings: [
          { rfilename: "nested/model.gguf", size: 1234, lfs: { oid: `${digest}`, size: 1234 } },
          { rfilename: "readme.md", size: 10 },
        ],
      }), { status: 200 })
    })
    const [search] = createModelDownloadTools({ dataRoot: "/tmp/models", registerModel: async () => true, fetchImpl })
    const result = await search.execute({ query: "small conversational model for offline coding", limit: 2 }, {
      runId: "run", callId: "call", signal: new AbortController().signal,
    }) as { candidates: Array<Record<string, unknown>>; query: string }
    expect(result.query).toBe("small conversational model for offline coding")
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates[0]).toMatchObject({
      repo: "owner/one", filename: "nested/model.gguf", bytes: 1234, sha256: digest,
      url: "https://huggingface.co/owner/one/resolve/abcdef1234567890/nested/model.gguf",
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(String(fetchImpl.mock.calls[0][0])).toContain("search=small+conversational+model+for+offline+coding")
  })

  it("requires HTTPS, no URL userinfo, safe aliases, and a safe public DNS result", async () => {
    const root = await newRoot()
    const tool = downloadTool({
      dataRoot: root, registerModel: async () => true,
      resolveHost: async () => ["8.8.8.8"], requestImpl: async () => response(),
    })
    const ctx = { runId: "r", callId: "c", signal: new AbortController().signal }
    await expect(tool.execute({ url: "http://example.test/a.gguf", alias: "safe" }, ctx)).rejects.toThrow(/HTTPS/)
    await expect(tool.execute({ url: "https://user:pass@example.test/a.gguf", alias: "safe" }, ctx)).rejects.toThrow(/userinfo|credentials/i)
    await expect(tool.execute({ url: "https://example.test/a.gguf", alias: "../escape" }, ctx)).rejects.toThrow(/Alias/)
    const blocked = downloadTool({
      dataRoot: root, registerModel: async () => true,
      resolveHost: async () => ["8.8.8.8", "127.0.0.1"], requestImpl: async () => response(),
    })
    await expect(blocked.execute({ url: "https://example.test/a.gguf", alias: "safe" }, ctx)).rejects.toThrow(/local, private, or reserved/)
  })

  it("downloads, validates, registers, and returns digest evidence with progress and approval metadata", async () => {
    const root = await newRoot()
    const registerModel = vi.fn(async () => ({ registered: true, modelId: "local-one" }))
    const heartbeats: string[] = []
    const extendLease = vi.fn(() => true)
    const tool = downloadTool({
      dataRoot: root, registerModel, maxDownloadBytes: 1024,
      resolveHost: async (host) => { expect(host).toBe("models.example"); return ["8.8.8.8"] },
      requestImpl: async (url, address) => {
        expect(url.protocol).toBe("https:")
        expect(address).toBe("8.8.8.8")
        return response()
      },
    })
    expect(tool.risk).toBe("install")
    expect(tool.approval).toBe("required")
    expect(tool.timeoutMs).toBe(0)
    const result = await tool.execute({ url: "https://models.example/a.gguf", alias: "local-one", sha256: digest, expected_bytes: payload.length }, {
      runId: "run", callId: "call", signal: new AbortController().signal,
      heartbeat: (message) => { if (message) heartbeats.push(message) }, extendLease,
    }) as Record<string, unknown>
    expect(result).toMatchObject({
      success: true, confirmed: true, installed: true, path: path.join(root, "models", "local-one.gguf"), bytes: payload.length,
      sha256: digest, checksum_verified: true, registration: { registered: true, modelId: "local-one" },
    })
    expect(await readFile(String(result.path))).toEqual(payload)
    expect(registerModel).toHaveBeenCalledWith(expect.objectContaining({ alias: "local-one", bytes: payload.length, sha256: digest }))
    expect(heartbeats.at(-1)).toContain("installed and registered")
    expect(extendLease).toHaveBeenCalled()
  })

  it("rejects bad magic, digest, and size and removes every partial download", async () => {
    const root = await newRoot()
    const tool = downloadTool({
      dataRoot: root, registerModel: async () => true, maxDownloadBytes: 100,
      resolveHost: async () => ["8.8.8.8"], requestImpl: async () => response(),
    })
    const context = { runId: "r", callId: "c", signal: new AbortController().signal }
    await expect(tool.execute({ url: "https://models.example/a.gguf", alias: "bad-digest", sha256: "0".repeat(64) }, context)).rejects.toThrow(/SHA-256/)
    const badMagicTool = downloadTool({
      dataRoot: root, registerModel: async () => true,
      resolveHost: async () => ["8.8.8.8"], requestImpl: async () => response(Buffer.from("nope")),
    })
    await expect(badMagicTool.execute({ url: "https://models.example/a.gguf", alias: "bad-magic" }, context)).rejects.toThrow(/GGUF/)
    const sizeTool = downloadTool({
      dataRoot: root, registerModel: async () => true,
      resolveHost: async () => ["8.8.8.8"], requestImpl: async () => response(payload, { "content-length": "3" }),
    })
    await expect(sizeTool.execute({ url: "https://models.example/a.gguf", alias: "bad-size" }, context)).rejects.toThrow(/Content-Length/)
    const files = await readdir(path.join(root, "models"))
    expect(files.some((name) => name.endsWith(".part"))).toBe(false)
    expect(files.some((name) => name.endsWith(".gguf"))).toBe(false)
  })

  it("does not overwrite a different existing model and accepts an identical verified file", async () => {
    const root = await newRoot()
    const different = downloadTool({
      dataRoot: root, registerModel: async () => true,
      resolveHost: async () => ["8.8.8.8"], requestImpl: async () => response(),
    })
    const context = { runId: "r", callId: "c", signal: new AbortController().signal }
    await different.execute({ url: "https://models.example/a.gguf", alias: "same" }, context)
    const filePath = path.join(root, "models", "same.gguf")
    const original = await readFile(filePath)
    const conflict = downloadTool({
      dataRoot: root, registerModel: async () => true,
      resolveHost: async () => ["8.8.8.8"], requestImpl: async () => response(Buffer.from("GGUFdifferent")),
    })
    await expect(conflict.execute({ url: "https://models.example/a.gguf", alias: "same" }, context)).rejects.toThrow(/not overwritten/)
    expect(await readFile(filePath)).toEqual(original)
    const identical = downloadTool({
      dataRoot: root, registerModel: async () => true,
      resolveHost: async () => ["8.8.8.8"], requestImpl: async () => response(),
    })
    const result = await identical.execute({ url: "https://models.example/a.gguf", alias: "same", sha256: digest }, context) as Record<string, unknown>
    expect(result.checksum_verified).toBe(true)
    expect(await readFile(filePath)).toEqual(original)
  })

  it("revalidates HTTPS redirects and rejects a redirect to a private address", async () => {
    const root = await newRoot()
    const requestImpl = vi.fn(async (url: URL) => url.hostname === "start.example"
      ? { statusCode: 302, headers: { location: "https://internal.example/a.gguf" } }
      : response())
    const tool = downloadTool({
      dataRoot: root, registerModel: async () => true,
      resolveHost: async (host) => host === "start.example" ? ["8.8.8.8"] : ["10.0.0.1"], requestImpl,
    })
    await expect(tool.execute({ url: "https://start.example/a.gguf", alias: "redirect" }, {
      runId: "r", callId: "c", signal: new AbortController().signal,
    })).rejects.toThrow(/local, private, or reserved/)
    expect(requestImpl).toHaveBeenCalledTimes(1)
    expect(await readdir(path.join(root, "models"))).toEqual([])
  })
})
