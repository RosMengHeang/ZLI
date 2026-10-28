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

/** An emulated device screen. Width and height are CSS pixels; the native view is scaled down to fit its pane. */
export const BrowserViewport = z.object({
  preset: z.string().max(40).optional(),
  width: z.number().int().min(200).max(4000),
  height: z.number().int().min(200).max(4000),
  deviceScaleFactor: z.number().min(1).max(4).optional(),
  mobile: z.boolean(),
});
export type BrowserViewport = z.infer<typeof BrowserViewport>;

export type BrowserDevicePreset = {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly mobile: boolean;
  /** The value to pass to setViewport for this preset. */
  readonly viewport: BrowserViewport;
};

function devicePreset(
  id: string,
  label: string,
  width: number,
  height: number,
  deviceScaleFactor: number,
  mobile: boolean,
): BrowserDevicePreset {
  return {
    id,
    label,
    width,
    height,
    deviceScaleFactor,
    mobile,
    viewport: Object.freeze({ preset: id, width, height, deviceScaleFactor, mobile }),
  };
}

export const BROWSER_DEVICE_PRESETS: readonly BrowserDevicePreset[] = [
  devicePreset("iphone-15", "iPhone 15", 393, 852, 3, true),
  devicePreset("pixel-8", "Pixel 8", 412, 915, 2.625, true),
  devicePreset("ipad-air", "iPad Air", 820, 1180, 2, true),
  devicePreset("laptop", "Laptop", 1280, 800, 1, false),
  devicePreset("desktop", "Desktop", 1920, 1080, 1, false),
];

export function browserViewportForPreset(presetId: string): BrowserViewport | undefined {
  const preset = BROWSER_DEVICE_PRESETS.find((candidate) => candidate.id === presetId);
  return preset ? { ...preset.viewport } : undefined;
}

/** `null` clears emulation and lets the page fill its pane again. */
export const BrowserSetViewportInput = BrowserTabIdInput.extend({ viewport: BrowserViewport.nullable() });
export type BrowserSetViewportInput = z.infer<typeof BrowserSetViewportInput>;

/** A rectangle in page coordinates, which stay put when the page scrolls. */
export const BrowserDesignRect = z.object({
  x: z.number().min(-100_000).max(1_000_000),
  y: z.number().min(-100_000).max(1_000_000),
  width: z.number().positive().max(100_000),
  height: z.number().positive().max(100_000),
});
export type BrowserDesignRect = z.infer<typeof BrowserDesignRect>;

/** A mark drawn on an annotated region. Pen strokes list x,y pairs; shapes list two corners. */
export const BrowserDesignStroke = z.object({
  tool: z.enum(["pen", "rect", "ellipse"]),
  points: z.array(z.number().min(-100_000).max(1_000_000)).max(2_000),
});
export type BrowserDesignStroke = z.infer<typeof BrowserDesignStroke>;
const BrowserDesignStrokes = z.array(BrowserDesignStroke).max(200);

/** A numbered marker the page draws for an annotation the Browser panel holds. */
export const BrowserDesignMark = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("element"),
    id: z.string().min(1).max(100),
    n: z.number().int().min(1).max(99),
    selector: z.string().min(1).max(2_000),
  }),
  z.object({
    kind: z.literal("region"),
    id: z.string().min(1).max(100),
    n: z.number().int().min(1).max(99),
    bounds: BrowserDesignRect,
    strokes: BrowserDesignStrokes,
  }),
]);
export type BrowserDesignMark = z.infer<typeof BrowserDesignMark>;

export const BrowserDesignMarkInput = BrowserTabIdInput.extend({ marks: z.array(BrowserDesignMark).max(20) });
export type BrowserDesignMarkInput = z.infer<typeof BrowserDesignMarkInput>;

export const BrowserDesignCaptureInput = BrowserTabIdInput.extend({
  bounds: BrowserDesignRect,
  strokes: BrowserDesignStrokes,
});
export type BrowserDesignCaptureInput = z.infer<typeof BrowserDesignCaptureInput>;

/** A live text or style change shown on the page only; `null` puts the element back. */
export const BrowserDesignPreviewInput = BrowserSelectorInput.extend({
  preview: z
    .object({
      text: z.string().max(10_000).optional(),
      styles: z.record(z.string().max(40), z.string().max(200)).optional(),
    })
    .nullable(),
});
export type BrowserDesignPreviewInput = z.infer<typeof BrowserDesignPreviewInput>;

/** Sent to the renderer when an agent opens a tab so the Browser panel can show it. */
export const BrowserRevealEvent = z.object({ browserTabId: BrowserTabId, worktreeId: WorktreeId });
export type BrowserRevealEvent = z.infer<typeof BrowserRevealEvent>;

export const BrowserTabProjection = z.object({
  browserTabId: BrowserTabId,
  profileId: BrowserProfileId,
  worktreeId: WorktreeId,
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
  status: z.enum(["idle", "loading", "crashed"]),
  loadError: z.string().max(512).optional(),
  viewport: BrowserViewport.optional(),
});
export type BrowserTabProjection = z.infer<typeof BrowserTabProjection>;

