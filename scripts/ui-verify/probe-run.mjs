import { launch, startStaticServer } from "./harness.mjs"
import { createMockState, installMocks, setTheme } from "./mock-api.mjs"
const { server, origin } = await startStaticServer()
const browser = await launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
const state = createMockState()
await setTheme(page, "light")
await installMocks(page, state)
const errors = []
page.on("pageerror", (e) => errors.push(String(e)))
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
await page.goto(origin + "/channels/telegram")
await page.waitForTimeout(1500)
console.log(await page.title(), page.url())
console.log((await page.locator("body").innerText()).slice(0, 600))
console.log("unhandled", [...state.unhandled], "errors", errors.slice(0, 5))
await page.screenshot({ path: "/tmp/probe.png" })
await browser.close(); server.close()
