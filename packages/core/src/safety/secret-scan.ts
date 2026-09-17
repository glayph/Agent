import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimePaths } from "../paths.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".conf",
  ".config",
  ".css",
  ".env",
  ".go",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const IGNORED_DIRS = new Set([
  ".git",
  ".trash",
  ".miki-build",
  ".next",
  ".cache",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
  "vendorized",
  "__pycache__",
]);

export interface SecretScanFinding {
  file: string;
  line: number;
  pattern: string;
  redactedPreview: string;
}

export interface SecretScanReport {
  scannedAt: string;
  checkedFiles: number;
  scannedFiles: number;
  skippedFiles: number;
  findings: SecretScanFinding[];
  /** Matches in non-production tests/examples are reported but do not degrade runtime health. */
  fixtureFindings: SecretScanFinding[];
  fixedFiles: string[];
}

export interface SecretScanOptions {
  fix?: boolean;
  maxFileBytes?: number;
}

type Match = { pattern: string; start: number; end: number; value: string };

const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: "provider-key",
    regex:
      /\b(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|OPENROUTER|DEEPSEEK|AZURE_OPENAI)_API_KEY\b[ \t]*[:=][ \t]*["']?([A-Za-z0-9_./+=:-]{12,})/gi,
  },
  {
    name: "oauth-token",
    regex: /\b(?:xox[baprs]-|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/g,
  },
  { name: "cloud-key", regex: /\bAIza[A-Za-z0-9_-]{20,}\b/g },
  { name: "aws-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: "secret-assignment",
    regex:
      /\b(?:token|secret|password|api[_-]?key|authorization)\b[ \t]*[:=][ \t]*["']([A-Za-z0-9_./+=:-]{16,})["']/gi,
  },
  { name: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9._~+\-/=]{16,}/gi },
];

function rootFor(paths: RuntimePaths): string {
  return path.resolve(paths.sourceDir || path.dirname(paths.configDir));
}

function isTextCandidate(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base === ".env" || base.startsWith(".env.")) return true;
  return TEXT_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function collectFiles(
  root: string,
  maxBytes: number,
): { files: string[]; skippedFiles: number } {
  const files: string[] = [];
  let skippedFiles = 0;
  const walk = (directory: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skippedFiles += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile() || !isTextCandidate(full)) continue;
      try {
        const size = fs.statSync(full).size;
        if (size > maxBytes) {
          skippedFiles += 1;
          continue;
        }
        files.push(full);
      } catch {
        skippedFiles += 1;
      }
    }
  };
  walk(root);
  return { files, skippedFiles };
}

function isSafeStaticValue(pattern: string, value: string): boolean {
  if (pattern !== "secret-assignment") return false;
  // Code often assigns an environment-variable name rather than a secret
  // value. These identifiers are not credentials and should not degrade the
  // runtime health report.
  if (
    /^[A-Z][A-Z0-9_]{5,}$/.test(value) &&
    /_(?:KEY|TOKEN|SECRET|PASSWORD|URL)$/.test(value)
  ) {
    return true;
  }
  // This is an explicit local adapter sentinel, not an authentication secret.
  return /^(?:local-no-auth-required|not-configured|not-set|none|null)$/i.test(
    value,
  );
}

function collectMatches(content: string): Match[] {
  const matches: Match[] = [];
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(content))) {
      const value =
        match[1] &&
        pattern.name !== "bearer-token" &&
        pattern.name !== "oauth-token" &&
        pattern.name !== "cloud-key" &&
        pattern.name !== "aws-key"
          ? match[1]
          : match[0];
      if (isSafeStaticValue(pattern.name, value)) {
        continue;
      }
      const offset = match[0].indexOf(value);
      matches.push({
        pattern: pattern.name,
        start: match.index + Math.max(0, offset),
        end: match.index + Math.max(0, offset) + value.length,
        value,
      });
      if (matches.length >= 32) break;
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

function redactPreview(value: string): string {
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

function relativeFile(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  return relative || path.basename(filePath);
}

function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split(/\r?\n/).length;
}

function isFixturePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll(path.sep, "/");
  const base = path.basename(normalized);
  return (
    base === ".env.example" ||
    base === ".env.sample" ||
    base === ".env.template" ||
    normalized.includes("/__tests__/") ||
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    /(?:^|[._-])(?:test|spec)(?:[._-]|$)/i.test(base) ||
    /_test\.(?:go|js|ts|tsx|jsx|mjs|cjs)$/i.test(base)
  );
}

function replaceMatches(content: string, matches: Match[]): string {
  let output = content;
  for (const match of [...matches].sort((a, b) => b.start - a.start)) {
    output = `${output.slice(0, match.start)}[REDACTED]${output.slice(match.end)}`;
  }
  return output;
}

export function scanSecrets(
  paths: RuntimePaths,
  options: SecretScanOptions = {},
): SecretScanReport {
  const root = rootFor(paths);
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const { files, skippedFiles: initialSkipped } = collectFiles(
    root,
    maxFileBytes,
  );
  const findings: SecretScanFinding[] = [];
  const fixtureFindings: SecretScanFinding[] = [];
  const fixedFiles = new Set<string>();
  let skippedFiles = initialSkipped;

  for (const filePath of files) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      skippedFiles += 1;
      continue;
    }
    const matches = collectMatches(content);
    if (matches.length === 0) continue;
    const file = relativeFile(root, filePath);
    const finding = {
      file,
      line: lineAt(content, matches[0].start),
      pattern: matches[0].pattern,
      redactedPreview: redactPreview(matches[0].value),
    };
    if (isFixturePath(file)) {
      fixtureFindings.push(finding);
      continue;
    }
    findings.push(finding);
    if (
      options.fix &&
      path.basename(filePath) !== ".env" &&
      !path.basename(filePath).startsWith(".env.")
    ) {
      try {
        fs.writeFileSync(filePath, replaceMatches(content, matches), "utf8");
        fixedFiles.add(file);
      } catch {
        skippedFiles += 1;
      }
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    checkedFiles: files.length,
    scannedFiles: files.length,
    skippedFiles,
    findings,
    fixtureFindings,
    fixedFiles: [...fixedFiles].sort(),
  };
}
