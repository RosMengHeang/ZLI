import type { BrowserAutomation, BrowserInspection, BrowserScreenshot } from "./BrowserAutomation.js";

export type DesignInspection = BrowserInspection & {
  readonly selector: string;
  readonly screenshot?: BrowserScreenshot;
};

const MAX_CROP = 2_000;
/** A little of the surroundings shows where the element sits on the page. */
const CROP_MARGIN = 8;

export class DesignMode {
  constructor(
    private readonly automation: Pick<
      BrowserAutomation,
      "inspectElement" | "screenshot" | "pickElement" | "cancelPick"
    >,
  ) {}

  pick(): Promise<{ selector: string } | null> {
    return this.automation.pickElement();
  }

  cancelPick(): Promise<void> {
    return this.automation.cancelPick();
  }

  async inspect(input: { selector: string }): Promise<DesignInspection> {
    const element = { ...(await this.automation.inspectElement(input)), selector: input.selector };
    const clip = cropFor(element);
    if (!clip) return element;
    const screenshot = await this.automation.screenshot({ clip }).catch(() => undefined);
    return screenshot ? { ...element, screenshot } : element;
  }
}

/**
 * The visible part of the element in page coordinates, which is what Page.captureScreenshot
 * clips by; bounds from getBoundingClientRect are relative to the viewport.
 */
export function cropFor(
  element: Pick<BrowserInspection, "bounds" | "viewport">,
): { x: number; y: number; width: number; height: number; scale: number } | undefined {
  const bounds = element.bounds;
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return undefined;
  const viewport = element.viewport;
  const right = viewport ? viewport.width : Number.POSITIVE_INFINITY;
  const bottom = viewport ? viewport.height : Number.POSITIVE_INFINITY;
  const left = Math.max(0, bounds.x - CROP_MARGIN);
  const top = Math.max(0, bounds.y - CROP_MARGIN);
  const width = Math.min(bounds.x + bounds.width + CROP_MARGIN, right) - left;
  const height = Math.min(bounds.y + bounds.height + CROP_MARGIN, bottom) - top;
  if (width <= 0 || height <= 0) return undefined;
  return {
    x: left + (viewport?.pageX ?? 0),
    y: top + (viewport?.pageY ?? 0),
    width: Math.min(width, MAX_CROP),
    height: Math.min(height, MAX_CROP),
    scale: 1,
  };
}
