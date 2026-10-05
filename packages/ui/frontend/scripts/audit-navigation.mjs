import fs from "node:fs"
import path from "node:path"

const root = path.resolve(new URL("..", import.meta.url).pathname)
const routesDir = path.join(root, "src", "routes")
const navFile = path.join(root, "src", "app", "layout", "app-navigation.tsx")

const retired = [
  "chat.tsx",
  "agent/run.tsx",
  "agent/runs.tsx",
  "agents.tsx",
  "agents.index.tsx",
  "agents.$id.tsx",
  "agents.swarm.tsx",
  "about.tsx",
]

for (const file of retired) {
  const candidates = [
    path.join(routesDir, file),
    path.join(routesDir, file.replace("agent/", "agent/")),
  ]
  if (candidates.some((candidate) => fs.existsSync(candidate))) {
    throw new Error(`retired route still exists: ${file}`)
  }
}

const nav = fs.readFileSync(navFile, "utf8")
const sourceFiles = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith(".tsx")) sourceFiles.push(full)
  }
}
walk(routesDir)

const routes = []
for (const file of sourceFiles) {
  const source = fs.readFileSync(file, "utf8")
  for (const match of source.matchAll(/createFileRoute\("([^"]+)"\)/g)) {
    routes.push(match[1])
  }
}

const canonicalRoutes = new Set(routes)
const expectedFromNav = [
  "/",
  "/drive",
  "/agent/hub",
  "/models",
  "/plugins",
  "/config",
  "/health",
  "/agent/monitor",
  "/control",
  "/channels",
  "/memory",
  "/credentials",
  "/agent/skills",
  "/agent/tools",
  "/logs",
]

for (const route of expectedFromNav) {
  if (!canonicalRoutes.has(route)) throw new Error(`missing canonical route: ${route}`)
  if (!nav.includes(`url: "${route}"`)) throw new Error(`route is not in shared navigation: ${route}`)
}

for (const route of ["/config/raw", "/channels/$name", "/plugins/catalog", "/plugins/providers", "/plugins/core", "/plugins/channels", "/plugins/capabilities", "/plugins/health"]) {
  if (!canonicalRoutes.has(route)) throw new Error(`missing contextual route: ${route}`)
}

for (const route of ["/launcher-login", "/launcher-setup"]) {
  if (!canonicalRoutes.has(route)) throw new Error(`missing auth route: ${route}`)
}

const unique = new Set(routes)
if (unique.size !== routes.length) throw new Error("duplicate createFileRoute declarations detected")

console.log(JSON.stringify({
  ok: true,
  canonicalRouteCount: routes.length,
  canonicalRoutes: [...routes],
  retiredRoutesRemoved: retired.length,
}, null, 2))
