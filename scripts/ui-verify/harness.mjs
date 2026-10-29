// Browser verification harness: serves the built frontend (dist) and mocks the gateway API.
// Usage: node scripts/ui-verify/run.mjs   (after `npm --prefix packages/ui/frontend run build`)
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright"

const here = path.dirname(fileURLToPath(import.meta.url))
export const DIST = path.resolve(here, "../../packages/ui/frontend/dist")
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".webmanifest": "application/manifest+json" }

export function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x")
    let file = path.join(DIST, decodeURIComponent(url.pathname))
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html")
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })))
}

export async function launch() {
  const executablePath = process.env.MIKI_CHROMIUM || [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell",
  ].find((p) => fs.existsSync(p))
  return chromium.launch({ executablePath, args: ["--no-sandbox"] })
}

export const THEMES = ["light", "dark"]
export const WIDTHS = [280, 390, 1280]
