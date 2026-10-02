/**
 * Single entry-point for all input surfaces.
 * Adapters never call the agent core; they only produce InboundEvent.
 * ingest() normalizes then hands off to an optional sink (Step 07 queue).
 */

import { createDefaultSurfaceRegistry, type SurfaceAdapterRegistry } from "./registry.js";
import type { InboundEvent, IngestSink } from "./types.js";

let defaultRegistry: SurfaceAdapterRegistry | null = null;

function getRegistry(registry?: SurfaceAdapterRegistry): SurfaceAdapterRegistry {
  if (registry) return registry;
  if (!defaultRegistry) defaultRegistry = createDefaultSurfaceRegistry();
  return defaultRegistry;
}

export interface IngestResult {
  event: InboundEvent;
  /** True when a sink was invoked (async sink may still be in flight). */
  delivered: boolean;
}

/**
 * Normalize a raw event from any surface and optionally deliver to a sink.
 * Core agent is never invoked from here — only the sink (queue) may enqueue work.
 */
export async function ingest(
  raw: unknown,
  surfaceId: string,
  options?: {
    registry?: SurfaceAdapterRegistry;
    sink?: IngestSink;
    senderId?: string;
  },
): Promise<IngestResult> {
  const registry = getRegistry(options?.registry);
  const event = registry.normalize(surfaceId, raw, {
    senderId: options?.senderId,
  });

  let delivered = false;
  if (options?.sink) {
    await options.sink(event);
    delivered = true;
  }

  return { event, delivered };
}

/**
 * Synchronous normalize-only path (no sink). Prefer ingest() when a sink exists.
 */
export function normalizeFromSurface(
  raw: unknown,
  surfaceId: string,
  options?: { registry?: SurfaceAdapterRegistry; senderId?: string },
): InboundEvent {
  return getRegistry(options?.registry).normalize(surfaceId, raw, {
    senderId: options?.senderId,
  });
}
