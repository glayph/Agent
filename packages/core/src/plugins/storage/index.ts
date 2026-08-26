import { createInjectedServicePlugin } from "../sdk/service.js";

export const storagePlugin = createInjectedServicePlugin({
  manifest: {
    id: "storage.core",
    displayName: "Core Storage",
    version: "1.0.0",
    capabilities: ["storage"],
    runtimeStatus: "functional",
    description:
      "Workspace filesystem and SQLite-backed persistence services managed by core policy.",
    configKey: "storage",
    requiredConfig: [],
    secretFields: [],
    permissions: ["filesystem-read", "filesystem-write"],
    platform: ["win32", "linux", "darwin"],
  },
  serviceId: "storage",
});
