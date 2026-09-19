import { createInjectedServicePlugin } from "../sdk/service.js";

export const workflowPlugin = createInjectedServicePlugin({
  manifest: {
    id: "workflow.project",
    displayName: "Project Workflow",
    version: "1.0.0",
    capabilities: ["workflow"],
    runtimeStatus: "functional",
    description:
      "Project scaffolding, workflow planning, verification, and execution services.",
    configKey: "workflow",
    requiredConfig: [],
    secretFields: [],
    permissions: ["filesystem-read", "filesystem-write", "shell"],
    platform: ["win32", "linux", "darwin"],
  },
  serviceId: "workflow",
});
