/**
 * @deprecated Compatibility facade.
 *
 * Provider implementation now lives under `core/llm/provider`. Existing core
 * and launcher imports remain valid while new code uses the isolated boundary.
 */
export * from "../llm/provider/catalog.js";
