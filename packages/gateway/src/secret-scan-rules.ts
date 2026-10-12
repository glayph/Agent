/**
 * Rules for the dashboard secret scan (health + Doctor).
 *
 * The previous scanner flagged every `password|token|api_key = <8+ chars>` line
 * in every file, which turns ordinary code (`apiKey = options.apiKey`,
 * `password: string`, test fixtures, .env.example, docs) into "113 potential
 * secrets" and kept overall health on `degraded`. These rules keep real
 * credentials (known token formats, quoted high-entropy literals, private keys)
 * and drop structural keys, placeholders, references and fixtures.
 */
import path from "node:path"
import { checkApiKey } from "./model-resolution.js"

export const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".cache", ".turbo", ".vite", ".next",
  ".miki-build", "vendor", "vendorized", "__pycache__", ".trash", "logs", "tmp", "temp",
])

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tgz", ".tar", ".7z",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".wav", ".webm", ".sqlite", ".db",
  ".gguf", ".bin", ".so", ".dll", ".exe", ".wasm", ".map", ".lock",
])

export const isScannableFile = (file: string): boolean => !BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())

/** Files that legitimately contain dummy credentials: tests, examples, templates, docs. */
export function isFixturePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/")
  const base = path.posix.basename(normalized)
  return (
    /^\.env\.(?:example|sample|template|dist)$/i.test(base) ||
    /(?:^|\/)(?:__tests__|__mocks__|tests?|fixtures?|examples?|docs?)\//i.test(normalized) ||
    /(?:^|[._-])(?:test|spec|mock|fixture)s?(?:[._-]|$)/i.test(base) ||
    /_test\.(?:go|js|ts|tsx|jsx|mjs|cjs|py)$/i.test(base) ||
    /\.(?:md|mdx|rst|txt)$/i.test(base)
  )
}

/** Convert one ignore-file glob into a RegExp (supports `*`, `**`, trailing `/`). */
function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replaceAll("\\", "/")
  if (g.endsWith("/")) g += "**"
  const escaped = g.replace(/[.+^${}()|[\]]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")
  return new RegExp(g.includes("/") ? `^${escaped}$` : `(?:^|/)${escaped}$`)
}

/**
 * Parse `.miki-secretignore` / `.gitleaksignore` content into matchers.
 * One path glob per line; `#` comments; for gitleaks fingerprint lines
 * (`path:rule:line`) only the path part is used.
 */
export function parseIgnoreFile(content: string): RegExp[] {
  const matchers: RegExp[] = []
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const target = /^[A-Za-z]:[\\/]/.test(line) ? line : line.split(":")[0]
    if (target) matchers.push(globToRegExp(target))
  }
  return matchers
}

export const isIgnoredPath = (relativePath: string, matchers: RegExp[]): boolean => {
  const normalized = relativePath.replaceAll("\\", "/")
  return matchers.some((matcher) => matcher.test(normalized))
}

const KNOWN_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,})\b/
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/
const QUOTED_ASSIGNMENT = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|bot[_-]?token|client[_-]?secret|secret[_-]?key|password|passwd)\b["']?\s*[:=]\s*(["'`])([^"'`\n]{12,})\1/i
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BOT_TOKEN|CLIENT_SECRET|SECRET_KEY|PASSWORD)[A-Z0-9_]*\s*=\s*(["']?)([^\s"'#]{12,})\1\s*(?:#.*)?$/

const ENV_FILE = /(?:^|\/)\.env(?:\.[\w.-]+)?$|\.(?:ini|conf|toml|ya?ml|properties)$/i

/** A value that is a reference, identifier or placeholder rather than a literal credential. */
export function isNonSecretValue(value: string): boolean {
  const v = value.trim()
  if (checkApiKey("gemini", v).status === "placeholder") return true
  if (/^[A-Z][A-Z0-9_]{5,}$/.test(v)) return true // env var name
  if (/\$\{|\$\(|process\.env|os\.environ|getenv|import\.meta|<[^>]+>|\{\{/.test(v)) return true // reference / template
  if (/^(?:local-no-auth-required|not-configured|not-set|none|null|undefined|redacted|\*+|•+)$/i.test(v)) return true
  if (/^[a-z_][\w]*(?:\.[a-z_][\w]*)+$/i.test(v) && !/\d/.test(v)) return true // property access: options.apiKey
  if (/^https?:\/\//i.test(v) && !/\/\/[^/\s:@]+:[^/\s@]+@/.test(v)) return true // URL without embedded credentials
  if (/^[./~]|^[A-Za-z]:\\/.test(v) && /[/\\]/.test(v)) return true // path
  // Real secrets mix letters and digits; plain words (e.g. "change-this-value") are not credentials.
  return !(/[A-Za-z]/.test(v) && /\d/.test(v))
}

export interface LineFinding { pattern: "private-key" | "known-token" | "credential-assignment"; preview: string }

export function scanLine(line: string, relativePath: string): LineFinding | undefined {
  if (PRIVATE_KEY.test(line)) return { pattern: "private-key", preview: "[PRIVATE KEY MATERIAL]" }
  const token = KNOWN_TOKEN.exec(line)
  if (token && checkApiKey("gemini", token[0]).status !== "placeholder") return { pattern: "known-token", preview: redact(token[0]) }
  const quoted = QUOTED_ASSIGNMENT.exec(line)
  if (quoted && !isNonSecretValue(quoted[2])) return { pattern: "credential-assignment", preview: redact(quoted[2]) }
  if (ENV_FILE.test(relativePath.replaceAll("\\", "/"))) {
    const env = ENV_ASSIGNMENT.exec(line)
    if (env && !isNonSecretValue(env[2])) return { pattern: "credential-assignment", preview: redact(env[2]) }
  }
  return undefined
}

export function redact(value: string): string {
  return value.length <= 8 ? "[REDACTED]" : `${value.slice(0, 3)}…${value.slice(-4)}`
}
