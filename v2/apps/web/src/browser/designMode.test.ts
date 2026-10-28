import { describe, expect, it } from "vitest";

import {
  type DesignElementAnnotation,
  type DesignRegionAnnotation,
  designAnnotationReady,
  designAttachments,
  designEditSummary,
  designEditsPreview,
  designMarks,
  designSummary,
  formatDesignMessage,
  MAX_DESIGN_ANNOTATIONS,
  parseDesignEdits,
  parseDesignInspection,
  parseDesignPickResult,
} from "./designMode.js";

const button: DesignElementAnnotation = {
  kind: "element",
  id: "1",
  selector: "#save",
  tag: "button",
  name: "Save",
  url: "http://127.0.0.1:4000/",
  html: '<button id="save" class="primary">Save</button>',
  styles: { display: "inline-block", backgroundColor: "rgb(0, 0, 255)", fontSize: "14px" },
  bounds: { x: 10, y: 20, width: 80.4, height: 30 },
  screenshot: { data: "aGVsbG8=", mimeType: "image/png" },
  instruction: "  Make it green.  ",
};

const region: DesignRegionAnnotation = {
  kind: "region",
  id: "2",
  url: "http://127.0.0.1:4000/",
  bounds: { x: 120, y: 340, width: 400, height: 200 },
  viewport: { width: 1280, height: 720 },
  strokes: [{ tool: "pen", points: [130, 350, 140, 360] }],
  screenshot: { data: "cmVnaW9u", mimeType: "image/png" },
  instruction: "Add a signup card here",
};

describe("parseDesignPickResult", () => {
  it("reads a clicked element and treats anything unusable as the end of the session", () => {
    expect(parseDesignPickResult({ kind: "element", id: "a-1", selector: " main > h1 " })).toEqual({
      kind: "element",
      id: "a-1",
      selector: "main > h1",
    });
    expect(parseDesignPickResult({ kind: "element", selector: "#pay" })).toBeUndefined();
    expect(parseDesignPickResult(null)).toBeUndefined();
    expect(parseDesignPickResult({ kind: "element", id: "a-1", selector: "" })).toBeUndefined();
    expect(parseDesignPickResult("main")).toBeUndefined();
  });

  it("reads saved notes, removals, and mode changes", () => {
    expect(parseDesignPickResult({ kind: "note", id: "a-1", instruction: " Bigger " })).toEqual({
      kind: "note",
      id: "a-1",
      instruction: "Bigger",
    });
    expect(
      parseDesignPickResult({
        kind: "note",
        id: "a-1",
        instruction: "",
        edits: { css: [{ property: "color", from: "red", to: "blue" }] },
      }),
    ).toEqual({
      kind: "note",
      id: "a-1",
      instruction: "",
      edits: { css: [{ property: "color", from: "red", to: "blue" }] },
    });
    expect(parseDesignPickResult({ kind: "note", id: "a-1", instruction: "", edits: null })).toEqual({
      kind: "note",
      id: "a-1",
      instruction: "",
      edits: null,
    });
    expect(parseDesignPickResult({ kind: "remove", id: "a-1" })).toEqual({ kind: "remove", id: "a-1" });
    expect(parseDesignPickResult({ kind: "mode", mode: "note" })).toEqual({ kind: "mode", mode: "note" });
    expect(parseDesignPickResult({ kind: "mode", mode: "zoom" })).toBeUndefined();
  });

  it("reads a drawn region and drops malformed strokes", () => {
    expect(
      parseDesignPickResult({
        kind: "region",
        id: "region-a",
        bounds: { x: 10.4, y: 20, width: 100, height: 50 },
        viewport: { width: 800, height: 600 },
        strokes: [
          { tool: "pen", points: [1, 2, 3, 4] },
          { tool: "laser", points: [1, 2] },
          { tool: "rect", points: [1, "2"] },
        ],
        instruction: "Add a card",
      }),
    ).toEqual({
      kind: "region",
      id: "region-a",
      bounds: { x: 10, y: 20, width: 100, height: 50 },
      viewport: { width: 800, height: 600 },
      strokes: [{ tool: "pen", points: [1, 2, 3, 4] }],
      instruction: "Add a card",
    });
    expect(parseDesignPickResult({ kind: "region", id: "r", bounds: { x: 0, y: 0, width: 0, height: 5 } })).toBe(
      undefined,
    );
  });
});

