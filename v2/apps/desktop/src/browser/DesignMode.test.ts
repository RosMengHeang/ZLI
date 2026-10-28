import { describe, expect, it } from "vitest";

import type { BrowserAutomation } from "./BrowserAutomation.js";
import { cropFor, DesignMode } from "./DesignMode.js";

function automationWith(overrides: Record<string, unknown>) {
  const scripts: string[] = [];
  const automation = {
    evaluate: async (expression: string) => {
      scripts.push(expression);
      if (expression.includes(".editable("))
        return { type: "object", value: { text: "Save", styles: { color: "red", padding: 4 } } };
      if (expression.includes(".preview(")) return { type: "boolean", value: true };
      return { type: "boolean", value: true };
    },
    ...overrides,
  } as unknown as BrowserAutomation;
  return { automation, scripts };
}

describe("DesignMode", () => {
  it("returns a bounded element inspection, its editable values, and a crop with the overlay hidden", async () => {
    const order: string[] = [];
    const { automation, scripts } = automationWith({
      inspectElement: async () => ({
        tag: "button",
        name: "Save",
        text: "Save",
        attributes: { class: "primary" },
        styles: { color: "red" },
        ancestry: ["main"],
        bounds: { x: 10, y: 20, width: 80, height: 30 },
        url: "https://example.com",
      }),
      screenshot: async (options: unknown) => {
        order.push(`screenshot after ${scripts.at(-1)?.includes(".capture(null)") ? "capture" : "other"}`);
        expect(options).toMatchObject({ clip: { x: 2, y: 12, width: 96, height: 46 } });
        return { data: "aGVsbG8=", mimeType: "image/png" as const };
      },
    });
    const result = await new DesignMode(automation).inspect({ selector: "#save" });
    expect(result).toMatchObject({
      tag: "button",
      name: "Save",
      selector: "#save",
      screenshot: { data: "aGVsbG8=" },
      editable: { text: "Save", styles: { color: "red" } },
    });
    expect(order).toEqual(["screenshot after capture"]);
    expect(scripts.at(-1)).toContain("release()");
  });

  it("keeps the inspection when the screenshot fails and still restores the overlay", async () => {
    const { automation, scripts } = automationWith({
      inspectElement: async () => ({ tag: "div", name: "", bounds: { x: 0, y: 0, width: 10, height: 10 } }),
      screenshot: async () => {
        throw new Error("Browser screenshot timed out.");
      },
      evaluate: async (expression: string) => {
        scripts.push(expression);
        return { type: "object", value: null };
      },
    });
    const result = await new DesignMode(automation).inspect({ selector: "div" });
    expect(result).toEqual({ tag: "div", name: "", selector: "div", bounds: { x: 0, y: 0, width: 10, height: 10 } });
    expect(scripts.at(-1)).toContain("release()");
  });

  it("passes picks, marks, previews, and the end of the session through to the page", async () => {
    const calls: string[] = [];
    const { automation, scripts } = automationWith({
      pickElement: async () => {
        calls.push("pick");
        return { kind: "element", selector: "main > h1" };
      },
      cancelPick: async () => {
        calls.push("cancel");
      },
    });
    const design = new DesignMode(automation);
    await expect(design.pick()).resolves.toEqual({ kind: "element", selector: "main > h1" });
    await design.mark([{ kind: "element", id: "a", n: 1, selector: "main > h1" }]);
    expect(scripts.at(-1)).toContain('"selector":"main > h1"');
    await expect(design.preview({ selector: "#save", preview: { styles: { color: "green" } } })).resolves.toBe(true);
    expect(scripts.at(-1)).toContain('"color":"green"');
    await design.cancelPick();
    expect(calls).toEqual(["pick", "cancel"]);
  });

  it("captures a drawn region with its sketch showing", async () => {
    const { automation, scripts } = automationWith({
      screenshot: async (options: unknown) => {
        expect(scripts.at(-1)).toContain('"strokes":[{"tool":"pen","points":[1,2,3,4]}]');
        expect(options).toEqual({ clip: { x: 100, y: 0, width: 2_000, height: 50, scale: 1 } });
        return { data: "cmVnaW9u", mimeType: "image/png" as const };
      },
    });
    const screenshot = await new DesignMode(automation).captureRegion({
      bounds: { x: 100, y: -5, width: 5_000, height: 50 },
      strokes: [{ tool: "pen", points: [1, 2, 3, 4] }],
    });
    expect(screenshot).toEqual({ data: "cmVnaW9u", mimeType: "image/png" });
    expect(scripts.at(-1)).toContain("release()");
  });
});

describe("cropFor", () => {
  it("crops to the visible part of the element in page coordinates", () => {
    expect(
      cropFor({
        bounds: { x: 100, y: -40, width: 300, height: 100 },
        viewport: { width: 350, height: 600, pageX: 0, pageY: 500 },
      }),
    ).toEqual({ x: 92, y: 500, width: 258, height: 68, scale: 1 });
  });

  it("skips elements that are off screen or have no size", () => {
    expect(
      cropFor({
        bounds: { x: 0, y: 700, width: 10, height: 10 },
        viewport: { width: 800, height: 600, pageX: 0, pageY: 0 },
      }),
    ).toBeUndefined();
    expect(cropFor({ bounds: { x: 0, y: 0, width: 0, height: 10 } })).toBeUndefined();
  });
});
