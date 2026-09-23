import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
const statePath = path.join(root, "data", "launcher-state.json");
const modelPath = "/home/ubuntu/.local/share/miki/miki/models/LFM2.5-1.2B-Instruct-Q4_0.gguf";
const executablePath = path.join(
  root,
  "packages",
  "core",
  "dist",
  "llm",
  "local",
  "native",
  "linux-x64",
  "llama-server",
);
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const existing = Array.isArray(state.models) ? state.models : [];
const cloudModels = existing
  .filter((model) => !String(model?.provider || "").toLowerCase().includes("llama"))
  .map((model) => ({ ...model, is_default: false }));
const localModel = {
  model_name: "lfm2.5-local-1.2b",
  provider: "llama.cpp",
  model: "lfm2.5-1.2b-instruct-q4_0",
  api_base: "http://127.0.0.1:39200/v1",
  auth_method: "none",
  enabled: true,
  is_default: true,
  local: {
    runtime: "llama.cpp",
    model_path: modelPath,
    model_format: "gguf",
    display_name: "LFM2.5 1.2B Instruct Q4_0",
    context_size: 32768,
    gpu_layers: "auto",
    enabled: true,
    auto_start: true,
    executable_path: executablePath,
    port: 39200,
    allowed_model_dirs: [path.dirname(modelPath)],
  },
};
state.models = [...cloudModels, localModel];
if (state.settings?.model_routing) {
  state.settings.model_routing.local_model = localModel.model_name;
  state.settings.model_routing.simple_model = localModel.model_name;
}
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
console.log(`Configured ${localModel.model_name} as the default local model.`);
console.log(`State: ${statePath}`);
console.log(`Model: ${modelPath}`);
