import type { AgentControlService } from "./service.js";
import type { ControlOperationRequest } from "./types.js";
import { parseControlIntent } from "./intent.js";

export interface ControlToolDefinition {
  name: string;
  description: string;
  risk: "read" | "config_write" | "install" | "service" | "destructive";
  parameters: Record<string, unknown>;
}

export interface ControlToolFactory {
  definitions: ControlToolDefinition[];
  execute(
    name: string,
    input: Record<string, unknown>,
    context?: ControlOperationRequest["context"],
  ): Promise<Record<string, unknown>>;
}

const definitions: ControlToolDefinition[] = [
  {
    name: "agent_control_capabilities",
    description:
      "List the typed, safe agent-management operations available in the current runtime.",
    risk: "read",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agent_control_state",
    description:
      "Inspect sanitized runtime configuration, tool state, model state, and control status.",
    risk: "read",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agent_control_plan",
    description:
      "Create a validated, approval-aware plan for a typed control operation without mutating state.",
    risk: "read",
    parameters: {
      type: "object",
      required: ["capability", "action"],
      properties: {
        capability: { type: "string" },
        action: { type: "string" },
        input: { type: "object" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agent_control_request",
    description:
      "Interpret one unambiguous self-management request, then plan and execute it through the guarded control service.",
    risk: "config_write",
    parameters: {
      type: "object",
      required: ["message"],
      properties: { message: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "agent_control_execute",
    description:
      "Execute a previously planned typed control operation, subject to validation and approval gates.",
    risk: "config_write",
    parameters: {
      type: "object",
      required: ["capability", "action"],
      properties: {
        capability: { type: "string" },
        action: { type: "string" },
        input: { type: "object" },
        approvalRequestId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

export function createControlToolFactory(
  service: AgentControlService,
): ControlToolFactory {
  return {
    definitions: definitions.map((definition) => ({
      ...definition,
      parameters: JSON.parse(JSON.stringify(definition.parameters)),
    })),
    async execute(name, input, context) {
      const effectiveContext = context || { origin: "api" as const };
      if (name === "agent_control_capabilities") {
        return { capabilities: service.listCapabilities() };
      }
      if (name === "agent_control_state") {
        return { state: service.getState() };
      }
      const request: ControlOperationRequest = {
        capability:
          typeof input.capability === "string" ? input.capability : "",
        action: typeof input.action === "string" ? input.action : "",
        input:
          input.input &&
          typeof input.input === "object" &&
          !Array.isArray(input.input)
            ? (input.input as Record<string, unknown>)
            : {},
        approvalRequestId:
          typeof input.approvalRequestId === "string"
            ? input.approvalRequestId
            : undefined,
        context: effectiveContext,
      };
      if (name === "agent_control_request") {
        const message = typeof input.message === "string" ? input.message : "";
        const parsed = parseControlIntent(message);
        if (!parsed.matched || !parsed.request) return { parsed };
        const guardedRequest = { ...parsed.request, context: effectiveContext };
        return {
          parsed: { ...parsed, request: guardedRequest },
          plan: await service.plan(guardedRequest),
          outcome: await service.execute(guardedRequest),
        };
      }
      if (name === "agent_control_plan")
        return { plan: await service.plan(request) };
      if (name === "agent_control_execute")
        return { outcome: await service.execute(request) };
      throw new Error(`Unknown control tool: ${name}`);
    },
  };
}
