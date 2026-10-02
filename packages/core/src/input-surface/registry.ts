import { createDefaultSurfaceAdapters } from "./adapters.js";
import type {
  InboundEvent,
  SurfaceAdapter,
  SurfaceId,
} from "./types.js";

/**
 * Registry of surface adapters. Adding a new input surface only requires
 * registering a new adapter — no core agent logic changes.
 */
export class SurfaceAdapterRegistry {
  private readonly adapters = new Map<SurfaceId, SurfaceAdapter>();

  register(adapter: SurfaceAdapter): void {
    this.adapters.set(adapter.surface, adapter);
  }

  has(surface: string): surface is SurfaceId {
    return this.adapters.has(surface as SurfaceId);
  }

  get(surface: string): SurfaceAdapter | undefined {
    return this.adapters.get(surface as SurfaceId);
  }

  normalize(
    surface: string,
    raw: unknown,
    context?: { senderId?: string },
  ): InboundEvent {
    const key = surface.trim().toLowerCase() as SurfaceId;
    const adapter = this.adapters.get(key);
    if (!adapter) {
      throw new Error(`Unsupported surface: ${surface}`);
    }
    return adapter.normalize(raw, context);
  }

  list(): SurfaceId[] {
    return [...this.adapters.keys()];
  }
}

export function createDefaultSurfaceRegistry(): SurfaceAdapterRegistry {
  const registry = new SurfaceAdapterRegistry();
  for (const adapter of createDefaultSurfaceAdapters()) {
    registry.register(adapter);
  }
  return registry;
}
