import type { PreloadIpc } from "../preloadIpc.js";

/**
 * Placeholder for the renderer API of F2, the mobile doctor and the AGENTS.md block. Stream S2 owns this file and replaces it with
 * methods that call its zli:mobile:doctor:* channels and parse every result. This file is part of the preload
 * bundle, so it may import only @zli-v2/contracts and other preload files.
 */
export function createDoctorApi(_ipc: PreloadIpc): Record<never, never> {
  return {};
}
