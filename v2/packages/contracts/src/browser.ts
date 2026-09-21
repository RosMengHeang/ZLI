import { z } from "zod";

import { BrowserProfileId, BrowserTabId, WorktreeId } from "./ids.js";

export const BrowserTabProjection = z.object({
  browserTabId: BrowserTabId,
  profileId: BrowserProfileId,
  worktreeId: WorktreeId,
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
  status: z.enum(["idle", "loading", "crashed"]),
});
export type BrowserTabProjection = z.infer<typeof BrowserTabProjection>;
