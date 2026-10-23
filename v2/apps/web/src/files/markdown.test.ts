// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { isMarkdownPath, parseFileViewModes } from "./fileViewModes.js";
import { markdownHeadings, renderMarkdown, resolveMarkdownLink, resolveWorktreePath, slugify } from "./markdown.js";

function render(source: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdown(source);
  return host;
}

describe("renderMarkdown", () => {
  it("renders GitHub-flavoured Markdown", () => {
    const host = render(
      [
        "# Title",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "- [x] done",
        "- [ ] todo",
        "",
        "~~gone~~ and https://example.com",
        "",
        "Note[^1]",
        "",
        "[^1]: The footnote.",
      ].join("\n"),
    );
    expect(host.querySelector("h1")?.id).toBe("user-content-title");
    expect(host.querySelectorAll("table td")).toHaveLength(2);
    const boxes = [...host.querySelectorAll<HTMLInputElement>("li.task-list-item input[type=checkbox]")];
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect(boxes.every((box) => box.disabled)).toBe(true);
    expect(host.querySelector("s")?.textContent).toBe("gone");
    expect(host.querySelector("a[href='https://example.com']")).not.toBeNull();
    expect(host.querySelector(".footnotes")?.textContent).toContain("The footnote.");
  });

  it("marks blocks with the source line they start on", () => {
    const host = render("# One\n\nParagraph\n\n```ts\nconst a = 1;\n```\n");
    const lines = [...host.querySelectorAll<HTMLElement>("[data-source-line]")].map(
      (element) => `${element.tagName.toLowerCase()}:${element.dataset.sourceLine}`,
    );
    expect(lines).toEqual(["h1:1", "p:3", "code:5"]);
    expect(host.querySelector("pre code")?.className).toBe("language-ts");
  });

  it("removes scripts, event handlers, frames, styles, and unsafe links", () => {
    const host = render(
      [
        "<script>window.hacked = true</script>",
        '<img src="x.png" onerror="window.hacked = true">',
        '<iframe src="https://example.com"></iframe>',
        '<p style="color: red" class="evil">styled</p>',
        "[click](javascript:alert(1))",
        '<a href="#" onclick="alert(1)">a</a>',
        '<div id="root">shadow</div>',
      ].join("\n\n"),
    );
    const html = host.innerHTML;
    expect(html).not.toMatch(/<script|onerror|onclick|<iframe|style=|href="javascript:|class="evil"/u);
    expect(host.querySelector("[id='root']")).toBeNull();
    expect(host.querySelector("#user-content-root")?.textContent).toBe("shadow");
  });

  it("holds images back until the preview decides how to load them", () => {
    const host = render(
      [
        "![logo](docs/logo.png)",
        "![badge](https://img.shields.io/badge.svg)",
        '<img src="file:///C:/secret.png" alt="local">',
        "![inline](data:image/png;base64,AAAA)",
        '<img data-zli-src="../../etc/passwd" alt="sneaky">',
      ].join("\n\n"),
    );
    const images = [...host.querySelectorAll("img")];
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      null,
      null,
      null,
      "data:image/png;base64,AAAA",
      null,
    ]);
    expect(images[0]?.dataset.zliSrc).toBe("docs/logo.png");
    expect(images[1]?.dataset.zliRemote).toBe("https://img.shields.io/badge.svg");
    // DOMPurify drops the file: address itself, so only the marker remains.
    expect(images[2]?.dataset.zliBlocked).toBe("");
    expect(images[4]?.dataset.zliSrc).toBeUndefined();
    expect(images[4]?.dataset.zliBlocked).toBe("");
  });
});

describe("Markdown links", () => {
  it("resolves relative links against the open file", () => {
    expect(resolveMarkdownLink("guide.md", "docs/README.md")).toEqual({ kind: "file", path: "docs/guide.md" });
    expect(resolveMarkdownLink("../src/app.ts#L12", "docs/README.md")).toEqual({
      kind: "file",
      path: "src/app.ts",
      line: 12,
    });
    expect(resolveMarkdownLink("/LICENSE", "docs/deep/a.md")).toEqual({ kind: "file", path: "LICENSE" });
    expect(resolveMarkdownLink("my%20notes.md?raw=1", "README.md")).toEqual({ kind: "file", path: "my notes.md" });
  });

  it("sorts out anchors, web links, and links ZLI cannot follow", () => {
    expect(resolveMarkdownLink("#getting-started", "README.md")).toEqual({
      kind: "anchor",
      id: "user-content-getting-started",
    });
    expect(resolveMarkdownLink("https://example.com/a", "README.md")).toEqual({
      kind: "external",
      url: "https://example.com/a",
    });
    expect(resolveMarkdownLink("mailto:a@example.com", "README.md").kind).toBe("unsupported");
    expect(resolveMarkdownLink("../../outside.md", "docs/README.md").kind).toBe("unsupported");
  });

  it("never climbs out of the worktree", () => {
    expect(resolveWorktreePath("docs", "../../x")).toBeUndefined();
    expect(resolveWorktreePath("", "./a/./b/../c.png")).toBe("a/c.png");
  });
});

describe("Markdown helpers", () => {
  it("makes GitHub-style heading anchors", () => {
    expect(slugify("Getting Started: v2!")).toBe("getting-started-v2");
  });

  it("lists headings outside code fences", () => {
    expect(markdownHeadings("# A\n\n```\n# not a heading\n```\n\n## B ##\n")).toEqual([
      { level: 1, text: "A", line: 1 },
      { level: 2, text: "B", line: 7 },
    ]);
  });

  it("knows which files are Markdown", () => {
    expect(["README", "docs/guide.md", "notes.MDX", "a.markdown"].map(isMarkdownPath)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(["readme.txt", "src/app.ts", ".md"].map(isMarkdownPath)).toEqual([false, false, false]);
  });

  it("falls back to the default view when the stored one is damaged", () => {
    expect(parseFileViewModes(null).markdown).toBe("preview");
    expect(parseFileViewModes('{"markdown":"split"}').markdown).toBe("split");
    expect(parseFileViewModes('{"markdown":"sideways"}').markdown).toBe("preview");
    expect(parseFileViewModes("not json").markdown).toBe("preview");
  });
});
