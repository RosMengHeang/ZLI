import { describe, expect, it } from "vitest";

import { formatCommentsMessage, type ReviewComment, terminalPaste } from "./reviewComments.js";

const comment = (overrides: Partial<ReviewComment> = {}): ReviewComment => ({
  id: "c1",
  worktreeId: "wt-1",
  path: "src/app.ts",
  anchor: { side: "new", start: 2, end: 3 },
  excerpt: ["+  const trimmed = name.trim();", "+  return greeting(trimmed);"],
  body: "Use the trimmed name everywhere.",
  ...overrides,
});

describe("formatCommentsMessage", () => {
  it("lists each location, its diff lines, and the comment", () => {
    const removed = comment({
      path: "src/login.ts",
      anchor: { side: "old", start: 4, end: 4 },
      excerpt: ["-  x"],
      body: " Why? ",
    });
    expect(formatCommentsMessage([comment(), removed], "feature-greeting")).toBe(
      [
        "Please address these review comments on the changes in feature-greeting.",
        "",
        "src/app.ts:2-3",
        "```diff",
        "+  const trimmed = name.trim();",
        "+  return greeting(trimmed);",
        "```",
        "Use the trimmed name everywhere.",
        "",
        "src/login.ts:4 (before this change)",
        "```diff",
        "-  x",
        "```",
        "Why?",
      ].join("\n"),
    );
  });

  it("uses a longer fence when the excerpt has backticks, and shortens long excerpts", () => {
    const excerpt = ["+```", ...Array.from({ length: 14 }, (_, index) => `+line ${index}`)];
    const message = formatCommentsMessage([comment({ excerpt })], undefined);
    expect(message).toContain("this review comment on the changes.");
    expect(message).toContain("````diff\n+```\n");
    expect(message).toContain("+line 10\n… 3 more lines\n````");
  });
});

describe("terminalPaste", () => {
  it("wraps the message in bracketed paste markers with carriage returns and no Enter after", () => {
    expect(terminalPaste("one\ntwo", true)).toBe("\x1b[200~one\rtwo\x1b[201~");
  });

  it("drops control characters so the diff cannot end the paste early", () => {
    expect(terminalPaste("a\x1b[201~b\x07c\td", true)).toBe("\x1b[200~a[201~bc\td\x1b[201~");
  });

  it("sends one line when the program does not use bracketed paste", () => {
    expect(terminalPaste("first\n\n  second\r\nthird\n", false)).toBe("first second third");
  });
});
