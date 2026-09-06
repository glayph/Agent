/**
 * Backward-compatible export for existing imports. Provider ownership and
 * registration live under packages/core/src/plugins/providers/builtin.
 */
export {
  builtinProviderPlugins,
  geminiProviderPlugin,
  llamaCppProviderPlugin,
} from "../../../plugins/providers/builtin/index.js";
