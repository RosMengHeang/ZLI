import { describe, expect, it } from "vitest";

import { hunkPatch, partDiffArgs, splitPatch } from "./hunkPatch.js";

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@ export function app() {",
  " one",
  "-two",
  "+TWO",
  " three",
  "@@ -10,2 +10,3 @@",
  " ten",
  "+ten and a half",
  " eleven",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("splitPatch", () => {
  it("splits the header from each hunk", () => {
    expect(splitPatch(PATCH)).toEqual({
      header: PATCH.split("\n").slice(0, 4),
      hunks: [
        ["@@ -1,3 +1,3 @@ export function app() {", " one", "-two", "+TWO", " three"],
        ["@@ -10,2 +10,3 @@", " ten", "+ten and a half", " eleven", "\\ No newline at end of file"],
      ],
    });
  });

  it("refuses combined, binary, and multi-file diffs", () => {
    expect(splitPatch("diff --cc a.ts\n@@@ -1 -1 +1 @@@\n")).toBeUndefined();
    expect(splitPatch("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n")).toBeUndefined();
    expect(splitPatch(`${PATCH}diff --git a/b b/b\n@@ -1 +1 @@\n-a\n+b\n`)).toBeDefined();
    expect(splitPatch(`diff --git a/a b/a\ndiff --git a/b b/b\n@@ -1 +1 @@\n`)).toBeUndefined();
  });
});

describe("hunkPatch", () => {
  it("keeps the header and only the chosen hunk", () => {
    const second = ["@@ -10,2 +10,3 @@", " ten", "+ten and a half", " eleven", "\\ No newline at end of file"];
    expect(hunkPatch(PATCH, 1, `${second.join("\n")}\n`)).toBe(
      `${[...PATCH.split("\n").slice(0, 4), ...second].join("\n")}\n`,
    );
  });

  it("returns nothing when the hunk differs from the one shown", () => {
    expect(hunkPatch(PATCH, 0, "@@ -1,3 +1,3 @@ export function app() {\n one\n-two\n+Two\n three")).toBeUndefined();
    expect(hunkPatch(PATCH, 2, "@@ -1 +1 @@")).toBeUndefined();
  });
});

describe("partDiffArgs", () => {
  it("pins prefixes and reads the index for the staged half", () => {
    expect(partDiffArgs("staged", "a.ts")).toEqual([
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--unified=3",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--cached",
      "--",
      "a.ts",
    ]);
    expect(partDiffArgs("unstaged", "a.ts")).not.toContain("--cached");
  });
});
