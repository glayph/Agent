import fs from "node:fs"
import path from "node:path"

const root = path.resolve(new URL(".", import.meta.url).pathname, "src")
const jsonFiles = []

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (entry.name.endsWith(".json")) jsonFiles.push(file)
  }
}

walk(root)
const ids = new Map()
let skills = 0

for (const file of jsonFiles) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"))
  const entries = Array.isArray(data) ? data : Array.isArray(data.skills) ? data.skills : []
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue
    const id = typeof entry.id === "string" ? entry.id.trim() : ""
    if (!id) continue
    if (ids.has(id)) throw new Error(`duplicate skill id: ${id}`)
    ids.set(id, file)
    skills += 1
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      throw new Error(`skill ${id} in ${file} is missing name`)
    }
    if (typeof entry.description !== "string" || !entry.description.trim()) {
      throw new Error(`skill ${id} in ${file} is missing description`)
    }
    if (typeof entry.path === "string" && entry.path.trim()) {
      const referenced = path.resolve(path.dirname(file), entry.path)
      if (!referenced.startsWith(root + path.sep) || !fs.existsSync(referenced)) {
        throw new Error(`skill ${id} references missing or unsafe path: ${entry.path}`)
      }
    }
  }
}

console.log(`Validated ${jsonFiles.length} registry JSON files and ${skills} skill records.`)
