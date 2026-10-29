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
