import { createInjectedServicePlugin } from "../sdk/service.js";

export const integrationsPlugin = createInjectedServicePlugin({
  manifest: {
    id: "integrations.platform",
    displayName: "Platform Integrations",
    version: "1.0.0",
    capabilities: ["integration"],
    runtimeStatus: "functional",
    description:
      "Authenticated platform connections and integration lifecycle management.",
    configKey: "integrations",
    requiredConfig: [],
    secretFields: ["tokens", "credentials"],
    permissions: ["network", "secrets"],
    platform: ["any"],
  },
  serviceId: "platformConnections",
});
