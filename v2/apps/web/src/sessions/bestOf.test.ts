import { describe, expect, it } from "vitest";

import { parseRunGroups, type RunGroup, runBranches, runPosition, withoutRun } from "./bestOf.js";

const group: RunGroup = { groupId: "g", label: "fix-login", sessionIds: ["a", "b", "c"] };

describe("runBranches", () => {
  it("keeps the branch for one run and numbers it for more", () => {
    expect(runBranches("fix-login", 1)).toEqual(["fix-login"]);
    expect(runBranches("fix-login", 3)).toEqual(["fix-login-1", "fix-login-2", "fix-login-3"]);
  });

  it("cleans the name and caps the count at four", () => {
    expect(runBranches(" feature/fix login/ ", 2)).toEqual(["feature/fix-login-1", "feature/fix-login-2"]);
    expect(runBranches("x", 9)).toHaveLength(4);
    expect(runBranches("x", 0)).toEqual(["x"]);
    expect(runBranches("  ", 2)).toEqual([]);
  });
});

describe("run groups", () => {
  it("finds the position of a run", () => {
    expect(runPosition([group], "b")).toEqual({ group, index: 2, count: 3 });
    expect(runPosition([group], "z")).toBeUndefined();
  });

  it("drops a run and dissolves a group left with one", () => {
    expect(withoutRun([group], "a")).toEqual([{ ...group, sessionIds: ["b", "c"] }]);
    expect(withoutRun([{ ...group, sessionIds: ["a", "b"] }], "a")).toEqual([]);
    expect(withoutRun([group], "z")).toEqual([group]);
  });

  it("parses only well-formed groups", () => {
    expect(
      parseRunGroups([group, { groupId: "x", label: "y", sessionIds: ["only"] }, { groupId: 3 }, null, "text"]),
    ).toEqual([group]);
    expect(parseRunGroups(undefined)).toEqual([]);
  });
});
