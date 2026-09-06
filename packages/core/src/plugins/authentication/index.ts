import { createInjectedServicePlugin } from "../sdk/service.js";

export const authenticationPlugin = createInjectedServicePlugin({
  manifest: {
    id: "authentication.core",
    displayName: "Agent Authentication",
    version: "1.0.0",
    capabilities: ["authentication"],
    runtimeStatus: "functional",
    description:
      "API-key and dashboard session authentication with vault-backed secret handling.",
    configKey: "authentication",
    requiredConfig: [],
    secretFields: ["api_key", "password", "session_secret"],
    permissions: ["secrets"],
    platform: ["any"],
  },
  serviceId: "authentication",
});
