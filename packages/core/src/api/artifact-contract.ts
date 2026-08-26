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

export function reconcileArtifactOutcome(
  verification: ArtifactVerification,
  providerFailureDetected: boolean,
): ArtifactRunStatus {
  if (!verification.ok) return "failed";
  return providerFailureDetected ? "completed_with_warning" : "completed";
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
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

export function verifyArtifactContract(
  contract: ArtifactContract,
): ArtifactVerification {
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
