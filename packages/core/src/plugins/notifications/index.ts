import { createInjectedServicePlugin } from "../sdk/service.js";

export const notificationsPlugin = createInjectedServicePlugin({
  manifest: {
    id: "notifications.core",
    displayName: "Notifications",
    version: "1.0.0",
    capabilities: ["notification"],
    runtimeStatus: "functional",
    description: "Audited alert and outbound notification delivery sinks.",
    configKey: "notifications",
    requiredConfig: [],
    secretFields: ["webhook_urls", "tokens"],
    permissions: ["network", "secrets"],
    platform: ["any"],
  },
  serviceId: "notifications",
});
