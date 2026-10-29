import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import { notify } from "./notify"

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}))

afterEach(() => vi.clearAllMocks())

describe("notify", () => {
  it("applies consistent type-specific durations", () => {
    notify.success("Saved")
    notify.info("Working")
    notify.warning("Check this")
    notify.error("Failed")
    notify.loading("Loading")

    expect(toast.success).toHaveBeenCalledWith("Saved", { duration: 2500 })
    expect(toast.info).toHaveBeenCalledWith("Working", { duration: 3500 })
    expect(toast.warning).toHaveBeenCalledWith("Check this", { duration: 5000 })
    expect(toast.error).toHaveBeenCalledWith("Failed", {
      duration: 6000,
      closeButton: true,
    })
    expect(toast.loading).toHaveBeenCalledWith("Loading", { duration: Infinity })
  })

  it("forwards stable IDs so Sonner updates repeated notices instead of stacking them", () => {
    notify.error("Same error", { id: "http:502:/api/model" })
    notify.error("Same error again", { id: "http:502:/api/model" })
    expect(toast.error).toHaveBeenNthCalledWith(1, "Same error", expect.objectContaining({ id: "http:502:/api/model" }))
    expect(toast.error).toHaveBeenNthCalledWith(2, "Same error again", expect.objectContaining({ id: "http:502:/api/model" }))
  })

  it("forwards ids for every notice type and for dismiss", () => {
    notify.success("a", { id: "x:success" })
    notify.info("b", { id: "x:info" })
    notify.warning("c", { id: "x:warning" })
    notify.loading("d", { id: "x:loading" })
    notify.dismiss("x:loading")
    expect(toast.success).toHaveBeenCalledWith("a", expect.objectContaining({ id: "x:success", duration: 2500 }))
    expect(toast.info).toHaveBeenCalledWith("b", expect.objectContaining({ id: "x:info" }))
    expect(toast.warning).toHaveBeenCalledWith("c", expect.objectContaining({ id: "x:warning" }))
    expect(toast.loading).toHaveBeenCalledWith("d", expect.objectContaining({ id: "x:loading" }))
    expect(toast.dismiss).toHaveBeenCalledWith("x:loading")
  })

  it("lets a caller override the default duration without losing the id", () => {
    notify.error("Failed", { id: "x:error", duration: 1000 })
    expect(toast.error).toHaveBeenCalledWith("Failed", { duration: 1000, closeButton: true, id: "x:error" })
  })
})

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, found)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) found.push(full)
  }
  return found
}

describe("toast migration", () => {
  const srcRoot = path.resolve(__dirname, "..")
  const files = sourceFiles(srcRoot)

  it("only notify.ts and the Toaster host import sonner", () => {
    const importers = files
      .filter((file) => /from\s+["']sonner["']/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(srcRoot, file).split(path.sep).join("/"))
      .sort()
    expect(importers).toEqual(["app/layout/app-layout.tsx", "lib/notify.ts"])
  })

  it("gives every notify call a fixed id", () => {
    const offenders: string[] = []
    for (const file of files) {
      if (file.endsWith(path.join("lib", "notify.ts"))) continue
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(/\bnotify\.(success|error|info|warning|loading)\(/g)) {
        // Walk to the matching parenthesis so nested calls and multi-line arguments are handled.
        let depth = 1
        let index = (match.index ?? 0) + match[0].length
        const start = index
        let quote: string | null = null
        while (index < text.length && depth > 0) {
          const char = text[index]
          if (quote) {
            if (char === "\\") index += 1
            else if (char === quote) quote = null
          } else if (char === '"' || char === "'" || char === "`") quote = char
          else if (char === "(") depth += 1
          else if (char === ")") depth -= 1
          index += 1
        }
        if (!/\bid\s*:/.test(text.slice(start, index))) {
          offenders.push(`${path.relative(srcRoot, file)}:${text.slice(0, match.index).split("\n").length}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
