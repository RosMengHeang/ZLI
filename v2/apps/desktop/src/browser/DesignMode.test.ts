import { describe, expect, it } from "vitest";

import { DesignMode } from "./DesignMode.js";
import type { BrowserAutomation } from "./BrowserAutomation.js";

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
        expect(options).toMatchObject({ clip: { x: 10, y: 20, width: 80, height: 30 } });
        return { data: "aGVsbG8=", mimeType: "image/png" as const };
      },
    } as unknown as BrowserAutomation;
    const result = await new DesignMode(automation).inspect({ selector: "#save" });
    expect(result).toMatchObject({ tag: "button", name: "Save", screenshot: { data: "aGVsbG8=" } });
  });
});
