import { z } from "zod";

import { WorktreeId } from "./ids.js";

export const OpenInKind = z.enum(["editor", "agent", "terminal", "files"]);
export type OpenInKind = z.infer<typeof OpenInKind>;

/** An app on this computer that can open a worktree folder. */
export const OpenInApp = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(100),
  kind: OpenInKind,
  /** The app's own icon as a PNG data URL, when the system has one. */
  icon: z.string().startsWith("data:image/png;base64,").max(200_000).optional(),
});
export type OpenInApp = z.infer<typeof OpenInApp>;

export const OpenInRequest = z.object({ worktreeId: WorktreeId, appId: z.string().min(1).max(64) });
export type OpenInRequest = z.infer<typeof OpenInRequest>;
