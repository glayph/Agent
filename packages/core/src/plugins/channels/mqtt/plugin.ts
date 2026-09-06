import type { AgentOrchestrator } from "../../../agent.js";
import { channelManifest, type BuiltinChannelPlugin } from "../sdk/index.js";
import { channelFieldValue, isValidUrlLike } from "../_shared/probe.js";
import { MqttBot } from "./index.js";

export const mqttChannelPlugin: BuiltinChannelPlugin = {
  manifest: channelManifest({
    name: "mqtt",
    display_name: "MQTT",
    config_key: "mqtt",
    runtime_status: "functional",
    runtime_note:
      "Node MQTT 3.1.1 adapter supports broker auth, request/response topics, QoS 0/1 packets, keepalive, and reconnect.",
    required_fields: ["broker", "agent_id"],
    secret_fields: ["username", "password"],
    env_fields: {
      broker: "MQTT_BROKER",
      agent_id: "MQTT_AGENT_ID",
      username: "MQTT_USERNAME",
      password: "MQTT_PASSWORD",
    },
    probe_config: (config) => [
      {
        id: "broker_url_shape",
        status: isValidUrlLike(channelFieldValue(config, "broker"), [
          "mqtt:",
          "mqtts:",
          "ssl:",
          "tcp:",
        ])
          ? "pass"
          : "fail",
        message: "MQTT broker must use mqtt://, mqtts://, ssl://, or tcp://.",
      },
    ],
  }),
  createRuntime: (orchestrator: AgentOrchestrator) => new MqttBot(orchestrator),
};
