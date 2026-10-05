/**
 * Public package entrypoint for @miki/core.
 *
 * Runtime consumers use the explicit subpath exports (engine, control,
 * skills, file-manager, and paths). This module intentionally has no startup
 * side effects; it exists to satisfy the package's declared main/export path.
 */
export {};
export * from "../messaging-adaptive.js";
