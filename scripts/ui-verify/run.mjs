// Takes the screenshots required by the UI verification and runs functional assertions.
// Usage: node scripts/ui-verify/run.mjs [outDir]
import fs from "node:fs"
import path from "node:path"

import { THEMES, WIDTHS, launch, startStaticServer } from "./harness.mjs"
import { createMockState, installMocks, setTheme } from "./mock-api.mjs"

const outDir = path.resolve(process.argv[2] || "ui-screenshots")
fs.mkdirSync(outDir, { recursive: true })
const { server, origin } = await startStaticServer()
const browser = await launch()
const findings = []
const checks = []
const record = (name, ok, detail = "") => checks.push({ name, ok, detail })

async function overflow(page, label) {
  const info = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  if (info.sw > info.iw + 1) findings.push(`${label}: horizontal overflow (${info.sw}px > ${info.iw}px)`)
}

async function openAddModel(page) {
  await page.goto(origin + "/models")
  await page.getByRole("button", { name: "Add Model" }).first().waitFor()
  await page.getByRole("button", { name: "Add Model" }).first().click()
  await page.getByText("Select a provider").first().click()
  await page.getByRole("option", { name: /OpenAI/ }).click()
  await page.getByPlaceholder("Enter your API key").fill("sk-test-123")
}

async function openFetchPopup(page) {
  await page.getByRole("button", { name: "Fetch Available Models" }).click()
  await page.getByText("gpt-4o-mini").first().waitFor()
}

async function selectThree(page) {
  for (const id of ["gpt-4o", "gpt-4o-mini", "gpt-4.1"]) {
    await page.getByRole("dialog").last().getByText(id, { exact: true }).click()
  }
}

const scenarios = {
  async "chat-message-menu"(page, shot) {
    await page.routeWebSocket(/\/miki\/ws/, () => {})
    await page.goto(origin + "/")
    await page.getByText("The repository is a monorepo").waitFor()
    await page.waitForTimeout(600)
    await page.getByRole("button", { name: "More message actions" }).last().click()
    await page.getByRole("menuitem", { name: /Delete message/ }).waitFor()
    await shot()
  },
  async "chat-delete-dialog"(page, shot) {
    await page.routeWebSocket(/\/miki\/ws/, () => {})
    await page.goto(origin + "/")
    await page.getByText("The repository is a monorepo").waitFor()
    await page.waitForTimeout(600)
    await page.getByRole("button", { name: "More message actions" }).last().click()
    await page.getByRole("menuitem", { name: /Delete message/ }).click()
    await page.getByRole("alertdialog").waitFor()
    await shot()
  },
  async "models-fetch-popup-3-selected"(page, shot) {
    await openAddModel(page)
    await openFetchPopup(page)
    await selectThree(page)
    await shot()
  },
  async "models-fetch-chip-list"(page, shot) {
    await openAddModel(page)
    await openFetchPopup(page)
    await selectThree(page)
    await page.getByRole("button", { name: /Add 3 models/ }).click()
    await page.getByText("gpt-4.1").first().waitFor()
    await shot()
  },
  async "models-partial-failure-chip"(page, shot, state) {
    state.failModelIds = ["gpt-4.1"]
    await openAddModel(page)
    await openFetchPopup(page)
    await selectThree(page)
    await page.getByRole("button", { name: /Add 3 models/ }).click()
    await page.getByText("gpt-4.1").first().waitFor()
    await page.getByRole("dialog").last().getByRole("button", { name: /Add Model|Add 3/ }).last().click()
    await page.getByText("Failed", { exact: false }).first().waitFor({ timeout: 5000 })
    await shot()
    record(`partial failure keeps only the failed model (${page.viewportSize().width}px)`, state.modelPosts.length === 3)
  },
  async "toast-same-id-once"(page, shot, state) {
    // Two identical saves in a row must leave exactly one toast (same id updates it).
    for (let round = 0; round < 2; round += 1) {
      await openAddModel(page)
      await page.getByPlaceholder(/gpt-4o/).first().fill(`gpt-4o-${round}`)
      await page.getByRole("dialog").last().getByRole("button", { name: /Add Model/ }).last().click()
      await page.waitForTimeout(500)
    }
    const count = await page.locator("[data-sonner-toast]").count()
    record(`same toast id twice shows one toast (${page.viewportSize().width}px)`, count === 1, `toasts=${count}`)
    await shot()
  },
  async "channels-catalog"(page, shot) {
    await page.goto(origin + "/channels")
    await page.getByText("Telegram").first().waitFor()
    await shot()
  },
  async "channel-configure-telegram"(page, shot, state) {
    await page.goto(origin + "/channels/telegram")
    await page.getByText("Test connection").first().waitFor()
    await shot()
  },
  async "channel-configure-feishu-advanced"(page, shot) {
    await page.goto(origin + "/channels/feishu")
    await page.getByText("Credentials").first().waitFor()
    await page.getByText("Advanced").first().click()
    await shot()
  },
  async "channel-configure-weixin-qr"(page, shot) {
    await page.goto(origin + "/channels/weixin")
    await page.getByText("Credentials").first().waitFor()
    await shot()
  },
}

for (const theme of (process.env.SKIP_SHOTS ? [] : process.env.THEME ? [process.env.THEME] : THEMES)) {
  for (const width of (process.env.WIDTH ? [Number(process.env.WIDTH)] : WIDTHS)) {
    for (const [name, run] of Object.entries(scenarios)) {
      const context = await browser.newContext({ viewport: { width, height: 900 } })
      const page = await context.newPage()
      page.setDefaultTimeout(6000)
      const state = createMockState()
      await setTheme(page, theme)
      await installMocks(page, state)
      const pageErrors = []
      page.on("pageerror", (e) => pageErrors.push(String(e)))
      const label = `${name} ${theme} ${width}px`
      const file = path.join(outDir, theme, String(width), `${name}.png`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        await run(page, async () => {
          await page.waitForTimeout(350)
          await overflow(page, label)
          await page.screenshot({ path: file })
        }, state)
      } catch (error) {
        findings.push(`${label}: scenario failed - ${String(error.message).split("\n")[0]}`)
        await page.screenshot({ path: file.replace(".png", ".FAILED.png") }).catch(() => {})
      }
      if (pageErrors.length) findings.push(`${label}: page errors - ${pageErrors[0].slice(0, 160)}`)
      await context.close()
    }
  }
}

// Functional check: a draft typed into a collapsed Advanced field is still saved (ChannelArrayListField flusher).
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(6000)
  const state = createMockState()
  await setTheme(page, "dark")
  await installMocks(page, state)
  await page.goto(origin + "/channels/feishu")
  await page.getByText("Credentials").first().waitFor()
  await page.locator("main").getByText("Advanced").first().click()
  await page.getByPlaceholder("e.g. THUMBSUP, HEART, SMILE").fill("PARTYPOPPER") // typed, not confirmed
  await page.locator("main").getByText("Advanced").first().click() // collapse with an unconfirmed draft
  await page.locator("main input[type=text], main input:not([type])").first().fill("cli_app") // make the form dirty
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await page.waitForTimeout(800)
  const sent = JSON.stringify(state.channelPuts)
  record("collapsed Advanced draft is flushed on save", sent.includes("PARTYPOPPER"), sent.slice(0, 200))
  await context.close()
}

await browser.close()
server.close()
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ findings, checks }, null, 2))
console.log("CHECKS"); for (const c of checks) console.log(c.ok ? "PASS" : "FAIL", c.name, c.detail)
console.log("FINDINGS", findings.length); for (const f of findings) console.log(" -", f)
