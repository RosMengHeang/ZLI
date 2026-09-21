import { z } from "zod";

import { BrowserProfileId, BrowserTabId, WorktreeId } from "./ids.js";

export const BrowserBounds = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type BrowserBounds = z.infer<typeof BrowserBounds>;

export const BrowserTabCreateInput = z.object({
  browserTabId: BrowserTabId.optional(),
  worktreeId: WorktreeId,
  profileId: BrowserProfileId,
  url: z.string().url(),
  bounds: BrowserBounds.optional(),
});
export type BrowserTabCreateInput = z.infer<typeof BrowserTabCreateInput>;

export const BrowserTabIdInput = z.object({ browserTabId: BrowserTabId });
export type BrowserTabIdInput = z.infer<typeof BrowserTabIdInput>;

export const BrowserNavigateInput = BrowserTabIdInput.extend({ url: z.string().url() });
export type BrowserNavigateInput = z.infer<typeof BrowserNavigateInput>;

export const BrowserSetBoundsInput = BrowserTabIdInput.extend({ bounds: BrowserBounds });
export type BrowserSetBoundsInput = z.infer<typeof BrowserSetBoundsInput>;

export const BrowserSelectorInput = BrowserTabIdInput.extend({ selector: z.string().min(1).max(2_000) });
export type BrowserSelectorInput = z.infer<typeof BrowserSelectorInput>;

export const BrowserFillInput = BrowserSelectorInput.extend({ value: z.string().max(100_000) });
export type BrowserFillInput = z.infer<typeof BrowserFillInput>;

export const BrowserPressInput = BrowserTabIdInput.extend({ key: z.string().min(1).max(32) });
export type BrowserPressInput = z.infer<typeof BrowserPressInput>;

export const BrowserWaitForNetworkIdleInput = BrowserTabIdInput.extend({
  idleMs: z.number().int().nonnegative().max(10_000).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});
export type BrowserWaitForNetworkIdleInput = z.infer<typeof BrowserWaitForNetworkIdleInput>;

export const BrowserScreenshotInput = BrowserTabIdInput.extend({ format: z.enum(["png", "jpeg"]).optional() });
export type BrowserScreenshotInput = z.infer<typeof BrowserScreenshotInput>;

export const BrowserReloadInput = BrowserTabIdInput.extend({ hard: z.boolean().default(false) });
export type BrowserReloadInput = z.infer<typeof BrowserReloadInput>;

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
