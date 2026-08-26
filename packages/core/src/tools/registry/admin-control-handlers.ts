import * as crypto from "node:crypto";
import { getCallContext } from "../executor/call-context.js";
import type { ToolHandlerContext } from "./handlers.js";

type AdminOperation = "config_patch" | "tool_state";
type ApprovalContext = {
  runId: string;
  stepId: string;
  deliveryId: string;
  previewHash: string;
};
type ApprovalGate = { requestId: string; context: ApprovalContext };

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} is required`);
  return value.trim().slice(0, max);
}

function previewFor(
  operation: AdminOperation,
  args: Record<string, unknown>,
): string {
  const copy = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
  delete copy.approval_request_id;
  delete copy.approval_token;
  return JSON.stringify({ operation, args: copy });
}

function hashPreview(preview: string): string {
  return crypto.createHash("sha256").update(preview, "utf8").digest("hex");
}

function containsRawSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRawSecret);
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "secret_ref") continue;
    if (/(api[_-]?key|token|password|secret|private[_-]?key)/i.test(key)) {
      if (typeof child === "string" && child.trim()) return true;
    }
    if (containsRawSecret(child)) return true;
  }
  return false;
}

function assertPlainRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  const object = record(value, field);
  for (const key of Object.keys(object)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error(`${field} contains a forbidden key`);
    }
  }
  return object;
}

function assertRemotePatchAllowed(patch: Record<string, unknown>): void {
  const topLevel = Object.keys(patch);
  if (topLevel.some((key) => key !== "tools")) {
    throw new Error(
      "Remote Agent patches may only target tools.mcp or tools.tool_state",
    );
  }
  const tools = assertPlainRecord(patch.tools, "patch.tools");
  for (const key of Object.keys(tools)) {
    if (key !== "mcp" && key !== "tool_state") {
      throw new Error(
        "Remote Agent patches may only target tools.mcp or tools.tool_state",
      );
    }
  }
  if (tools.tool_state !== undefined) {
    const states = assertPlainRecord(
      tools.tool_state,
      "patch.tools.tool_state",
    );
    for (const [name, enabled] of Object.entries(states)) {
      if (!/^[A-Za-z0-9_:-]+$/.test(name) || typeof enabled !== "boolean") {
        throw new Error(
          "tool_state must map safe tool names to boolean values",
        );
      }
    }
  }
  if (tools.mcp !== undefined) {
    const mcp = assertPlainRecord(tools.mcp, "patch.tools.mcp");
    for (const key of Object.keys(mcp)) {
      if (!["enabled", "discovery", "servers"].includes(key)) {
        throw new Error(`Unsupported remote MCP patch field: ${key}`);
      }
    }
    if (mcp.enabled !== undefined && typeof mcp.enabled !== "boolean") {
      throw new Error("patch.tools.mcp.enabled must be boolean");
    }
    if (mcp.discovery !== undefined) {
      const discovery = assertPlainRecord(
        mcp.discovery,
        "patch.tools.mcp.discovery",
      );
      const allowed = new Set([
        "enabled",
        "ttl",
        "max_search_results",
        "use_bm25",
        "use_regex",
      ]);
      for (const key of Object.keys(discovery)) {
        if (!allowed.has(key))
          throw new Error(`Unsupported remote MCP discovery field: ${key}`);
      }
      if (
        discovery.enabled !== undefined &&
        typeof discovery.enabled !== "boolean"
      )
        throw new Error("MCP discovery enabled must be boolean");
      if (
        discovery.use_bm25 !== undefined &&
        typeof discovery.use_bm25 !== "boolean"
      )
        throw new Error("MCP discovery use_bm25 must be boolean");
      if (
        discovery.use_regex !== undefined &&
        typeof discovery.use_regex !== "boolean"
      )
        throw new Error("MCP discovery use_regex must be boolean");
      if (
        discovery.ttl !== undefined &&
        (!Number.isInteger(discovery.ttl) ||
          Number(discovery.ttl) < 1 ||
          Number(discovery.ttl) > 86400)
      )
        throw new Error("MCP discovery ttl must be an integer from 1 to 86400");
      if (
        discovery.max_search_results !== undefined &&
        (!Number.isInteger(discovery.max_search_results) ||
          Number(discovery.max_search_results) < 1 ||
          Number(discovery.max_search_results) > 100)
      )
        throw new Error(
          "MCP discovery max_search_results must be an integer from 1 to 100",
        );
    }
    if (mcp.servers !== undefined) {
      const servers = assertPlainRecord(mcp.servers, "patch.tools.mcp.servers");
      for (const [name, rawServer] of Object.entries(servers)) {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name))
          throw new Error("MCP server names must be simple identifiers");
        const server = assertPlainRecord(
          rawServer,
          `patch.tools.mcp.servers.${name}`,
        );
        for (const key of Object.keys(server)) {
          if (
            !["enabled", "deferred", "type", "url", "headers"].includes(key)
          ) {
            throw new Error(
              `Remote MCP server field ${key} is not allowed; stdio command execution is local-only`,
            );
          }
        }
        if (server.enabled !== undefined && typeof server.enabled !== "boolean")
          throw new Error("MCP server enabled must be boolean");
        if (
          server.deferred !== undefined &&
          typeof server.deferred !== "boolean"
        )
          throw new Error("MCP server deferred must be boolean");
        if (
          server.type !== undefined &&
          !["sse", "http", "streamable_http"].includes(String(server.type))
        )
          throw new Error(
            "Remote MCP administration only permits HTTP/SSE transports",
          );
        if (server.url !== undefined) {
          if (typeof server.url !== "string")
            throw new Error("MCP server url must be a string");
          const url = new URL(server.url);
          const localHttp =
            url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
          if (url.protocol !== "https:" && !localHttp)
            throw new Error(
              "MCP server url must use https, except loopback HTTP",
            );
        }
        if (server.headers !== undefined) {
          const headers = assertPlainRecord(
            server.headers,
            `patch.tools.mcp.servers.${name}.headers`,
          );
          for (const [header, value] of Object.entries(headers)) {
            if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(header))
              throw new Error("Invalid MCP header name");
            if (value !== null) {
              const ref = assertPlainRecord(value, `MCP header ${header}`);
              if (
                Object.keys(ref).length !== 1 ||
                typeof ref.secret_ref !== "string" ||
                !ref.secret_ref.trim()
              ) {
                throw new Error(
                  "MCP headers may only use {secret_ref: string}; raw credentials are not accepted",
                );
              }
            }
          }
        }
      }
    }
  }
}

function approvalGate(
  context: ToolHandlerContext,
  operation: AdminOperation,
  args: Record<string, unknown>,
): ApprovalGate | string | null {
  const caller = getCallContext();
  if (caller?.origin !== "remote") return null;
  if (!context.approvalInbox)
    throw new Error("Remote administration requires the approval service");
  if (typeof args.approval_token === "string" && args.approval_token.trim()) {
    throw new Error(
      "Approval tokens are not accepted in chat; obtain owner approval and retry with approval_request_id",
    );
  }

  const preview = previewFor(operation, args);
  const previewHash = hashPreview(preview);
  const approvalContext: ApprovalContext = {
    runId: `admin:${previewHash.slice(0, 16)}`,
    stepId: `admin-${operation}`,
    deliveryId:
      caller.requestId ||
      `${caller.source || "remote"}:${caller.actor || "unknown"}`,
    previewHash,
  };
  const actor = caller.actor || caller.source || "remote";
  const requestId =
    typeof args.approval_request_id === "string"
      ? args.approval_request_id.trim()
      : "";
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
      operation === "tool_state"
        ? `tool:${String(args.name || "unknown")}`
        : "agent-config",
    risk: "high",
    reason:
      operation === "tool_state"
        ? "Change an Agent tool enablement state"
        : "Apply an Agent runtime configuration patch",
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
  context.approvalInbox?.consumeByContext(
    gate.requestId,
    gate.context,
    getCallContext()?.actor || "remote",
  );
}

export function handleAdminConfigGet(this: ToolHandlerContext): string {
  if (!this.adminController)
    throw new Error("Administration controller is not initialized");
  return JSON.stringify(
    { success: true, config: this.adminController.getConfig() },
    null,
    2,
  );
}

export function handleAdminConfigValidate(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): string {
  if (!this.adminController)
    throw new Error("Administration controller is not initialized");
  const patch = assertPlainRecord(args.patch, "patch");
  assertRemotePatchAllowed(patch);
  if (containsRawSecret(patch)) {
    throw new Error(
      "Raw credentials are not accepted by chat administration; use the credential vault",
    );
  }
  return JSON.stringify(
    { success: true, validation: this.adminController.validatePatch(patch) },
    null,
    2,
  );
}

export async function handleAdminConfigPatch(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!this.adminController)
    throw new Error("Administration controller is not initialized");
  const patch = assertPlainRecord(args.patch, "patch");
  if (getCallContext()?.origin === "remote") assertRemotePatchAllowed(patch);
  if (containsRawSecret(patch)) {
    throw new Error(
      "Raw credentials are not accepted by chat administration; use the credential vault",
    );
  }
  const gate = approvalGate(this, "config_patch", args);
  if (typeof gate === "string") return gate;
  if (gate) consumeApproval(this, gate);
  const result = await this.adminController.applyPatch(
    patch,
    "agent.admin.config_patch",
  );
  return JSON.stringify({ success: true, ...result }, null, 2);
}

export async function handleAdminToolState(
  this: ToolHandlerContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!this.adminController)
    throw new Error("Administration controller is not initialized");
  const name = requiredText(args.name, "name");
  if (!/^[A-Za-z0-9_:-]+$/.test(name)) throw new Error("Invalid tool name");
  if (typeof args.enabled !== "boolean")
    throw new Error("enabled must be boolean");
  const gate = approvalGate(this, "tool_state", args);
  if (typeof gate === "string") return gate;
  if (gate) consumeApproval(this, gate);
  const result = await this.adminController.setToolState(name, args.enabled);
  return JSON.stringify(
    { success: true, tool: name, enabled: args.enabled, ...result },
    null,
    2,
  );
}
