import { describe, expect, it } from "vitest";

import {
  anchorCovers,
  anchorFor,
  findInLines,
  formatLocation,
  parseDiffLines,
  patchBody,
  splitOnMatches,
} from "./diffLines.js";

describe("patchBody", () => {
  it("starts a patch at its first hunk", () => {
    const patch = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b";
    expect(patchBody(patch)).toEqual(["@@ -1 +1 @@", "-a", "+b"]);
  });

  it("keeps a patch without hunks whole, such as a mode change", () => {
    expect(patchBody("diff --git a/x b/x\nold mode 100644\nnew mode 100755")).toHaveLength(3);
  });
});

const patch = [
  "@@ -1,4 +1,5 @@",
  " export function greet(name: string) {",
  "-  return greeting(name);",
  "+  const trimmed = name.trim();",
  "+  return greeting(trimmed);",
  " }",
  "",
  "@@ -10,2 +11,2 @@ export function farewell",
  "-  return 1;",
  "+  return 2;",
  " }",
  "",
];

describe("parseDiffLines", () => {
  it("numbers each side from the hunk headers", () => {
    const lines = parseDiffLines(patch);
    expect(lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ["hunk", undefined, undefined],
      ["context", 1, 1],
      ["del", 2, undefined],
      ["add", undefined, 2],
      ["add", undefined, 3],
      ["context", 3, 4],
      ["context", 4, 5],
      ["hunk", undefined, undefined],
      ["del", 10, undefined],
      ["add", undefined, 11],
      ["context", 11, 12],
      ["meta", undefined, undefined],
    ]);
  });

  it("treats lines after a hunk's counts run out as metadata", () => {
    const lines = parseDiffLines(["@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file", "--- a/x"]);
    expect(lines.map((line) => line.kind)).toEqual(["hunk", "del", "add", "meta", "meta"]);
  });

  it("keeps a removed line that starts with dashes as a removed line", () => {
    const lines = parseDiffLines(["@@ -1,2 +1,1 @@", "--- not a header", " kept"]);
    expect(lines[1]).toMatchObject({ kind: "del", oldLine: 1 });
  });
});

describe("anchors", () => {
  const lines = parseDiffLines(patch);

  it("uses new-file lines when the selection has any", () => {
    expect(anchorFor(lines.slice(2, 5))).toEqual({ side: "new", start: 2, end: 3 });
    expect(formatLocation("src/app.ts", { side: "new", start: 2, end: 3 })).toBe("src/app.ts:2-3");
  });

  it("falls back to old-file lines for removed lines only", () => {
    const anchor = anchorFor(lines.slice(2, 3));
    expect(anchor).toEqual({ side: "old", start: 2, end: 2 });
    expect(formatLocation("src/app.ts", { side: "old", start: 2, end: 2 })).toBe("src/app.ts:2 (before this change)");
  });

  it("has no anchor for hunk headers", () => {
    expect(anchorFor(lines.slice(0, 1))).toBeUndefined();
  });

  it("matches the lines an anchor covers", () => {
    const covered = lines.filter((line) => anchorCovers({ side: "new", start: 2, end: 4 }, line));
    expect(covered.map((line) => line.index)).toEqual([3, 4, 5]);
  });
});

describe("find in diff", () => {
  const lines = parseDiffLines(["@@ -1,2 +1,2 @@", "-const Total = 1;", "+const total = 2;", " return total;"]);

  it("finds every line containing the query regardless of case", () => {
    expect(findInLines(lines, "total")).toEqual([1, 2, 3]);
    expect(findInLines(lines, "= 2")).toEqual([2]);
    expect(findInLines(lines, "")).toEqual([]);
    expect(findInLines(lines, "missing")).toEqual([]);
  });

  it("splits a line into plain and matching runs", () => {
    expect(splitOnMatches("aXbxc", "x")).toEqual([
      { text: "a", match: false },
      { text: "X", match: true },
      { text: "b", match: false },
      { text: "x", match: true },
      { text: "c", match: false },
    ]);
    expect(splitOnMatches("abc", "")).toEqual([{ text: "abc", match: false }]);
    expect(splitOnMatches("aaaa", "aa")).toEqual([
      { text: "aa", match: true },
      { text: "aa", match: true },
    ]);
  });
});
