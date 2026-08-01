import * as fs from "fs";
import * as path from "path";
import { type RuntimePaths } from "../paths.js";

export interface SecretLeakFinding {
  file: string;
  line: number;
  column: number;
  pattern: string;
  redactedPreview: string;
}

export interface SecretScanReport {
  scannedFiles: number;
  findings: SecretLeakFinding[];
  fixedFiles: string[];
}

interface SecretPattern {
  id: string;
  pattern: RegExp;
}

interface SecretMatch {
  start: number;
  end: number;
  value: string;
  pattern: string;
}

const PATTERNS: SecretPattern[] = [
  { id: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { id: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g },
  {
    id: "jwt_like_token",
    pattern: /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "generic_secret_assignment",
    pattern:
      /\b(?:api[_-]?key|token|secret|password|refresh[_-]?token|access[_-]?token)\s*[:=]\s*["']?[^"'\s,}]{12,}/gi,
  },
];

const TEXT_FILE_PATTERN = /\.(env|json|ya?ml|md|txt|log|mjs|cjs)$/i;
const SCAN_DIRS = ["config", "docs", "logs", "packages", "scripts", "bin"];
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;

function redact(input: string): string {
  if (input.length <= 12) return "[REDACTED]";
  return `${input.slice(0, 4)}...[REDACTED]...${input.slice(-4)}`;
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [root];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (
      entry.name === "backups" ||
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === ".git" ||
      entry.name === "coverage" ||
      entry.name === ".next" ||
      entry.name === "build" ||
      entry.name === "__pycache__"
    ) {
      continue;
    }
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    } else if (entry.isDirectory()) {
      files.push(...walkFiles(child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

function candidateFiles(paths: RuntimePaths): string[] {
  const files: string[] = [];
  const base = paths.sourceDir ?? paths.dataDir;
  const envFile = path.join(base, ".env");
  if (fs.existsSync(envFile)) files.push(envFile);
  const scanDirs: string[] = [];
  for (const dir of SCAN_DIRS) {
    if (dir === "config" && fs.existsSync(paths.configDir))
      scanDirs.push(paths.configDir);
    else if (dir === "docs" && fs.existsSync(paths.docsDir))
      scanDirs.push(paths.docsDir);
    else {
      const fullDir = path.resolve(paths.dataDir, "..", dir);
      if (fs.existsSync(fullDir)) scanDirs.push(fullDir);
    }
  }
  for (const fullDir of scanDirs) {
    files.push(...walkFiles(fullDir));
  }
  if (fs.existsSync(paths.dataDir)) {
    for (const entry of fs.readdirSync(paths.dataDir, {
      withFileTypes: true,
    })) {
      if (entry.isFile() && TEXT_FILE_PATTERN.test(entry.name)) {
        files.push(path.join(paths.dataDir, entry.name));
      }
    }
  }
  return [...new Set(files)].filter((file) => {
    if (!TEXT_FILE_PATTERN.test(file)) return false;
    try {
      const resolved = path.resolve(file);
      const stat = fs.lstatSync(resolved);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  });
}

function rangesOverlap(a: SecretMatch, b: SecretMatch): boolean {
  return a.start < b.end && b.start < a.end;
}

function collectMatches(content: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { id, pattern } of PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content))) {
      const value = match[0];
      if (isPlaceholderSecret(value)) continue;
      const candidate = {
        start: match.index,
        end: match.index + value.length,
        value,
        pattern: id,
      };
      if (!matches.some((existing) => rangesOverlap(existing, candidate))) {
        matches.push(candidate);
      }
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("os.environ/") ||
    normalized.includes("process.env.") ||
    normalized.includes("process.env[") ||
    normalized.includes("${") ||
    normalized.includes("[redacted]")
  );
}

function canFixFile(paths: RuntimePaths, file: string): boolean {
  const resolved = path.resolve(file);
  const docsResolved = path.resolve(paths.docsDir);
  const dataResolved = path.resolve(paths.dataDir);
  if (resolved.startsWith(docsResolved + path.sep) || resolved === docsResolved)
    return true;
  const logsResolved = path.resolve(paths.dataDir, "..", "logs");
  if (resolved.startsWith(logsResolved + path.sep) || resolved === logsResolved)
    return true;
  if (
    resolved.startsWith(dataResolved + path.sep) ||
    resolved === dataResolved
  ) {
    const relative = path.relative(dataResolved, resolved);
    return TEXT_FILE_PATTERN.test(relative);
  }
  return false;
}

function isSafeScanSize(file: string): boolean {
  try {
    return fs.statSync(file).size <= MAX_SCAN_FILE_BYTES;
  } catch {
    return false;
  }
}

function redactMatches(content: string, matches: SecretMatch[]): string {
  let next = content;
  for (const match of [...matches].sort((a, b) => b.start - a.start)) {
    next = `${next.slice(0, match.start)}[REDACTED]${next.slice(match.end)}`;
  }
  return next;
}

export function scanSecrets(
  paths: RuntimePaths,
  options: { fix?: boolean } = {},
): SecretScanReport {
  const findings: SecretLeakFinding[] = [];
  const fixedFiles: string[] = [];
  let scannedFiles = 0;

  for (const file of candidateFiles(paths)) {
    let content: string;
    try {
      if (!isSafeScanSize(file)) continue;
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    scannedFiles += 1;
    const original = content;
    const matches = collectMatches(original);

    for (const match of matches) {
      const prefix = original.slice(0, match.start);
      const line = prefix.split(/\r?\n/).length;
      const lastBreak = Math.max(
        prefix.lastIndexOf("\n"),
        prefix.lastIndexOf("\r"),
      );
      findings.push({
        file,
        line,
        column: match.start - lastBreak,
        pattern: match.pattern,
        redactedPreview: redact(match.value),
      });
    }

    if (options.fix && matches.length > 0 && canFixFile(paths, file)) {
      content = redactMatches(original, matches);
    }

    if (options.fix && content !== original) {
      const tmpPath = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, content, "utf-8");
      fs.renameSync(tmpPath, file);
      fixedFiles.push(path.relative(path.resolve(paths.dataDir, ".."), file));
    }
  }

  return { scannedFiles, findings, fixedFiles };
}
