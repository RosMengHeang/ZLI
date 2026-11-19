import type { PullRequestInfo } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import type { AgentSession } from "../sessions/sessions.js";
import {
  agentNote,
  branchStage,
  diffTotals,
  pullRequestMark,
  pullRequestProblems,
  railBadge,
  railTileLabels,
  readyToMerge,
  shortBranchName,
  splitActive,
} from "./sidebarStages.js";

const pullRequest = (fields: Partial<PullRequestInfo> = {}) =>
  ({ number: 1, state: "OPEN", isDraft: false, ...fields }) as PullRequestInfo;

const base = {
  git: true,
  sessions: [],
  worktreeBusy: false,
  worktreeNeedsPerson: false,
  changedFiles: 0,
  pullRequest: undefined,
};

describe("agentNote", () => {
  const agent = (status: AgentSession["status"]) =>
    ({ provider: "codex", status }) satisfies Pick<AgentSession, "provider" | "status" | "thread">;
  const failing = pullRequest({ checks: [{ name: "a", state: "failed" }] as PullRequestInfo["checks"] });

  it("says the plain status when a waiting agent has not said what it wants", () => {
    expect(agentNote(agent("waiting"), undefined, undefined)).toEqual({ text: "Needs input", tone: "waiting" });
  });

  it("says an agent failed", () => {
    expect(agentNote(agent("failed"), undefined, undefined)).toEqual({ text: "Failed", tone: "failed" });
  });

  it("says what holds the pull request back once the agent has stopped", () => {
    expect(agentNote(agent("ready"), undefined, failing)).toEqual({ text: "1 check failed", tone: "failed" });
  });

  it("stays quiet while the agent may still be fixing it, or nothing is wrong", () => {
    expect(agentNote(agent("working"), undefined, failing)).toBeUndefined();
    expect(agentNote(agent("ready"), undefined, pullRequest())).toBeUndefined();
    expect(agentNote(agent("ready"), undefined, undefined)).toBeUndefined();
    expect(agentNote(agent("ready"), undefined, pullRequest({ isDraft: true }))).toBeUndefined();
  });
});

describe("readyToMerge", () => {
  it("wants an open pull request with passing checks and no review holding it back", () => {
    expect(readyToMerge(pullRequest())).toBe(true);
    expect(readyToMerge(pullRequest({ reviewDecision: "APPROVED" }))).toBe(true);
    expect(readyToMerge(undefined)).toBe(false);
    expect(readyToMerge(pullRequest({ isDraft: true }))).toBe(false);
    expect(readyToMerge(pullRequest({ state: "MERGED" }))).toBe(false);
    expect(readyToMerge(pullRequest({ reviewDecision: "REVIEW_REQUIRED" }))).toBe(false);
    expect(readyToMerge(pullRequest({ reviewDecision: "CHANGES_REQUESTED" }))).toBe(false);
    expect(readyToMerge(pullRequest({ checks: [{ state: "failed" }] as PullRequestInfo["checks"] }))).toBe(false);
    expect(readyToMerge(pullRequest({ checks: [{ state: "pending" }] as PullRequestInfo["checks"] }))).toBe(false);
  });
});

describe("branchStage", () => {
  it("does not offer Merge while an agent may still push", () => {
    expect(branchStage({ ...base, pullRequest: pullRequest(), sessions: [{ status: "working" }] })).toBe("working");
    expect(branchStage({ ...base, pullRequest: pullRequest(), sessions: [{ status: "ready" }] })).toBe("ready");
  });

  it("keeps a worktree being created in Working", () => {
    expect(branchStage({ ...base, worktreeBusy: true })).toBe("working");
  });

  it("lifts whatever needs the person above every other stage", () => {
    expect(branchStage({ ...base, worktreeBusy: true, worktreeNeedsPerson: true })).toBe("attention");
    expect(branchStage({ ...base, sessions: [{ status: "working" }, { status: "waiting" }] })).toBe("attention");
    expect(branchStage({ ...base, sessions: [{ status: "failed" }], pullRequest: pullRequest() })).toBe("attention");
    expect(branchStage({ ...base, git: false, sessions: [{ status: "waiting" }] })).toBe("attention");
  });

  it("sorts by the pull request once no agent is live", () => {
    expect(branchStage({ ...base, pullRequest: pullRequest({ isDraft: true }) })).toBe("review");
    expect(branchStage({ ...base, pullRequest: pullRequest({ state: "MERGED" }), changedFiles: 4 })).toBe("merged");
  });

  it("treats changes with no open pull request as work in progress", () => {
    expect(branchStage({ ...base, changedFiles: 2 })).toBe("working");
    expect(branchStage({ ...base, changedFiles: 2, pullRequest: pullRequest({ state: "CLOSED" }) })).toBe("working");
    expect(branchStage(base)).toBe("quiet");
  });

  it("gives folders without Git their own group", () => {
    expect(branchStage({ ...base, git: false, sessions: [{ status: "working" }] })).toBe("noGit");
  });
});

