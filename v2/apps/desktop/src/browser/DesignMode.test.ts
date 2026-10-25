import { describe, expect, it } from "vitest";

import type { BrowserAutomation } from "./BrowserAutomation.js";
import { cropFor, DesignMode } from "./DesignMode.js";

describe("DesignMode", () => {
  it("returns a bounded element inspection and a crop for the selected element", async () => {
    const automation = {
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
        expect(options).toMatchObject({ clip: { x: 2, y: 12, width: 96, height: 46 } });
        return { data: "aGVsbG8=", mimeType: "image/png" as const };
      },
    } as unknown as BrowserAutomation;
    const result = await new DesignMode(automation).inspect({ selector: "#save" });
    expect(result).toMatchObject({ tag: "button", name: "Save", selector: "#save", screenshot: { data: "aGVsbG8=" } });
  });

  it("keeps the inspection when the screenshot fails", async () => {
    const automation = {
      inspectElement: async () => ({ tag: "div", name: "", bounds: { x: 0, y: 0, width: 10, height: 10 } }),
      screenshot: async () => {
        throw new Error("Browser screenshot timed out.");
      },
    } as unknown as BrowserAutomation;
    const result = await new DesignMode(automation).inspect({ selector: "div" });
    expect(result).toEqual({ tag: "div", name: "", selector: "div", bounds: { x: 0, y: 0, width: 10, height: 10 } });
  });

  it("passes picks and cancels through to the page", async () => {
    const calls: string[] = [];
    const automation = {
      pickElement: async () => {
        calls.push("pick");
        return { selector: "main > h1" };
      },
      cancelPick: async () => {
        calls.push("cancel");
      },
    } as unknown as BrowserAutomation;
    const design = new DesignMode(automation);
    await expect(design.pick()).resolves.toEqual({ selector: "main > h1" });
    await design.cancelPick();
    expect(calls).toEqual(["pick", "cancel"]);
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
