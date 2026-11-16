import { describe, expect, it } from "vitest";

import { findFileReferences, indexBasenames, parseFileReference, toWorktreePath } from "./filePaths.js";
import { buildFileTree, ancestorDirectories, visibleTreeRows } from "./fileTree.js";
import { fuzzyMatch, rankFiles } from "./fuzzy.js";

const root = "D:\\work\\repo";
const files = new Set(["src/app.ts", "src/util/strings.ts", "README.md", "docs/README.md", "Dockerfile"]);
const basenames = indexBasenames(files);

describe("toWorktreePath", () => {
  it("strips the worktree root, ./ prefixes, and backslashes", () => {
    expect(toWorktreePath("D:\\work\\repo\\src\\app.ts", root)).toBe("src/app.ts");
    expect(toWorktreePath("d:/WORK/repo/src/app.ts", root)).toBe("src/app.ts");
    expect(toWorktreePath("./src/app.ts", root)).toBe("src/app.ts");
  });
});

describe("parseFileReference", () => {
  it("reads line and column suffixes in the common formats", () => {
    expect(parseFileReference("src/app.ts:12:4", root, files, basenames)).toEqual({
      path: "src/app.ts",
      line: 12,
      column: 4,
    });
    expect(parseFileReference("src/app.ts(12,4)", root, files, basenames)).toEqual({
      path: "src/app.ts",
      line: 12,
      column: 4,
    });
    expect(parseFileReference("src/app.ts#L7-L9", root, files, basenames)).toEqual({ path: "src/app.ts", line: 7 });
    expect(parseFileReference("D:\\work\\repo\\src\\app.ts:3", root, files, basenames)).toEqual({
      path: "src/app.ts",
      line: 3,
    });
  });

  it("resolves a bare file name only when one file has it", () => {
    expect(parseFileReference("strings.ts", root, files, basenames)).toEqual({ path: "src/util/strings.ts" });
    expect(parseFileReference("README.md", root, files, basenames)).toEqual({ path: "README.md" });
    expect(parseFileReference("app.ts.", root, files, basenames)).toEqual({ path: "src/app.ts" });
    expect(parseFileReference("missing.ts", root, files, basenames)).toBeUndefined();
  });
});

describe("findFileReferences", () => {
  it("finds paths in terminal and chat text with their exact spans", () => {
    const line = "Edited src/app.ts:4 and D:\\work\\repo\\src\\util\\strings.ts, see (Dockerfile).";
    const references = findFileReferences(line, root, files, basenames);
    expect(references.map((reference) => line.slice(reference.start, reference.end))).toEqual([
      "src/app.ts:4",
      "D:\\work\\repo\\src\\util\\strings.ts",
      "Dockerfile",
    ]);
    expect(references[0]?.location).toEqual({ path: "src/app.ts", line: 4 });
  });

  it("ignores words that only look like files", () => {
    expect(findFileReferences("version 1.2.3 of node.js is fine", root, files, basenames)).toEqual([]);
  });
});

describe("fuzzy", () => {
  it("ranks a file name match above a scattered path match", () => {
    const ranked = rankFiles("app", ["src/apple/pie.ts", "src/app.ts", "a/p/p.ts"]);
    expect(ranked[0]?.path).toBe("src/app.ts");
  });

  it("rejects queries whose characters are not in order", () => {
    expect(fuzzyMatch("zx", "src/app.ts")).toBeUndefined();
    expect(fuzzyMatch("sapp", "src/app.ts")?.indices).toEqual([0, 4, 5, 6]);
  });
});

describe("file tree", () => {
  const tree = buildFileTree([
    { path: "src/b.ts" },
    { path: "src/a.ts", status: "modified" },
    { path: "src/util/c.ts", status: "untracked" },
    { path: "README.md" },
  ]);

  it("sorts folders before files and counts changes in each folder", () => {
    expect(tree.directories.map((directory) => directory.name)).toEqual(["src"]);
    expect(tree.files.map((file) => file.name)).toEqual(["README.md"]);
    expect(tree.changed).toBe(2);
    expect(tree.directories[0]?.changed).toBe(2);
    expect(tree.directories[0]?.directories[0]?.changed).toBe(1);
  });

  it("shows only the expanded part", () => {
    expect(visibleTreeRows(tree, new Set()).map((row) => row.path)).toEqual(["src", "README.md"]);
    expect(visibleTreeRows(tree, new Set(["src"])).map((row) => row.path)).toEqual([
      "src",
      "src/util",
      "src/a.ts",
      "src/b.ts",
      "README.md",
    ]);
  });

  it("lists the folders above a file", () => {
    expect(ancestorDirectories("src/util/c.ts")).toEqual(["src", "src/util"]);
    expect(ancestorDirectories("README.md")).toEqual([]);
  });
});
