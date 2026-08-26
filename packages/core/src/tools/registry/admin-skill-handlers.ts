import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SkillInstaller, SkillRegistry } from "@miki/installer";
import { getSkillLoader } from "../../skill-loader.js";
import { resolveDownloadedSkillsDir } from "../../paths.js";
import { registerRuntimePluginTools } from "../../plugins/plugin-tool-registration.js";
import { getCallContext } from "../executor/call-context.js";
import type { ToolHandlerContext } from "./handlers.js";

const MAX_SKILL_CONTENT = 64 * 1024;
const MAX_SKILL_NAME = 64;

type SkillOperation = "create" | "install";
type ApprovalContext = {
  runId: string;
  stepId: string;
  deliveryId: string;
  previewHash: string;
};
type ApprovalGate = { requestId: string; context: ApprovalContext };

function text(value: unknown, field: string, max = 2048): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim().slice(0, max);
}

function safeName(value: string): string {
  const name = text(value, "name", MAX_SKILL_NAME);
  if (!/^[A-Za-z0-9_-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(
      "name must contain only letters, numbers, underscore, or hyphen",
    );
  }
  return name;
}

function canonicalPreview(
  operation: SkillOperation,
  args: Record<string, unknown>,
): string {
  const copy = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
  delete copy.approval_request_id;
  delete copy.approval_token;
  return JSON.stringify({ operation, args: copy });
}

function previewHash(preview: string): string {
  return crypto.createHash("sha256").update(preview, "utf8").digest("hex");
}

function approvalFor(
  context: ToolHandlerContext,
  operation: SkillOperation,
  args: Record<string, unknown>,
): ApprovalGate | string | null {
  const caller = getCallContext();
  if (caller?.origin !== "remote") return null;
  if (!context.approvalInbox) {
    throw new Error("Remote skill operations require the approval service");
  }
  if (typeof args.approval_token === "string" && args.approval_token.trim()) {
    throw new Error(
      "Approval tokens are not accepted in chat; obtain owner approval and retry with approval_request_id",
    );
  }

  const preview = canonicalPreview(operation, args);
  const hash = previewHash(preview);
  const approvalContext: ApprovalContext = {
    runId: `skill-admin:${hash.slice(0, 16)}`,
    stepId: `skill-${operation}`,
    deliveryId:
      caller.requestId ||
      `${caller.source || "remote"}:${caller.actor || "unknown"}`,
    previewHash: hash,
  };
  const requestId =
    typeof args.approval_request_id === "string"
      ? args.approval_request_id.trim()
      : "";
  const actor = caller.actor || caller.source || "remote";
  if (requestId) {
    context.approvalInbox.assertApprovedByContext(
      requestId,
      approvalContext,
      actor,
    );
    return { requestId, context: approvalContext };
  }

  const challenge = context.approvalInbox.request({
    runId: approvalContext.runId,
    actor,
    action: "external_write",
    resource:
      operation === "install"
        ? text(args.spec, "spec", 4096)
        : `skill:${String(args.name || "unknown")}`,
    risk: "high",
    reason:
      operation === "install"
        ? "Install third-party skill/plugin files"
        : "Create and register an Agent-authored skill",
    context: approvalContext,
    ttlMs: 10 * 60 * 1000,
  });
  return JSON.stringify({
    approval_required: true,
    request_id: challenge.request.id,
    expires_at: challenge.request.expiresAt,
    preview: JSON.parse(preview),
    instruction:
      "An authenticated owner must approve this request in the Web UI or with the allow-listed Telegram approval command. Retry the same operation with approval_request_id only; no approval token is needed or returned.",
  });
}

function consumeApproval(
  context: ToolHandlerContext,
  gate: ApprovalGate,
): void {
  const actor = getCallContext()?.actor || "remote";
  context.approvalInbox?.consumeByContext(gate.requestId, gate.context, actor);
}

function skillRoot(context: ToolHandlerContext): string {
  return resolveDownloadedSkillsDir(context.runtimePaths, context.workspaceDir);
}

export async function handleSkillSearch(
  _context: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const query = text(args.query, "query", 512);
  const response = await fetch(
    `https://www.skills.sh/api/skills?q=${encodeURIComponent(query)}&limit=20`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!response.ok)
    throw new Error(`skills.sh API returned ${response.status}`);
  const payload = (await response.json()) as {
    skills?: unknown[];
    data?: unknown[];
  };
  const skills = (payload.skills || payload.data || []).slice(0, 20);
  return JSON.stringify({ query, total: skills.length, skills }, null, 2);
}

export async function handleSkillCreate(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const name = safeName(String(args.name || ""));
  const description = text(args.description, "description", 2000);
  const instructions = text(
    args.instructions,
    "instructions",
    MAX_SKILL_CONTENT,
  );
  if (instructions.length > MAX_SKILL_CONTENT)
    throw new Error("instructions exceed the 64 KiB limit");
  const tags = Array.isArray(args.tags)
    ? args.tags
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 20)
    : [];
  const approval = approvalFor(this, "create", args);
  if (typeof approval === "string") return approval;
  if (approval) consumeApproval(this, approval);

  const root = skillRoot(this);
  const id = `agent-created-${name}`;
  const assetsPath = path.join(root, `${id}_assets`);
  const entrypointPath = path.join(root, `${id}.ts`);
  fs.mkdirSync(assetsPath, { recursive: true });
  const skillMd = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "category: agent-created",
    `tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
    "version: 0.1.0",
    "enabled: true",
    "---",
    "",
    `# ${name}`,
    "",
    instructions,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(assetsPath, "SKILL.md"), skillMd, "utf8");
  fs.writeFileSync(
    path.join(assetsPath, "skill.json"),
    `${JSON.stringify({ name, description, category: "agent-created", tags, version: "0.1.0", created_by: "agent" }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    entrypointPath,
    `// Agent-authored skill package: ${name}\nexport const DESCRIPTION = ${JSON.stringify(description)};\n`,
    "utf8",
  );

  const registry = new SkillRegistry(root);
  await registry.init();
  await registry.register({
    success: true,
    name: id,
    version: "0.1.0",
    description,
    path: entrypointPath,
    entrypoint: `${id}.ts`,
    assetsPath,
    action: "installed",
  });
  try {
    getSkillLoader().refreshCache();
  } catch {
    // The loader is initialized by the runtime before agent turns; keep the file result usable in isolated tests.
  }
  return JSON.stringify(
    {
      success: true,
      action: "created",
      name: id,
      description,
      path: assetsPath,
      active: true,
      message:
        "Agent-authored skill created and registered in the isolated downloaded-skills registry.",
    },
    null,
    2,
  );
}

export async function handleSkillInstall(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  const spec = text(args.spec, "spec", 4096);
  const approval = approvalFor(this, "install", args);
  if (typeof approval === "string") return approval;
  if (approval) consumeApproval(this, approval);

  const root = skillRoot(this);
  const installer = new SkillInstaller(root);
  await installer.init();
  const result = await installer.install(spec, { force: args.force === true });
  if (result.success || result.action === "skipped") {
    try {
      getSkillLoader().refreshCache();
    } catch {
      // Loader refresh is best effort for isolated unit tests.
    }
    const pluginTools = this.orchestrator
      ? await registerRuntimePluginTools(
          this.orchestrator.tools,
          this.runtimePaths,
          { replaceExisting: true },
        )
      : undefined;
    return JSON.stringify({ ...result, pluginTools }, null, 2);
  }
  return JSON.stringify(result, null, 2);
}
