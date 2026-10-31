import { describe, expect, it } from "vitest";

import {
  CANCEL_DESIGN_PICKER_SCRIPT,
  DESIGN_PICKER_SCRIPT,
  DESIGN_RELEASE_SCRIPT,
  designCaptureScript,
  designMarkScript,
  MAX_DESIGN_INSTRUCTION_CHARS,
  MAX_DESIGN_STROKE_POINTS,
  parseDesignEdits,
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
      designMarkScript(
        [
          {
            kind: "element",
            id: "a",
            n: 1,
            selector: "#save",
            preview: { text: "it's `quoted`", styles: { color: "red" } },
          },
        ],
        ["b"],
      ),
      designCaptureScript(null),
    ])
      expect(() => new Function(`return ${script};`)).not.toThrow();
  });

  it("embeds selectors and previews as data, not code", () => {
    const script = designMarkScript([
      { kind: "element", id: "a", n: 1, selector: '"); alert(1); ("', preview: { text: "</script>" } },
    ]);
    expect(script).toContain(JSON.stringify('"); alert(1); ("'));
  });
});

describe("parseDesignPickResult", () => {
  it("reads clicks, drawn regions, notes, removals, and mode changes", () => {
    expect(parseDesignPickResult({ kind: "element", id: "a-1", selector: "#pay" })).toEqual({
      kind: "element",
      id: "a-1",
      selector: "#pay",
    });
    expect(
      parseDesignPickResult({
        kind: "region",
        id: "a-2",
        bounds: { x: 1.4, y: 2.6, width: 30, height: 40 },
        viewport: { width: 800, height: "tall" },
        strokes: [{ tool: "arrow", points: [1, 2, 3, 4] }],
        instruction: "  Cards feel flat  ",
      }),
    ).toEqual({
      kind: "region",
      id: "a-2",
      bounds: { x: 1, y: 3, width: 30, height: 40 },
      viewport: { width: 800, height: 0 },
      strokes: [{ tool: "arrow", points: [1, 2, 3, 4] }],
      instruction: "Cards feel flat",
    });
    expect(
      parseDesignPickResult({ kind: "note", id: "a-1", instruction: "x".repeat(MAX_DESIGN_INSTRUCTION_CHARS + 5) }),
    ).toEqual({ kind: "note", id: "a-1", instruction: "x".repeat(MAX_DESIGN_INSTRUCTION_CHARS) });
    expect(parseDesignPickResult({ kind: "note", id: "a-1", instruction: "", edits: null })).toEqual({
      kind: "note",
      id: "a-1",
      instruction: "",
      edits: null,
    });
    expect(parseDesignPickResult({ kind: "remove", id: "a-1" })).toEqual({ kind: "remove", id: "a-1" });
    expect(parseDesignPickResult({ kind: "mode", mode: "draw" })).toEqual({ kind: "mode", mode: "draw" });
  });

  it("treats anything unusable as the end of the session", () => {
    expect(parseDesignPickResult(null)).toBeNull();
    expect(parseDesignPickResult({ kind: "element", selector: "#pay" })).toBeNull();
    expect(parseDesignPickResult({ kind: "region", id: "r", bounds: { x: 0, y: 0, width: -1, height: 1 } })).toBeNull();
    expect(parseDesignPickResult({ kind: "mode", mode: "zoom" })).toBeNull();
    expect(parseDesignPickResult({ kind: "element", id: "a", selector: "" })).toBeNull();
  });
});

describe("parseDesignEdits", () => {
  it("keeps allowed, non-empty CSS changes once each and the text change", () => {
    expect(
      parseDesignEdits({
        text: { from: "Save", to: "Save now" },
        css: [
          { property: "color", from: "red", to: " blue " },
          { property: "color", from: "red", to: "green" },
          { property: "position", from: "static", to: "fixed" },
          { property: "padding", from: "4px", to: " " },
        ],
      }),
    ).toEqual({ text: { from: "Save", to: "Save now" }, css: [{ property: "color", from: "red", to: "blue" }] });
    expect(parseDesignEdits({ css: [] })).toBeUndefined();
    expect(parseDesignEdits("nope")).toBeUndefined();
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
        { tool: "arrow", points: [0, 0, 5, 5] },
        { tool: "pen", points: Array.from({ length: MAX_DESIGN_STROKE_POINTS + 10 }, (_, index) => index) },
      ]),
    ).toEqual([
      { tool: "rect", points: [0, 0, 10, 10] },
      { tool: "arrow", points: [0, 0, 5, 5] },
      { tool: "pen", points: Array.from({ length: MAX_DESIGN_STROKE_POINTS }, (_, index) => index) },
    ]);
    expect(parseStrokes("nope")).toEqual([]);
  });
});
