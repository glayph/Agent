import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { ApprovalInbox } from "../../security/approval-inbox.js";
import { runWithCallContext } from "../executor/call-context.js";
import { resolveDownloadedSkillsDir } from "../../paths.js";
import type { LauncherAdminController } from "../../api/launcher-compat.js";
import { ToolRegistry } from "./executor.js";

describe("ToolRegistry", () => {
  function createRegistry(workspaceDir: string): ToolRegistry {
    return new ToolRegistry({
      configDir: path.join(workspaceDir, "config"),
      dataDir: path.join(workspaceDir, "data"),
      skillsDir: path.join(workspaceDir, "src", "skills"),
      cacheDir: path.join(workspaceDir, "data", "cache"),
      binDir: path.join(workspaceDir, "bin"),
      docsDir: path.join(workspaceDir, "docs"),
      outputDir: path.join(workspaceDir, "output"),
      sourceDir: workspaceDir,
    });
  }

  it("does not expose the system index search tool", () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tool-registry-"),
    );

    try {
      const names = createRegistry(workspaceDir)
        .getToolDefinitions()
        .map((tool) => tool.function?.name ?? "");

      expect(names).not.toContain("system_index_search");
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("reports file-operation errors as failed structured results", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tool-registry-file-error-"),
    );

    try {
      const result = await createRegistry(workspaceDir).executeToolStructured(
        "file_read",
        { path: path.join(workspaceDir, "missing.txt") },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("file_read failed");
      expect(result.output).toBe("");
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("honors file-delete dry runs and leaves the file in place", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tool-registry-file-dry-run-"),
    );
    const targetPath = path.join(workspaceDir, "keep.txt");
    fs.writeFileSync(targetPath, "keep", "utf-8");

    try {
      const result = await createRegistry(workspaceDir).executeToolStructured(
        "file_delete",
        { path: targetPath, dryRun: true },
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("DRY-RUN");
      expect(fs.existsSync(targetPath)).toBe(true);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("requires external owner approval before creating an Agent-authored skill", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tool-registry-skill-approval-"),
    );
    const registry = createRegistry(workspaceDir);
    const approvals = new ApprovalInbox(
      path.join(workspaceDir, "approvals.json"),
    );
    registry.setApprovalInbox(approvals);
    const args = {
      name: "incident_triage",
      description: "Triage incident reports",
      instructions:
        "Classify the report and produce a short next-step summary.",
      tags: ["incident", "triage"],
    };

    try {
      const pending = await runWithCallContext(
        { origin: "remote", source: "mcp", actor: "mcp-session" },
        () => registry.executeToolStructured("skill_create", args),
      );
      expect(pending.success).toBe(true);
      const request = JSON.parse(pending.output);
      expect(request.approval_required).toBe(true);
      expect(request.request_id).toEqual(expect.any(String));
      expect(request.approval_token).toBeUndefined();
      expect(request.token).toBeUndefined();

      const skillRoot = resolveDownloadedSkillsDir(
        registry.runtimePaths,
        registry.workspaceDir,
      );
      expect(fs.existsSync(skillRoot)).toBe(false);

      approvals.approveByOperator(request.request_id, "web-owner");
      const completed = await runWithCallContext(
        { origin: "remote", source: "mcp", actor: "mcp-session" },
        () =>
          registry.executeToolStructured("skill_create", {
            ...args,
            approval_request_id: request.request_id,
          }),
      );
      expect(completed.success).toBe(true);
      expect(JSON.parse(completed.output).success).toBe(true);
      expect(
        fs.existsSync(
          path.join(
            skillRoot,
            "agent-created-incident_triage_assets",
            "SKILL.md",
          ),
        ),
      ).toBe(true);

      const replay = await runWithCallContext(
        { origin: "remote", source: "mcp", actor: "mcp-session" },
        () =>
          registry.executeToolStructured("skill_create", {
            ...args,
            approval_request_id: request.request_id,
          }),
      );
      expect(replay.success).toBe(false);
      expect(replay.error).toContain("already been consumed");
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("installs a manifest-validated local skill only after owner approval", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tool-registry-skill-install-"),
    );
    const pluginDir = path.join(workspaceDir, "plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "index.ts"), "export {};\\n", "utf8");
    fs.writeFileSync(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "approved_local_plugin",
        version: "1.0.0",
        description: "A disposable validated plugin",
        plugin: { entrypoint: "index.ts" },
      }),
      "utf8",
    );
    const registry = createRegistry(workspaceDir);
    const approvals = new ApprovalInbox(
      path.join(workspaceDir, "approvals.json"),
    );
    registry.setApprovalInbox(approvals);

    try {
      const pending = await runWithCallContext(
        { origin: "remote", source: "mcp", actor: "mcp-session" },
        () =>
          registry.executeToolStructured("skill_install", {
            spec: pluginDir,
          }),
      );
      expect(pending.success).toBe(true);
      const request = JSON.parse(pending.output);
      expect(request.approval_required).toBe(true);
      expect(request.approval_token).toBeUndefined();
      approvals.approveByOperator(request.request_id, "owner");

      const completed = await runWithCallContext(
        { origin: "remote", source: "mcp", actor: "mcp-session" },
        () =>
          registry.executeToolStructured("skill_install", {
            spec: pluginDir,
            approval_request_id: request.request_id,
          }),
      );
      expect(completed.success).toBe(true);
      expect(JSON.parse(completed.output).success).toBe(true);
      expect(
        fs.existsSync(
          path.join(
            resolveDownloadedSkillsDir(
              registry.runtimePaths,
              registry.workspaceDir,
            ),
            "approved_local_plugin.ts",
          ),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported remote admin patch paths before creating an approval", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tool-registry-admin-policy-"),
    );
    const registry = createRegistry(workspaceDir);
    registry.setApprovalInbox(
      new ApprovalInbox(path.join(workspaceDir, "approvals.json")),
    );
    registry.setAdminController({
      getConfig: () => ({}),
      validateConfig: () => ({ valid: true }),
      validatePatch: () => ({ valid: true }),
      applyPatch: async () => ({ status: "ok" }),
      setToolState: async () => ({ status: "ok" }),
    });

    try {
      const result = await runWithCallContext(
        { origin: "remote", source: "mcp", actor: "mcp-session" },
        () =>
          registry.executeToolStructured("admin_config_patch", {
            patch: { runtime: { exec: { allow_remote: true } } },
          }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("tools.mcp or tools.tool_state");
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("requires owner approval for remote validated configuration patches", async () => {
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tool-registry-admin-approval-"),
    );
    const registry = createRegistry(workspaceDir);
    const approvals = new ApprovalInbox(
      path.join(workspaceDir, "approvals.json"),
    );
    registry.setApprovalInbox(approvals);
    const applyPatch = async () => ({
      status: "ok",
      validation: { valid: true },
    });
    const controller: LauncherAdminController = {
      getConfig: () => ({ tools: { tool_state: {} } }),
      validateConfig: () => ({ valid: true }),
      validatePatch: () => ({ valid: true }),
      applyPatch,
      setToolState: async () => ({ status: "ok" }),
    };
    registry.setAdminController(controller);

    try {
      const validation = await registry.executeToolStructured(
        "admin_config_validate",
        { patch: { tools: { mcp: { discovery: { enabled: true } } } } },
      );
      expect(validation.success).toBe(true);
      expect(validation.output).toContain('"valid": true');

      const patch = { tools: { tool_state: { web_search: false } } };
      const pending = await runWithCallContext(
        { origin: "remote", source: "telegram", actor: "telegram:123" },
        () => registry.executeToolStructured("admin_config_patch", { patch }),
      );
      expect(pending.success).toBe(true);
      const request = JSON.parse(pending.output);
      expect(request.approval_required).toBe(true);
      expect(request.approval_token).toBeUndefined();

      approvals.approveByOperator(request.request_id, "telegram-owner");
      const completed = await runWithCallContext(
        { origin: "remote", source: "telegram", actor: "telegram:123" },
        () =>
          registry.executeToolStructured("admin_config_patch", {
            patch,
            approval_request_id: request.request_id,
          }),
      );
      expect(completed.success).toBe(true);
      expect(completed.output).toContain('"status": "ok"');
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
