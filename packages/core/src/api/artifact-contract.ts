import * as fs from "node:fs";
import * as path from "node:path";
import { detectDeterministicIntent } from "../deterministic-intent.js";

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

export type ArtifactRunStatus =
  "completed" | "completed_with_warning" | "failed";

function providerLabelForRuntimeModel(model: string): string {
  if (/^(llama\.cpp|llama-cpp|llamacpp|local-llama)\//i.test(model)) {
    return "llama.cpp";
  }
  if (/^(gemini|google)(?:\/|-)/i.test(model)) return "Gemini";
  return "unknown";
}

/**
 * Repairs only an explicit Markdown `Provider/Model:` metadata field.
 * User prose and arbitrary content are intentionally left untouched.
 */
export function repairProviderModelMetadata(
  contract: ArtifactContract,
  runtimeModel: string,
): string[] {
  const provider = providerLabelForRuntimeModel(runtimeModel);
  if (provider === "unknown" || !runtimeModel.trim()) return [];
  const repaired: string[] = [];
  const metadataLine =
    /^(\s*(?:[-*]\s*)?(?:\*\*)?Provider\s*\/\s*Model(?:\*\*)?\s*:\s*).+$/gim;
  for (const relative of contract.required) {
    if (!/\.(?:md|markdown|mdx|txt)$/i.test(relative)) continue;
    const target = path.join(contract.root, relative);
    if (!isWithinRealRoot(contract.root, target) || !fs.existsSync(target))
      continue;
    try {
      const source = fs.readFileSync(target, "utf8");
      const expected = `${provider} — ${runtimeModel}`;
      const updated = source.replace(metadataLine, `$1${expected}`);
      if (updated !== source) {
        fs.writeFileSync(target, updated, "utf8");
        repaired.push(relative);
      }
    } catch {
      // Verification remains authoritative if an artifact cannot be repaired.
    }
  }
  return repaired;
}

export function reconcileArtifactOutcome(
  verification: ArtifactVerification,
  providerFailureDetected: boolean,
  attachmentPersistenceSucceeded: boolean = true,
): ArtifactRunStatus {
  if (!verification.ok || !attachmentPersistenceSucceeded) return "failed";
  return providerFailureDetected ? "completed_with_warning" : "completed";
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isWithinRealRoot(root: string, candidate: string): boolean {
  if (!isWithinRoot(root, candidate)) return false;
  try {
    const realRoot = fs.realpathSync.native(root);
    const realCandidate = fs.realpathSync.native(candidate);
    return isWithinRoot(realRoot, realCandidate);
  } catch {
    return false;
  }
}

export function detectArtifactContract(
  content: string,
  workspaceRoot?: string,
): ArtifactContract | null {
  const deterministicIntent = detectDeterministicIntent(content);
  if (
    workspaceRoot &&
    deterministicIntent?.kind === "file_workflow" &&
    deterministicIntent.files?.length
  ) {
    const required = deterministicIntent.files
      .map((file) => file.path.replace(/\\/g, "/"))
      .filter(
        (file) =>
          file &&
          !file.startsWith("/") &&
          !file.split("/").some((part) => part === ".."),
      );
    if (required.length === deterministicIntent.files.length) {
      return {
        root: path.resolve(workspaceRoot),
        required: [...new Set(required)],
        label: "file workflow",
      };
    }
  }

  const hasLandingIntent =
    /landing\s*page|static\s+(site|page)|index\.html|styles?\.css|website|ল্যান্ডিং\s*পেজ|ওয়েবসাইট|ওয়েবসাইট|পেজ\s+তৈরি/i.test(
      content,
    );
  if (!hasLandingIntent) return null;

  const absolutePath = content.match(
    /\/(?:home|tmp|workspace|var)\/[^\s`'\"]+/,
  )?.[0];
  const normalized = absolutePath?.replace(/[),.;:]+$/, "");
  const candidateRoot =
    normalized && /\.(html|css|js|tsx?|jsx?)$/i.test(normalized)
      ? path.dirname(normalized)
      : normalized;
  const relativeHtmlPath = content
    .match(/(?:^|[\s`'\"])((?:[A-Za-z0-9._-]+\/)+index\.html)\b/i)?.[1]
    ?.replace(/\s+/g, "");
  const relativeRoot =
    workspaceRoot && relativeHtmlPath
      ? path.resolve(workspaceRoot, path.dirname(relativeHtmlPath))
      : undefined;
  const root = workspaceRoot
    ? relativeRoot && isWithinRoot(workspaceRoot, relativeRoot)
      ? relativeRoot
      : candidateRoot && isWithinRoot(workspaceRoot, candidateRoot)
        ? path.resolve(candidateRoot)
        : path.resolve(workspaceRoot)
    : candidateRoot
      ? path.resolve(candidateRoot)
      : undefined;
  if (!root) return null;

  const required = /styles?\.css|css\s+file|স্টাইল\s*শিট/i.test(content)
    ? ["index.html", "styles.css"]
    : ["index.html"];
  if (
    /screenshot|screen\s*capture|capture\s+the\s+page|স্ক্রিনশট|স্ক্রিন\s*ক্যাপচার/i.test(
      content,
    )
  ) {
    required.push("hello-world-landing.png");
  }
  return { root, required, label: "landing page" };
}

export function verifyArtifactContract(
  contract: ArtifactContract,
): ArtifactVerification {
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const relative of contract.required) {
    const target = path.join(contract.root, relative);
    if (!isWithinRealRoot(contract.root, target) || !fs.existsSync(target)) {
      missing.push(relative);
      continue;
    }
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size === 0) {
        invalid.push(relative);
        continue;
      }
      if (relative.toLowerCase() === "index.html") {
        const source = fs.readFileSync(target, "utf8");
        if (!/<(?:!doctype\s+html|html|body|main)\b/i.test(source))
          invalid.push(relative);
      }
    } catch {
      invalid.push(relative);
    }
  }
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}
