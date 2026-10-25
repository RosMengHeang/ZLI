import { describe, expect, it } from "vitest";

import { baseBranchOptions, branchOptions, defaultBranchOf, trackDescription, trackText } from "./branches.js";
import { compareDefaultOf } from "./ReviewPane.js";

const BRANCHES = {
  current: "feature/pr",
  defaultBranch: "main",
  local: ["feature/pr", "release", "main"],
  remote: ["release", "main", "feature/pr"],
};

describe("upstream counts", () => {
  it("shows commits to push and pull as arrows and in words", () => {
    const upstream = { name: "origin/a", ahead: 2, behind: 1 };
    expect(trackText(upstream)).toBe("↑2 ↓1");
    expect(trackText({ ...upstream, ahead: 0 })).toBe("↓1");
    expect(trackText({ ...upstream, ahead: 0, behind: 0 })).toBe("");
    expect(trackText(undefined)).toBe("");
    expect(trackDescription(upstream)).toBe("2 commits to push, 1 commit to pull against origin/a.");
    expect(trackDescription({ ...upstream, ahead: 0, behind: 0 })).toBe("Up to date with origin/a.");
    expect(trackDescription({ ...upstream, gone: true })).toBe("origin/a no longer exists.");
  });
});

describe("branch choices", () => {
  it("lists local branches with the default on top and leaves out the current one", () => {
    expect(branchOptions(BRANCHES).map((option) => option.value)).toEqual(["main", "release"]);
  });

  it("adds origin's branches for comparisons, including this branch's pushed copy", () => {
    expect(branchOptions(BRANCHES, { remote: true }).map((option) => option.value)).toEqual([
      "main",
      "release",
      "origin/main",
      "origin/release",
      "origin/feature/pr",
    ]);
  });

  it("keeps a selected branch Git no longer lists", () => {
    expect(branchOptions(BRANCHES, { selected: "gone" })[0]).toEqual({ value: "gone", label: "gone" });
  });

  it("offers origin's branches as pull request bases", () => {
    expect(baseBranchOptions(BRANCHES).map((option) => option.value)).toEqual(["main", "release"]);
  });

  it("starts on origin's default, then main or master", () => {
    expect(defaultBranchOf(BRANCHES)).toBe("main");
    expect(defaultBranchOf({ local: ["dev", "master"], remote: [] })).toBe("master");
    expect(defaultBranchOf({ current: "dev", local: ["dev", "trunk"], remote: [] })).toBe("trunk");
  });

  it("compares against origin's copy when the default branch is not checked out", () => {
    expect(compareDefaultOf(BRANCHES)).toBe("main");
    expect(compareDefaultOf({ ...BRANCHES, local: ["feature/pr"] })).toBe("origin/main");
  });
});