/** The ZLI browser control service that agents reach through the zli-browser tool. */
export const BROWSER_CONTROL_ACTIONS = [
  "ping",
  "tabs",
  "open",
  "navigate",
  "back",
  "forward",
  "reload",
  "close",
  "snapshot",
  "click",
  "fill",
  "press",
  "wait",
  "evaluate",
  "console",
  "network",
  "screenshot",
  "viewport",
] as const;
export const BrowserControlAction = z.enum(BROWSER_CONTROL_ACTIONS);
export type BrowserControlAction = z.infer<typeof BrowserControlAction>;

/** Written by the desktop app so the tool can find the service; rewritten on every launch. */
export const BrowserControlEndpoint = z.object({
  version: z.literal(1),
  port: z.number().int().min(1).max(65_535),
  token: z.string().regex(/^[0-9a-f]{64}$/u),
  pid: z.number().int().positive(),
});
export type BrowserControlEndpoint = z.infer<typeof BrowserControlEndpoint>;

/**
 * Picks the worktree and tab. \`worktreeId\` is explicit, \`defaultWorktreeId\` comes from the agent's
 * environment, and \`cwd\` is matched against worktree paths when neither names a ready worktree.
 */
export const BrowserControlTarget = z.object({
  worktreeId: z.string().max(100).optional(),
  defaultWorktreeId: z.string().max(100).optional(),
  cwd: z.string().max(4_096).optional(),
  browserTabId: z.string().max(100).optional(),
});
export type BrowserControlTarget = z.infer<typeof BrowserControlTarget>;

const ControlUrl = z.string().min(1).max(8_192);
const ControlSelector = z.string().min(1).max(2_000);

export const BrowserControlOpenInput = BrowserControlTarget.extend({ url: ControlUrl, newTab: z.boolean().optional() });
export type BrowserControlOpenInput = z.infer<typeof BrowserControlOpenInput>;

export const BrowserControlNavigateInput = BrowserControlTarget.extend({ url: ControlUrl });
export type BrowserControlNavigateInput = z.infer<typeof BrowserControlNavigateInput>;

export const BrowserControlReloadInput = BrowserControlTarget.extend({ hard: z.boolean().optional() });
export type BrowserControlReloadInput = z.infer<typeof BrowserControlReloadInput>;

export const BrowserControlClickInput = BrowserControlTarget.extend({
  selector: ControlSelector.optional(),
  text: z.string().min(1).max(500).optional(),
  x: z.number().min(0).max(100_000).optional(),
  y: z.number().min(0).max(100_000).optional(),
}).refine(
  (input) =>
    [input.selector !== undefined, input.text !== undefined, input.x !== undefined || input.y !== undefined].filter(
      Boolean,
    ).length === 1 && (input.x === undefined) === (input.y === undefined),
  { message: "Pass exactly one of selector, text, or both x and y." },
);
export type BrowserControlClickInput = z.infer<typeof BrowserControlClickInput>;

export const BrowserControlFillInput = BrowserControlTarget.extend({
  selector: ControlSelector,
  value: z.string().max(100_000),
});
export type BrowserControlFillInput = z.infer<typeof BrowserControlFillInput>;

export const BrowserControlPressInput = BrowserControlTarget.extend({ key: z.string().min(1).max(32) });
export type BrowserControlPressInput = z.infer<typeof BrowserControlPressInput>;

export const BrowserControlWaitInput = BrowserControlTarget.extend({
  selector: ControlSelector.optional(),
  idleMs: z.number().int().min(0).max(10_000).optional(),
  timeoutMs: z.number().int().min(1).max(120_000).optional(),
});
export type BrowserControlWaitInput = z.infer<typeof BrowserControlWaitInput>;

export const BrowserControlEvaluateInput = BrowserControlTarget.extend({
  expression: z.string().min(1).max(100_000),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
});
export type BrowserControlEvaluateInput = z.infer<typeof BrowserControlEvaluateInput>;

export const BrowserControlConsoleInput = BrowserControlTarget.extend({ clear: z.boolean().optional() });
export type BrowserControlConsoleInput = z.infer<typeof BrowserControlConsoleInput>;

export const BrowserControlScreenshotInput = BrowserControlTarget.extend({
  fullPage: z.boolean().optional(),
  format: z.enum(["png", "jpeg"]).optional(),
});
export type BrowserControlScreenshotInput = z.infer<typeof BrowserControlScreenshotInput>;

export const BrowserControlViewportInput = BrowserControlTarget.extend({
  preset: z.string().min(1).max(40).optional(),
  width: BrowserViewport.shape.width.optional(),
  height: BrowserViewport.shape.height.optional(),
  mobile: z.boolean().optional(),
  deviceScaleFactor: z.number().min(1).max(4).optional(),
  reset: z.boolean().optional(),
});
export type BrowserControlViewportInput = z.infer<typeof BrowserControlViewportInput>;
