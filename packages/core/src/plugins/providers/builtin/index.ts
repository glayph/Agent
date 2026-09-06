import { geminiProviderPlugin } from "./gemini/index.js";
import { llamaCppProviderPlugin } from "./llama-cpp/index.js";
import type { MikiProviderPlugin } from "../../../llm/provider/sdk/index.js";

/**
 * Provider ownership lives below this directory. This index is the only
 * built-in registration list; shared runtime code consumes the plugin SDK.
 */
export { geminiProviderPlugin } from "./gemini/index.js";
export { llamaCppProviderPlugin } from "./llama-cpp/index.js";

export const builtinProviderPlugins: MikiProviderPlugin[] = [
  geminiProviderPlugin,
  llamaCppProviderPlugin,
];