describe("parseDesignInspection", () => {
  it("keeps the fields the message uses and drops malformed ones", () => {
    const pick = parseDesignInspection(
      {
        tag: "h1",
        name: "  Welcome\n  back ",
        url: "http://127.0.0.1:4000/",
        html: "<h1>Welcome back</h1>",
        styles: { color: "red", width: 3, display: "" },
        bounds: { x: 1, y: 2, width: "wide", height: 4 },
        screenshot: { data: "abc", mimeType: "image/gif" },
      },
      "main > h1",
      "id-1",
    );
    expect(pick).toEqual({
      id: "id-1",
      selector: "main > h1",
      tag: "h1",
      name: "Welcome back",
      url: "http://127.0.0.1:4000/",
      html: "<h1>Welcome back</h1>",
      styles: { color: "red" },
    });
    expect(parseDesignInspection({ name: "x" }, "x", "id")).toBeUndefined();
  });
});

describe("designSummary", () => {
  it("names the tag and cuts long text, and calls a drawn area a region", () => {
    expect(designSummary({ tag: "button", name: "Save" })).toBe('<button> "Save"');
    expect(designSummary({ tag: "div", name: "" })).toBe("<div>");
    expect(designSummary({ tag: "p", name: "x".repeat(80) })).toBe(`<p> "${"x".repeat(59)}…"`);
    expect(designSummary(region)).toBe("Region");
  });
});

describe("formatDesignMessage", () => {
  it("describes one element with its own instruction", () => {
    expect(formatDesignMessage([button], "feature")).toBe(
      [
        "Please apply this design annotation I made in the ZLI browser panel on http://127.0.0.1:4000/ (worktree feature).",
        [
          '### Annotation 1: <button> "Save"',
          "Selector: `#save`",
          "Instruction: Make it green.",
          "Size: 80 × 30 px",
          "Screenshot: element-1.png (attached)",
          "Computed styles: display: inline-block; background-color: rgb(0, 0, 255); font-size: 14px",
          "HTML:",
          "```html",
          '<button id="save" class="primary">Save</button>',
          "```",
        ].join("\n"),
      ].join("\n\n"),
    );
  });

  it("batches elements and regions into one message, numbered in order", () => {
    const heading: DesignElementAnnotation = {
      ...button,
      id: "3",
      selector: ".hero-title",
      tag: "h1",
      name: "Welcome",
      instruction: "bigger, tighter",
      screenshot: undefined,
      html: undefined,
      styles: {},
    };
    const message = formatDesignMessage([button, region, heading]);
    expect(message.startsWith("Please apply these 3 design annotations I made in the ZLI browser panel on")).toBe(true);
    expect(message).toContain(
      [
        "### Annotation 2: Region",
        "Bounds: x 120, y 340, 400 × 200 px in page coordinates (viewport 1280 × 720)",
        "Instruction: Add a signup card here",
        "Sketch: region-2.png (attached; the red marks are my drawing)",
      ].join("\n"),
    );
    expect(message).toContain(
      '### Annotation 3: <h1> "Welcome"\nSelector: `.hero-title`\nInstruction: bigger, tighter',
    );
    expect(message).not.toContain("element-3");
    expect(message).not.toContain("What should change");
  });

  it("names a region's screenshot plainly when nothing was drawn and skips empty instructions", () => {
    const plain: DesignRegionAnnotation = { ...region, strokes: [], instruction: " " };
    const message = formatDesignMessage([plain]);
    expect(message).toContain("Screenshot: region-1.png (attached)");
    expect(message).not.toContain("Instruction:");
  });

  it("lists previewed text and CSS edits as changes to make in source", () => {
    const edited: DesignElementAnnotation = {
      ...button,
      instruction: "",
      edits: {
        text: { from: "Save", to: "Save changes" },
        css: [
          { property: "background-color", from: "rgb(0, 0, 255)", to: "green" },
          { property: "padding", from: "", to: "12px" },
        ],
      },
    };
    const message = formatDesignMessage([edited]);
    expect(message).toContain("were only previewed on the live page. Make them in the source code.");
    expect(message).toContain('Text: "Save" → "Save changes"');
    expect(message).toContain("CSS: background-color: rgb(0, 0, 255) → green; padding: unset → 12px");
  });

  it("names the page of each annotation when they come from different pages and fences backticks", () => {
    const other: DesignElementAnnotation = {
      kind: "element",
      id: "2",
      selector: "footer",
      tag: "footer",
      name: "",
      url: "http://127.0.0.1:4000/about",
      html: "<footer>```</footer>",
      htmlTruncated: true,
      styles: {},
      instruction: "Line these up.",
    };
    const message = formatDesignMessage([button, other]);
    expect(message).toContain("Please apply these 2 design annotations I made in the ZLI browser panel.");
    expect(message).toContain("Page: http://127.0.0.1:4000/about");
    expect(message).toContain("HTML (cut short):\n````html\n<footer>```</footer>…\n````");
    expect(message).not.toContain("Screenshot: element-2");
  });
});

