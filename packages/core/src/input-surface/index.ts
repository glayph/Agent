export type {
  SurfaceId,
  InboundPayload,
  SenderMeta,
  InboundEvent,
  InboundEventInput,
  SurfaceAdapter,
  IngestSink,
} from "./types.js";
export { SURFACES, isSurfaceId } from "./types.js";
export {
  resolveSessionKey,
  parseSessionKey,
  looksLikeSessionKey,
} from "./session-key.js";
export type { SessionKeyParts } from "./session-key.js";
export { normalizeSurface, normalizeInboundEvent } from "./normalize.js";
export {
  createJsonSurfaceAdapter,
  createCliAdapter,
  createWebhookAdapter,
  createDefaultSurfaceAdapters,
  channelToSurface,
} from "./adapters.js";
export {
  SurfaceAdapterRegistry,
  createDefaultSurfaceRegistry,
} from "./registry.js";
export { ingest, normalizeFromSurface } from "./ingest.js";
export type { IngestResult } from "./ingest.js";
