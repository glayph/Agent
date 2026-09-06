import { createInjectedServicePlugin } from "../plugins/sdk/service.js";

export const securityPlugin = createInjectedServicePlugin({
  manifest: {
    id: "security.policy-kernel",
    displayName: "Security and Permissions",
    version: "1.0.0",
    capabilities: ["security"],
    runtimeStatus: "functional",
    description:
      "Approval, session permission, safe-mode, and secret-policy services owned by core.",
    configKey: "security",
    requiredConfig: [],
    secretFields: [],
    permissions: [],
    platform: ["any"],
  },
  serviceId: "securityPolicy",
});