describe("pullRequestMark", () => {
  const checks = (...states: string[]) => states.map((state) => ({ state })) as PullRequestInfo["checks"];

  it("says how the checks went, and what it means when there are none", () => {
    expect(pullRequestMark(pullRequest({ checks: checks("passed", "passed") })).icon).toBe("check");
    expect(pullRequestMark(pullRequest({ checks: checks("passed", "failed", "pending") })).icon).toBe("x");
    expect(pullRequestMark(pullRequest({ checks: checks("passed", "pending") })).tone).toBe("warning");
    expect(pullRequestMark(pullRequest()).tone).toBe("quiet");
    expect(pullRequestMark(pullRequest({ state: "MERGED", checks: checks("failed") })).icon).toBe("merge");
  });
});

describe("shortBranchName", () => {
  it("drops the folder and leaves plain names alone", () => {
    expect(shortBranchName("fix/plan-limits")).toBe("plan-limits");
    expect(shortBranchName("zli/a/b")).toBe("b");
    expect(shortBranchName("main")).toBe("main");
    expect(shortBranchName("odd/")).toBe("odd/");
  });
});

describe("diffTotals", () => {
  it("adds up the files and shows nothing when there is nothing to show", () => {
    const file = (additions: number, deletions: number) => ({ additions, deletions }) as never;
    expect(diffTotals({ files: [file(3, 1), file(2, 0)] })).toEqual({ additions: 5, deletions: 1 });
    expect(diffTotals({ files: [file(0, 0)] })).toBeUndefined();
    expect(diffTotals(undefined)).toBeUndefined();
  });
});

describe("pullRequestProblems", () => {
  it("lists trouble reaching GitHub once, and leaves out ordinary repository states", () => {
    const entry = (code: string, message: string) =>
      ({ checking: false, status: { problem: { code, message } } }) as never;
    expect(
      pullRequestProblems([
        entry("gh_missing", "Install gh."),
        entry("gh_missing", "Install gh."),
        entry("no_origin", "No origin."),
        entry("detached", "Detached."),
        undefined,
      ]),
    ).toEqual(["Install gh."]);
  });
});

describe("railBadge", () => {
  it("counts waiting agents first because they need the person", () => {
    expect(railBadge([{ status: "working" }, { status: "waiting" }])).toEqual({ count: 1, tone: "waiting" });
    expect(railBadge([{ status: "working" }, { status: "starting" }])).toEqual({ count: 2, tone: "working" });
    expect(railBadge([{ status: "ready" }, { status: "ended" }])).toBeUndefined();
  });

  it("says a project has a failed agent, ahead of what is still working", () => {
    expect(railBadge([{ status: "working" }, { status: "failed" }])).toEqual({ count: 1, tone: "failed" });
    expect(railBadge([{ status: "failed" }, { status: "waiting" }])).toEqual({ count: 1, tone: "waiting" });
  });
});

describe("railTileLabels", () => {
  it("uses one letter, or two where projects share a first letter", () => {
    expect(railTileLabels(["ZLI", "notes", "new-repo", "kh-address"])).toEqual(["Z", "No", "Ne", "K"]);
  });

  it("starts from the first letter or digit, and copes with an empty or symbol-only name", () => {
    expect(railTileLabels([".dotfiles", "", "___"])).toEqual(["D", "", "_"]);
  });
});

describe("splitActive", () => {
  it("keeps the newest others as recent and folds the rest away", () => {
    const agent = (sessionId: string, updatedAt: string) => ({ sessionId, updatedAt });
    const agents = [agent("a", "1"), agent("b", "5"), agent("c", "3"), agent("d", "4"), agent("e", "2")];
    const result = splitActive(agents, (entry) => entry.sessionId === "a", 2);
    expect(result.active.map((entry) => entry.sessionId)).toEqual(["a"]);
    expect(result.recent.map((entry) => entry.sessionId)).toEqual(["b", "d"]);
    expect(result.earlier.map((entry) => entry.sessionId)).toEqual(["c", "e"]);
  });
});
