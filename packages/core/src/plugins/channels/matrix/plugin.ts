import type { AgentOrchestrator } from "../../../agent.js";
import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";
import { channelFieldValue, isValidUrlLike } from "../_shared/probe.js";
import { MatrixBot } from "./index.js";

export const matrixChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "matrix",
    display_name: "Matrix",
    config_key: "matrix",
    runtime_status: "functional",
    runtime_note:
      "Node Matrix sync adapter supports sync polling, outbound room messages, filtering, and retry.",
    required_fields: ["homeserver_url", "user_id", "access_token"],
    secret_fields: ["access_token"],
    env_fields: {
      homeserver_url: "MATRIX_HOMESERVER_URL",
      user_id: "MATRIX_USER_ID",
      access_token: "MATRIX_ACCESS_TOKEN",
    },
    probe_config: (config) => [
      {
        id: "homeserver_url_shape",
        status: isValidUrlLike(channelFieldValue(config, "homeserver_url"), [
          "http:",
          "https:",
        ])
          ? "pass"
          : "fail",
        message: "Matrix homeserver URL must use http:// or https://.",
      },
      {
        id: "user_id_shape",
        status:
          typeof channelFieldValue(config, "user_id") === "string" &&
          /^@[^:\s]+:[^:\s]+$/.test(
            String(channelFieldValue(config, "user_id")).trim(),
          )
            ? "pass"
            : "fail",
        message: "Matrix user ID must look like @user:homeserver.",
      },
    ],
  }),
  createRuntime: (orchestrator: AgentOrchestrator) =>
    new MatrixBot(orchestrator),
};
