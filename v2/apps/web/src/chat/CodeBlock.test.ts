import { describe, expect, it } from "vitest";

import { opensAsPreview, previewDocument, previewKind } from "./CodeBlock.js";

describe("code block previews", () => {
  it("offers a preview for HTML and SVG only", () => {
    expect(previewKind("html", "<p>hi</p>")).toBe("html");
    expect(previewKind("HTML", "<p>hi</p>")).toBe("html");
    expect(previewKind("svg", "<svg></svg>")).toBe("svg");
    expect(previewKind("xml", "<svg viewBox='0 0 1 1'></svg>")).toBe("svg");
    expect(previewKind("xml", "<project></project>")).toBeUndefined();
    expect(previewKind("ts", "const a = 1;")).toBeUndefined();
    expect(previewKind("", "<html></html>")).toBeUndefined();
  });

  it("opens whole pages and drawings as a preview and fragments as code", () => {
    expect(opensAsPreview("html", "<!DOCTYPE html><html></html>")).toBe(true);
    expect(opensAsPreview("html", "\n<html lang='en'></html>")).toBe(true);
    expect(opensAsPreview("html", "<div class='card'></div>")).toBe(false);
    expect(opensAsPreview("svg", "<svg></svg>")).toBe(true);
  });

  it("puts a no-script, no-network policy ahead of the reply's markup", () => {
    const html = previewDocument("html", "<script>alert(1)</script><p>hi</p>");
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script>"));
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("script-src");
    const svg = previewDocument("svg", "<svg></svg>");
    expect(svg.indexOf("Content-Security-Policy")).toBeLessThan(svg.indexOf("<svg>"));
  });
});
