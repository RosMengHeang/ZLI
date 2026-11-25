import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Reads the styles from disk here because the web app itself may not import Node modules.
const css = readFileSync(new URL("../apps/web/src/chat/chat.css", import.meta.url), "utf8");

/** The declarations of the first rule whose selector list is exactly `selector`. */
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  return start < 0 ? "" : css.slice(start, css.indexOf("}", start));
};

describe("chat long lines", () => {
  it("wraps a long word in prose instead of widening the chat", () => {
    expect(rule(".markdown")).toContain("overflow-wrap: anywhere");
    expect(rule(".markdown")).toContain("min-width: 0");
  });

  it("scrolls code sideways, folded or not", () => {
    const code = rule(".markdown pre, .markdown .md-code");
    expect(code).toContain("white-space: pre");
    expect(code).toContain("overflow: auto");
    expect(rule(".md-code-block.is-folded > .md-code")).toContain("overflow-x: auto");
  });
});
