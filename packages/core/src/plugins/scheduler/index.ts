import { createInjectedServicePlugin } from "../sdk/service.js";

export const schedulerPlugin = createInjectedServicePlugin({
  manifest: {
    id: "scheduler.core",
    displayName: "Task Scheduler",
    version: "1.0.0",
    capabilities: ["scheduler"],
    runtimeStatus: "functional",
    description:
      "Persistent scheduled tasks, queues, retries, concurrency limits, and recovery.",
    configKey: "scheduler",
    requiredConfig: [],
    secretFields: [],
    permissions: ["filesystem-write"],
    platform: ["any"],
  },
  serviceId: "scheduler",
});
