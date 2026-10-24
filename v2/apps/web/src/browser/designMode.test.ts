import { describe, expect, it } from "vitest";

import {
  type DesignPick,
  designAttachments,
  designSummary,
  formatDesignMessage,
  MAX_DESIGN_PICKS,
  parseDesignInspection,
  pickedSelector,
} from "./designMode.js";

const button: DesignPick = {
  id: "1",
  selector: "#save",
  tag: "button",
  name: "Save",
  url: "http://127.0.0.1:4000/",
  html: '<button id="save" class="primary">Save</button>',
  styles: { display: "inline-block", backgroundColor: "rgb(0, 0, 255)", fontSize: "14px" },
  bounds: { x: 10, y: 20, width: 80.4, height: 30 },
  screenshot: { data: "aGVsbG8=", mimeType: "image/png" },
};

describe("pickedSelector", () => {
  it("reads the selector of a pick and treats anything else as cancelled", () => {
    expect(pickedSelector({ selector: " main > h1 " })).toBe("main > h1");
    expect(pickedSelector(null)).toBeUndefined();
    expect(pickedSelector({ selector: "" })).toBeUndefined();
    expect(pickedSelector("main")).toBeUndefined();
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
  it("names the tag and cuts long text", () => {
    expect(designSummary({ tag: "button", name: "Save" })).toBe('<button> "Save"');
    expect(designSummary({ tag: "div", name: "" })).toBe("<div>");
    expect(designSummary({ tag: "p", name: "x".repeat(80) })).toBe(`<p> "${"x".repeat(59)}…"`);
  });
});

describe("formatDesignMessage", () => {
  it("puts the request first and describes the element", () => {
    const message = formatDesignMessage([button], "  Make it green.  ", "feature");
    expect(message).toBe(
      [
        "Please change this element in the page on http://127.0.0.1:4000/ (worktree feature), which I picked in the ZLI browser panel.",
        "What should change:\nMake it green.",
        [
          '### Element 1: <button> "Save"',
          "Selector: `#save`",
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

  it("names the page of each element when they come from different pages and fences backticks", () => {
    const other: DesignPick = {
      id: "2",
      selector: "footer",
      tag: "footer",
      name: "",
      url: "http://127.0.0.1:4000/about",
      html: "<footer>```</footer>",
      htmlTruncated: true,
      styles: {},
    };
    const message = formatDesignMessage([button, other], "Line these up.");
    expect(message).toContain("Please change these 2 elements in the page, which I picked");
    expect(message).toContain("Page: http://127.0.0.1:4000/about");
    expect(message).toContain("HTML (cut short):\n````html\n<footer>```</footer>…\n````");
    expect(message).not.toContain("Screenshot: element-2");
  });
});

describe("designAttachments", () => {
  it("attaches one screenshot per element, up to the chat limit", () => {
    const picks = Array.from({ length: MAX_DESIGN_PICKS + 2 }, (_, index) => ({ ...button, id: String(index) }));
    const attachments = designAttachments(picks);
    expect(attachments).toHaveLength(MAX_DESIGN_PICKS);
    expect(attachments[0]).toEqual({ name: "element-1.png", mimeType: "image/png", dataBase64: "aGVsbG8=" });
    expect(designAttachments([{ ...button, screenshot: undefined }])).toEqual([]);
  });
});
