import { describe, expect, it } from "vitest";

import { parseMarkdown, tableCells, trimUrl } from "./Markdown.js";

describe("parseMarkdown", () => {
  it("reads a table with its column alignment", () => {
    const blocks = parseMarkdown("| File | Lines |\n| :--- | ---: |\n| src/app.ts | 12 |\n| README.md |\n\nAfter");
    expect(blocks).toEqual([
      {
        kind: "table",
        head: ["File", "Lines"],
        align: ["left", "right"],
        rows: [
          ["src/app.ts", "12"],
          ["README.md", ""],
        ],
      },
      { kind: "paragraph", text: "After" },
    ]);
  });

  it("keeps a line with a pipe as text when no table rule follows", () => {
    expect(parseMarkdown("a | b\nc")).toEqual([{ kind: "paragraph", text: "a | b\nc" }]);
  });

  it("keeps numbered items in one list across blank lines", () => {
    expect(parseMarkdown("1. One\n\n2. Two\n\n3. Three")).toEqual([
      {
        kind: "list",
        ordered: true,
        items: [
          { text: "One", children: [] },
          { text: "Two", children: [] },
          { text: "Three", children: [] },
        ],
      },
    ]);
  });

  it("nests indented items and reads task boxes", () => {
    expect(parseMarkdown("- [x] Done\n- [ ] Next\n  - Detail\n    more of it\n3. Third")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          { text: "Done", checked: true, children: [] },
          {
            text: "Next",
            checked: false,
            children: [{ kind: "list", ordered: false, items: [{ text: "Detail\nmore of it", children: [] }] }],
          },
        ],
      },
      { kind: "list", ordered: true, start: 3, items: [{ text: "Third", children: [] }] },
    ]);
  });

  it("reads rules, and quotes that run over several lines", () => {
    expect(parseMarkdown("Above\n\n---\n\n> one\n> two")).toEqual([
      { kind: "paragraph", text: "Above" },
      { kind: "rule" },
      { kind: "quote", text: "one\ntwo" },
    ]);
  });

  it("leaves table syntax inside a code block alone", () => {
    expect(parseMarkdown("```\n| a | b |\n| - | - |\n```")).toEqual([
      { kind: "code", lang: "", text: "| a | b |\n| - | - |" },
    ]);
  });
});

describe("tableCells", () => {
  it("keeps a pipe inside code or after a backslash in its cell", () => {
    expect(tableCells("| `a | b` | c \\| d |")).toEqual(["`a | b`", "c | d"]);
  });
});

describe("trimUrl", () => {
  it("drops the punctuation that ends a sentence", () => {
    expect(trimUrl("https://example.com/docs.")).toBe("https://example.com/docs");
    expect(trimUrl("https://example.com/a),")).toBe("https://example.com/a");
    expect(trimUrl("https://en.wikipedia.org/wiki/Rust_(language)")).toBe(
      "https://en.wikipedia.org/wiki/Rust_(language)",
    );
  });
});
