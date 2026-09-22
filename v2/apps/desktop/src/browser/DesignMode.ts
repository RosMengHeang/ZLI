import type { BrowserAutomation, BrowserInspection, BrowserScreenshot } from "./BrowserAutomation.js";

export type DesignInspection = BrowserInspection & {
  readonly screenshot?: BrowserScreenshot;
};

export class DesignMode {
  constructor(private readonly automation: Pick<BrowserAutomation, "inspectElement" | "screenshot">) {}

  async inspect(input: { selector: string }): Promise<DesignInspection> {
    const element = await this.automation.inspectElement(input);
    const bounds = element.bounds;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return element;
    const screenshot = await this.automation.screenshot({
      clip: {
        x: Math.max(0, bounds.x),
        y: Math.max(0, bounds.y),
        width: Math.min(bounds.width, 2_000),
        height: Math.min(bounds.height, 2_000),
        scale: 1,
      },
    });
    return { ...element, screenshot };
  }
}
