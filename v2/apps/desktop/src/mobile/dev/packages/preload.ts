import type { PreloadIpc } from "../preloadIpc.js";

/**
 * Placeholder for the renderer API of F3, the package guard. Stream S2 owns this file and replaces it with
 * methods that call its zli:mobile:packages:* channels and parse every result. This file is part of the preload
 * bundle, so it may import only @zli-v2/contracts and other preload files.
 */
export function createPackagesApi(_ipc: PreloadIpc): Record<never, never> {
  return {};
}
