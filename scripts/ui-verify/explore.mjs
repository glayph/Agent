import { launch, startStaticServer } from "./harness.mjs"
import { createMockState, installMocks, setTheme } from "./mock-api.mjs"
const [, , route, ...clicks] = process.argv
const { server, origin } = await startStaticServer()
const browser = await launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
const state = createMockState()
await setTheme(page, "light")
await installMocks(page, state)
page.on("pageerror", (e) => console.log("PAGEERROR", String(e).slice(0, 200)))
await page.routeWebSocket(/\/miki\/ws/, () => {})
await page.goto(origin + route)
await page.waitForTimeout(1500)
for (const c of clicks) { await page.getByText(c, { exact: false }).first().click().catch((e)=>console.log('click fail',c)); await page.waitForTimeout(600) }
console.log((await page.locator("button,[role=button],a,input,textarea,[role=combobox]").evaluateAll(els => els.filter(e=>e.offsetParent).map(e => (e.tagName+':'+(e.getAttribute('aria-label')||e.innerText||e.placeholder||'')).slice(0,60)))).join('\n'))
console.log("unhandled", [...state.unhandled])
await page.screenshot({ path: "/tmp/explore.png" })
await browser.close(); server.close()
