import type { PreloadIpc } from "../preloadIpc.js";

/**
 * Placeholder for the renderer API of F1, per-worktree Metro port and device isolation. Stream S1 owns this file and replaces it with
 * methods that call its zli:mobile:workspace:* channels and parse every result. This file is part of the preload
 * bundle, so it may import only @zli-v2/contracts and other preload files.
 */
export function createWorkspaceApi(_ipc: PreloadIpc): Record<never, never> {
  return {};
}
