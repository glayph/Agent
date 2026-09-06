import { createInjectedServicePlugin } from "../sdk/service.js";

export const guardrailsPlugin = createInjectedServicePlugin({
  manifest: {
    id: "guardrails.core",
    displayName: "Agent Guardrails",
    version: "1.0.0",
    capabilities: ["guardrail"],
    runtimeStatus: "functional",
    description:
      "Deterministic safety, approvals, secret scanning, safe mode, and policy decisions.",
    configKey: "guardrails",
    requiredConfig: [],
    secretFields: [],
    permissions: [],
    platform: ["any"],
  },
  serviceId: "guardrails",
});
