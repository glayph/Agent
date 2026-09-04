import { createInjectedServicePlugin } from "../plugins/sdk/service.js";

export const observabilityPlugin = createInjectedServicePlugin({
  manifest: {
    id: "observability.core",
    displayName: "Observability and Logging",
    version: "1.0.0",
    capabilities: ["observability"],
    runtimeStatus: "functional",
    description:
      "Structured logs, metrics, resource monitoring, run records, and audit exporters.",
    configKey: "observability",
    requiredConfig: [],
    secretFields: [],
    permissions: ["filesystem-write"],
    platform: ["any"],
  },
  serviceId: "observability",
});
