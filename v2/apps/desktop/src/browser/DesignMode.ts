import type { BrowserAutomation, BrowserInspection, BrowserScreenshot } from "./BrowserAutomation.js";
import {
  DESIGN_RELEASE_SCRIPT,
  type DesignMark,
  type DesignPickResult,
  type DesignPreview,
  type DesignRect,
  type DesignStroke,
  designCaptureScript,
  designEditableScript,
  designMarkScript,
  designPreviewScript,
} from "./DesignPicker.js";

/** The element's text, when it holds only text, and current values of the styles the preview can change. */
export type DesignEditable = { readonly text: string | null; readonly styles: Record<string, string> };

export type DesignInspection = BrowserInspection & {
  readonly selector: string;
  readonly screenshot?: BrowserScreenshot;
  readonly editable?: DesignEditable;
};

const MAX_CROP = 2_000;
/** A little of the surroundings shows where the element sits on the page. */
const CROP_MARGIN = 8;

export class DesignMode {
  constructor(
    private readonly automation: Pick<
      BrowserAutomation,
      "inspectElement" | "screenshot" | "pickElement" | "cancelPick" | "evaluate"
    >,
  ) {}

  pick(): Promise<DesignPickResult | null> {
    return this.automation.pickElement();
  }

  /** Ends the annotate session: the pending pick resolves null and the overlay and previews go away. */
  cancelPick(): Promise<void> {
    return this.automation.cancelPick();
  }

  async mark(marks: readonly DesignMark[]): Promise<void> {
    await this.automation.evaluate(designMarkScript(marks));
  }

  async inspect(input: { selector: string }): Promise<DesignInspection> {
    const element = { ...(await this.automation.inspectElement(input)), selector: input.selector };
    const editable = await this.#editable(input.selector);
    const withEditable = editable ? { ...element, editable } : element;
    const clip = cropFor(element);
    if (!clip) return withEditable;
    const screenshot = await this.#capture(null, clip);
    return screenshot ? { ...withEditable, screenshot } : withEditable;
  }

  /** The page under a drawn region with its sketch on top, cropped to the region. */
  captureRegion(region: { bounds: DesignRect; strokes: DesignStroke[] }): Promise<BrowserScreenshot | undefined> {
    const width = Math.min(region.bounds.width, MAX_CROP);
    const height = Math.min(region.bounds.height, MAX_CROP);
    if (width <= 0 || height <= 0) return Promise.resolve(undefined);
    return this.#capture(region, {
      x: Math.max(0, region.bounds.x),
      y: Math.max(0, region.bounds.y),
      width,
      height,
      scale: 1,
    });
  }

  async preview(input: { selector: string; preview: DesignPreview }): Promise<boolean> {
    const result = await this.automation.evaluate(designPreviewScript(input.selector, input.preview));
    return result.value === true;
  }

  async #editable(selector: string): Promise<DesignEditable | undefined> {
    const result = await this.automation.evaluate(designEditableScript(selector)).catch(() => undefined);
    const value = result?.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const styles: Record<string, string> = {};
    if (typeof record.styles === "object" && record.styles !== null)
      for (const [key, style] of Object.entries(record.styles)) if (typeof style === "string") styles[key] = style;
    return { text: typeof record.text === "string" ? record.text.slice(0, 2_000) : null, styles };
  }

  /** The overlay is part of the page, so it is hidden while the screenshot is taken. */
  async #capture(
    region: { bounds: DesignRect; strokes: DesignStroke[] } | null,
    clip: { x: number; y: number; width: number; height: number; scale: number },
  ): Promise<BrowserScreenshot | undefined> {
    await this.automation.evaluate(designCaptureScript(region)).catch(() => undefined);
    try {
      return await this.automation.screenshot({ clip }).catch(() => undefined);
    } finally {
      await this.automation.evaluate(DESIGN_RELEASE_SCRIPT).catch(() => undefined);
    }
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
