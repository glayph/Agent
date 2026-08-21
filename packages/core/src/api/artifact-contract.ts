import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ArtifactContract {
  root: string;
  required: string[];
  label: string;
}

export interface ArtifactVerification {
  ok: boolean;
  missing: string[];
  invalid: string[];
}

export interface ArtifactManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  label: string;
  root: string;
  generatedAt: string;
  required: string[];
  files: ArtifactManifestEntry[];
}

const MANIFEST_NAME = "MANIFEST.json";

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function detectArtifactContract(content: string, workspaceRoot?: string): ArtifactContract | null {
  const hasLandingIntent = /landing\s*page|static\s+(site|page)|index\.html|styles?\.css|website|ল্যান্ডিং\s*পেজ|ওয়েবসাইট|ওয়েবসাইট|পেজ\s+তৈরি/i.test(content);
  if (!hasLandingIntent) return null;

  const absolutePath = content.match(/\/(?:home|tmp|workspace|var)\/[^\s`'\"]+/)?.[0];
  const normalized = absolutePath?.replace(/[),.;:]+$/, "");
  const candidateRoot = normalized && /\.(html|css|js|tsx?|jsx?)$/i.test(normalized)
    ? path.dirname(normalized)
    : normalized;
  const root = workspaceRoot
    ? candidateRoot && isWithinRoot(workspaceRoot, candidateRoot)
      ? path.resolve(candidateRoot)
      : path.resolve(workspaceRoot)
    : candidateRoot
      ? path.resolve(candidateRoot)
      : undefined;
  if (!root) return null;

  const required = /styles?\.css|css\s+file|স্টাইল\s*শিট/i.test(content)
    ? ["index.html", "styles.css"]
    : ["index.html"];
  return { root, required, label: "landing page" };
}

export function verifyArtifactContract(contract: ArtifactContract): ArtifactVerification {
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const relative of contract.required) {
    const target = path.join(contract.root, relative);
    if (!isWithinRoot(contract.root, target) || !fs.existsSync(target)) {
      missing.push(relative);
      continue;
    }
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size < 32) {
        invalid.push(relative);
        continue;
      }
      if (relative.toLowerCase() === "index.html") {
        const source = fs.readFileSync(target, "utf8");
        if (!/<(?:!doctype\s+html|html\b|body\b)/i.test(source)) invalid.push(relative);
      }
    } catch {
      invalid.push(relative);
    }
  }
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

function collectFiles(root: string, current: string, output: ArtifactManifestEntry[]): void {
  if (output.length >= 5_000) return;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if ([".git", "node_modules", ".trash", MANIFEST_NAME].includes(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, absolute, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const content = fs.readFileSync(absolute);
    output.push({
      path: path.relative(root, absolute).split(path.sep).join("/"),
      bytes: content.byteLength,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    });
  }
}

export function buildArtifactManifest(contract: ArtifactContract): ArtifactManifest {
  const files: ArtifactManifestEntry[] = [];
  if (fs.existsSync(contract.root) && fs.statSync(contract.root).isDirectory()) {
    collectFiles(contract.root, contract.root, files);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    label: contract.label,
    root: contract.root,
    generatedAt: new Date().toISOString(),
    required: [...contract.required],
    files,
  };
}

export function writeArtifactManifest(contract: ArtifactContract): string {
  const manifest = buildArtifactManifest(contract);
  const target = path.join(contract.root, MANIFEST_NAME);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
  return target;
}
