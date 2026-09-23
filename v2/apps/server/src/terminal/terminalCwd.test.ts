import { describe, expect, it } from "vitest";

import { resolveTerminalCwd, TerminalCwdError } from "./terminalCwd.js";

describe("resolveTerminalCwd", () => {
  it("resolves the worktree root and nested directories", () => {
    expect(resolveTerminalCwd("/repo/tree", "/repo/tree")).toBe("/repo/tree");
    expect(resolveTerminalCwd("/repo/tree", ".")).toBe("/repo/tree");
    expect(resolveTerminalCwd("/repo/tree", "src")).toBe("/repo/tree/src");
    expect(resolveTerminalCwd("/repo/tree", "src/../lib")).toBe("/repo/tree/lib");
    expect(resolveTerminalCwd("/repo/tree", "/repo/tree/src/pkg")).toBe("/repo/tree/src/pkg");
    expect(resolveTerminalCwd("C:/Work/Tree", "C:/Work/Tree")).toBe("C:\\Work\\Tree");
    expect(resolveTerminalCwd("C:/Work/Tree", "src\\pkg")).toBe("C:\\Work\\Tree\\src\\pkg");
    expect(resolveTerminalCwd("C:/Work/Tree", "c:/work/tree/src")).toBe("c:\\work\\tree\\src");
  });

  it("rejects absolute and relative escapes, including prefix siblings", () => {
    expect(() => resolveTerminalCwd("/repo/tree", "/etc/passwd")).toThrowError(TerminalCwdError);
    expect(() => resolveTerminalCwd("/repo/tree", "../outside")).toThrowError(TerminalCwdError);
    expect(() => resolveTerminalCwd("/repo/tree", "/repo/tree-evil")).toThrowError(TerminalCwdError);
    expect(() => resolveTerminalCwd("/repo/tree", "src/../../etc")).toThrowError(TerminalCwdError);
    expect(() => resolveTerminalCwd("C:/Work/Tree", "C:/Windows/System32")).toThrowError(TerminalCwdError);
    expect(() => resolveTerminalCwd("C:/Work/Tree", "..\\Outside")).toThrowError(TerminalCwdError);
    expect(() => resolveTerminalCwd("C:/Work/Tree", "C:../Outside")).toThrowError(TerminalCwdError);
    expect(() => resolveTerminalCwd("C:/Work/Tree", "C:/Work/Tree-evil")).toThrowError(TerminalCwdError);
    expect(() => resolveTerminalCwd("relative/tree", "src")).toThrowError(TerminalCwdError);
  });
});
