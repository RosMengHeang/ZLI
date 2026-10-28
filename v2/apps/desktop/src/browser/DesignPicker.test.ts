import { describe, expect, it } from "vitest";

import {
  CANCEL_DESIGN_PICKER_SCRIPT,
  DESIGN_PICKER_SCRIPT,
  DESIGN_RELEASE_SCRIPT,
  designCaptureScript,
  designEditableScript,
  designMarkScript,
  designPreviewScript,
  MAX_DESIGN_STROKE_POINTS,
  parseDesignPickResult,
  parseStrokes,
} from "./DesignPicker.js";

describe("design page scripts", () => {
  it("are valid JavaScript", () => {
    for (const script of [
      DESIGN_PICKER_SCRIPT,
      CANCEL_DESIGN_PICKER_SCRIPT,
      DESIGN_RELEASE_SCRIPT,
      designMarkScript([{ kind: "region", id: "r", n: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, strokes: [] }]),
      designCaptureScript(null),
      designEditableScript('a[title="x"]'),
      designPreviewScript("#save", { text: "it's `quoted`", styles: { color: "red" } }),
    ])
      expect(() => new Function(`return ${script};`)).not.toThrow();
  });

  it("embeds selectors and previews as data, not code", () => {
    const script = designPreviewScript('"); alert(1); ("', { text: "</script>" });
    expect(script).toContain(JSON.stringify('"); alert(1); ("'));
  });
});

describe("parseDesignPickResult", () => {
  it("reads clicks and drawn regions and treats anything else as the end of the session", () => {
    expect(parseDesignPickResult({ kind: "element", selector: "#pay" })).toEqual({ kind: "element", selector: "#pay" });
    expect(
      parseDesignPickResult({
        kind: "region",
        id: "region-1",
        bounds: { x: 1.4, y: 2.6, width: 30, height: 40 },
        viewport: { width: 800, height: "tall" },
        strokes: [{ tool: "pen", points: [1, 2] }],
      }),
    ).toEqual({
      kind: "region",
      id: "region-1",
      bounds: { x: 1, y: 3, width: 30, height: 40 },
      viewport: { width: 800, height: 0 },
      strokes: [{ tool: "pen", points: [1, 2] }],
    });
    expect(parseDesignPickResult(null)).toBeNull();
    expect(parseDesignPickResult({ kind: "region", id: "r", bounds: { x: 0, y: 0, width: -1, height: 1 } })).toBeNull();
    expect(parseDesignPickResult({ selector: "" })).toBeNull();
  });
});

describe("parseStrokes", () => {
  it("keeps well-formed strokes within the limits", () => {
    expect(
      parseStrokes([
        { tool: "rect", points: [0, 0, 10, 10, 20, 20] },
        { tool: "ellipse", points: [0, 0] },
        { tool: "pen", points: [0, 0, 1] },
        { tool: "spray", points: [0, 0] },
        { tool: "pen", points: Array.from({ length: MAX_DESIGN_STROKE_POINTS + 10 }, (_, index) => index) },
      ]),
    ).toEqual([
      { tool: "rect", points: [0, 0, 10, 10] },
      { tool: "pen", points: Array.from({ length: MAX_DESIGN_STROKE_POINTS }, (_, index) => index) },
    ]);
    expect(parseStrokes("nope")).toEqual([]);
  });
});
