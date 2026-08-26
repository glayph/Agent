/**
 * Backward-compatible export for existing imports. Provider ownership and
 * registration live under packages/core/src/llm/provider/Plug-in.
 */
export {
  builtinProviderPlugins,
  geminiProviderPlugin,
  llamaCppProviderPlugin,
} from "../Plug-in/index.js";