describe("designAttachments", () => {
  it("attaches one image per annotation, named by its number, up to the chat limit", () => {
    const many = Array.from({ length: MAX_DESIGN_ANNOTATIONS + 2 }, (_, index) => ({ ...button, id: String(index) }));
    const attachments = designAttachments(many);
    expect(attachments).toHaveLength(MAX_DESIGN_ANNOTATIONS);
    expect(attachments[0]).toEqual({ name: "element-1.png", mimeType: "image/png", dataBase64: "aGVsbG8=" });
    expect(designAttachments([{ ...button, screenshot: undefined }, region])).toEqual([
      { name: "region-2.png", mimeType: "image/png", dataBase64: "cmVnaW9u" },
    ]);
  });
});

describe("design edits", () => {
  it("keeps allowed changes from the page and turns them into a preview", () => {
    const edits = parseDesignEdits({
      text: { from: "Save", to: "Save all" },
      css: [
        { property: "color", from: "rgb(0, 0, 0)", to: " red " },
        { property: "width", from: "10px", to: "20px" },
        { property: "padding", from: "8px", to: " " },
      ],
    });
    expect(edits).toEqual({
      text: { from: "Save", to: "Save all" },
      css: [{ property: "color", from: "rgb(0, 0, 0)", to: "red" }],
    });
    expect(designEditSummary(edits)).toBe("1 CSS edit · text");
    expect(designEditsPreview(edits)).toEqual({ text: "Save all", styles: { color: "red" } });
    expect(designEditsPreview(undefined)).toBeUndefined();
    expect(parseDesignEdits({ css: [{ property: "width", from: "1px", to: "2px" }] })).toBeUndefined();
  });

  it("counts an annotation as ready once it has an instruction or edits", () => {
    expect(designAnnotationReady({ ...button, instruction: " " })).toBe(false);
    expect(designAnnotationReady(button)).toBe(true);
    expect(
      designAnnotationReady({
        ...button,
        instruction: "",
        edits: { css: [{ property: "color", from: "a", to: "b" }] },
      }),
    ).toBe(true);
  });
});

describe("designMarks", () => {
  it("numbers the annotations with their notes and previews and leaves out ones from other pages", () => {
    const other = { ...button, id: "9", url: "http://127.0.0.1:4000/about" };
    const edited = { ...button, edits: { css: [{ property: "color", from: "black", to: "green" }] } };
    expect(designMarks([edited, other, { ...region, instruction: "" }], "http://127.0.0.1:4000/")).toEqual([
      {
        kind: "element",
        id: "1",
        n: 1,
        selector: "#save",
        note: "Make it green.",
        preview: { styles: { color: "green" } },
      },
      { kind: "region", id: "2", n: 3, bounds: region.bounds, strokes: region.strokes },
    ]);
  });
});
