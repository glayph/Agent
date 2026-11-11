import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  primaryNavigation,
  secondaryNavigation,
  sidebarNavigationGroups,
  utilityNavigation,
} from "./app-navigation"

describe("app navigation", () => {
  it("keeps every visible destination unique", () => {
    const urls = secondaryNavigation.map((item) => item.url)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it("keeps primary destinations in the full navigation list", () => {
    const allIds = new Set(secondaryNavigation.map((item) => item.id))
    expect(primaryNavigation.every((item) => allIds.has(item.id))).toBe(true)
  })

  it("places every non-utility destination in exactly one sidebar group", () => {
    const groupedIds = sidebarNavigationGroups.flatMap((group) => group.itemIds)
    const expectedIds = secondaryNavigation
      .filter(
        (item) => !utilityNavigation.some((utility) => utility.id === item.id),
      )
      .map((item) => item.id)

    expect(new Set(groupedIds).size).toBe(groupedIds.length)
    expect(new Set(groupedIds)).toEqual(new Set(expectedIds))
  })
})

describe("route metadata", () => {
  it("matches every registered page route", () => {
    const testDirectory = path.dirname(fileURLToPath(import.meta.url))
    const frontendRoot = path.resolve(testDirectory, "../../..")
    const routeRoot = path.join(frontendRoot, "src/routes")
    const manifestPath = path.join(frontendRoot, "public/manus-routes.json")
    const routeFiles: string[] = []

    const collectRouteFiles = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name)
        if (entry.isDirectory()) collectRouteFiles(entryPath)
        else if (entry.isFile() && entry.name.endsWith(".tsx")) {
          routeFiles.push(entryPath)
        }
      }
    }

    collectRouteFiles(routeRoot)
    const registeredPaths = routeFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8")
      return [...source.matchAll(/createFileRoute\(["']([^"']+)["']\)/g)].map(
        (match) => match[1].replace(/\$([A-Za-z0-9_]+)/g, ":$1"),
      )
    })
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      routes: Array<{ path: string; title: string }>
    }
    const manifestPaths = manifest.routes.map((route) => route.path)

    expect(new Set(registeredPaths).size).toBe(registeredPaths.length)
    expect(new Set(manifestPaths)).toEqual(new Set(registeredPaths))
    expect(manifest.routes.every((route) => route.title.trim().length > 0)).toBe(
      true,
    )
  })
})
