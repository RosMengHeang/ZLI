import type { GitBranchesResult, ReviewFileProjection, ReviewProjection, RpcResponse } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import {
  changeTotals,
  commitChanges,
  commitHint,
  commitPlan,
  diffUnavailable,
  filesToCommit,
  parseDiff,
  refreshChanges,
  refreshCommand,
  splitPath,
  spokenTotals,
  totalsLabel,
} from "./changes.js";
import type { LinkSnapshot } from "./link.js";

const worktreeId = "50000000-0000-4000-8000-000000000001";

function file(path: string, patch: Partial<ReviewFileProjection> = {}): ReviewFileProjection {
  return { path, kind: "modified", staged: false, unstaged: true, additions: 1, deletions: 0, binary: false, ...patch };
}

function review(files: ReviewFileProjection[], patch: Partial<ReviewProjection> = {}): ReviewProjection {
  return {
    worktreeId: worktreeId as never,
    baseRef: "HEAD",
    branch: "fix",
    state: files.length > 0 ? "changes" : "clean",
    files,
    conflictFiles: [],
    updatedAt: "2026-10-28T09:40:00.000Z",
    ...patch,
  };
}

const withOrigin: GitBranchesResult = {
  current: "fix",
  defaultBranch: "main",
  local: ["main", "fix"],
  remote: ["main", "fix"],
  details: { fix: { upstream: { name: "origin/fix", ahead: 0, behind: 0 } } },
};

/** A link whose projection the test changes by hand, answering commands with `answer`. */
function fakeLink(initial: ReviewProjection | undefined, answer: (command: { type: string }) => RpcResponse) {
  const listeners = new Set<() => void>();
  let snapshot = { projection: { reviews: initial ? [initial] : [] } } as unknown as LinkSnapshot;
  const sent: { type: string }[] = [];
  return {
    sent,
    setReview(next: ReviewProjection) {
      snapshot = { projection: { reviews: [next] } } as unknown as LinkSnapshot;
      for (const listener of listeners) listener();
    },
    link: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      command: async (command: Record<string, unknown> & { type: string }) => {
        sent.push(command);
        return answer(command);
      },
    },
  };
}

const accepted = (result?: unknown): RpcResponse =>
  ({ commandId: "c", accepted: true, ...(result === undefined ? {} : { result }) }) as RpcResponse;

describe("change totals", () => {
  it("counts files and lines the way the desktop shows them", () => {
    const totals = changeTotals([file("a.ts", { additions: 10, deletions: 2 }), file("b.ts", { additions: 2 })]);
    expect(totals).toEqual({ files: 2, additions: 12, deletions: 2 });
    expect(totalsLabel(totals)).toBe("+12 −2 in 2 files");
    expect(spokenTotals(totals)).toBe("12 lines added and 2 removed in 2 files");
    expect(totalsLabel(changeTotals([file("a.ts", { additions: 1_200 })]))).toBe("+1,200 −0 in 1 file");
    expect(totalsLabel(changeTotals([]))).toBe("No changes");
  });

  it("splits a path into the name and its folder", () => {
    expect(splitPath("src/auth/LoginForm.tsx")).toEqual({ name: "LoginForm.tsx", folder: "src/auth" });
    expect(splitPath("README.md")).toEqual({ name: "README.md", folder: "" });
    expect(splitPath("assets/new/")).toEqual({ name: "new", folder: "assets" });
  });

  it("reads changes against the desktop's base, or the last commit when there is none", () => {
    expect(refreshCommand(worktreeId, undefined)).toEqual({ type: "review.refresh", worktreeId, baseRef: "HEAD" });
    expect(refreshCommand(worktreeId, { baseRef: "main" }).baseRef).toBe("main");
  });

  it("says why a diff stays on the desktop", () => {
    const current = review([]);
    expect(diffUnavailable(file("a.ts"), current)).toBeUndefined();
    expect(diffUnavailable(file("logo.png", { binary: true }), current)).toBe("Binary file");
    expect(diffUnavailable(file("assets/", { kind: "untracked" }), current)).toBe("New folder");
    expect(diffUnavailable(file("a.ts", { unstaged: false }), review([], { baseRef: "main" }))).toBe(
      "Committed since main",
    );
  });
});

describe("commit plan", () => {
  it("commits and pushes uncommitted changes when the branch has an origin", () => {
    const plan = commitPlan(review([file("a.ts"), file("b.ts")]), withOrigin);
    expect(plan).toEqual({ kind: "commit", push: true, staged: false });
    if (plan.kind !== "commit") throw new Error("expected a commit");
    expect(commitHint(plan)).toBe("Commits every change, new files included, then pushes the branch to origin.");
    expect(filesToCommit(review([file("a.ts"), file("b.ts")]), plan)).toBe(2);
  });

  it("commits only what is staged when something is", () => {
    const current = review([file("a.ts", { staged: true, unstaged: false }), file("b.ts")]);
    const plan = commitPlan(current, withOrigin);
    expect(plan).toMatchObject({ kind: "commit", staged: true });
    if (plan.kind !== "commit") throw new Error("expected a commit");
    expect(filesToCommit(current, plan)).toBe(1);
  });

  it("only commits when there is no origin", () => {
    const local: GitBranchesResult = { current: "fix", local: ["fix"], remote: [] };
    const plan = commitPlan(review([file("a.ts")]), local);
    expect(plan).toEqual({ kind: "commit", push: false, staged: false });
    if (plan.kind !== "commit") throw new Error("expected a commit");
    expect(commitHint(plan)).toBe("Commits every change, new files included. There is no origin to push to.");
  });

  it("pushes commits that are waiting, and offers nothing on a clean, pushed branch", () => {
    const ahead: GitBranchesResult = {
      ...withOrigin,
      details: { fix: { upstream: { name: "origin/fix", ahead: 2, behind: 0 } } },
    };
    expect(commitPlan(review([]), ahead)).toEqual({ kind: "push", reason: "2 commits to push against origin/fix." });
    expect(commitPlan(review([]), { ...withOrigin, remote: ["main"], details: {} })).toEqual({
      kind: "push",
      reason: "fix is not on origin yet.",
    });
    expect(commitPlan(review([]), withOrigin)).toEqual({ kind: "none", reason: "No changes to commit." });
  });

  it("waits out a merge and an unread review", () => {
    expect(commitPlan(review([file("a.ts")], { state: "conflicted" }), withOrigin).kind).toBe("none");
    expect(commitPlan(undefined, withOrigin)).toEqual({ kind: "none", reason: "Reading the changes." });
  });
});

describe("committing from the phone", () => {
  it("commits, waits for Git's new review, then pushes", async () => {
    const fake = fakeLink(review([file("a.ts")]), (command) =>
      command.type === "review.pr.push" ? accepted({ branch: "fix", remote: "origin" }) : accepted(),
    );
    const done = commitChanges(fake.link, { worktreeId, message: "  Fix the form  ", push: true });
    await Promise.resolve();
    fake.setReview(review([], { updatedAt: "2026-10-28T09:41:00.000Z" }));
    expect(await done).toEqual({ ok: true, notice: "Committed and pushed fix to origin." });
    expect(fake.sent).toEqual([
      { type: "review.commit", worktreeId, message: "Fix the form" },
      { type: "review.pr.push", worktreeId },
    ]);
  });

  it("reports Git's error and does not push", async () => {
    const fake = fakeLink(review([file("a.ts")]), () => accepted());
    const done = commitChanges(fake.link, { worktreeId, message: "Fix", push: true });
    await Promise.resolve();
    fake.setReview(review([file("a.ts")], { updatedAt: "later", errorMessage: "Author identity unknown" }));
    expect(await done).toEqual({ ok: false, error: "Author identity unknown" });
    expect(fake.sent.map((command) => command.type)).toEqual(["review.commit"]);
  });

  it("says when the commit was made but the push failed", async () => {
    const fake = fakeLink(review([file("a.ts")]), (command) =>
      command.type === "review.pr.push"
        ? ({
            commandId: "c",
            accepted: false,
            error: { code: "internal", message: "No origin.", retryable: false },
          } as RpcResponse)
        : accepted(),
    );
    const done = commitChanges(fake.link, { worktreeId, message: "Fix", push: true });
    await Promise.resolve();
    fake.setReview(review([], { updatedAt: "later" }));
    expect(await done).toEqual({ ok: false, error: "Committed, but the push failed. No origin." });
  });

  it("stops waiting when Git does not answer, and refuses an empty message", async () => {
    const fake = fakeLink(review([file("a.ts")]), () => accepted());
    const outcome = await commitChanges(fake.link, { worktreeId, message: "Fix", push: false }, 5);
    expect(outcome.ok).toBe(false);
    expect(await commitChanges(fake.link, { worktreeId, message: "   ", push: false })).toEqual({
      ok: false,
      error: "Write a commit message first.",
    });
  });

  it("refreshes against the current base and waits for the new list", async () => {
    const fake = fakeLink(review([], { baseRef: "main" }), () => accepted());
    const done = refreshChanges(fake.link, worktreeId);
    await Promise.resolve();
    fake.setReview(review([file("a.ts")], { baseRef: "main", updatedAt: "later" }));
    expect(await done).toEqual({ ok: true });
    expect(fake.sent).toEqual([{ type: "review.refresh", worktreeId, baseRef: "main" }]);
  });
});

describe("parseDiff", () => {
  const patch = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,3 +10,3 @@ function submit() {",
    " const form = useForm();",
    "-form.onKeyDown(submit);",
    "+form.onSubmit(submit);",
    "\tdone();",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  it("drops the file header and numbers lines from the hunk header", () => {
    const parsed = parseDiff(patch);
    expect(parsed.lines).toEqual([
      { kind: "hunk", text: "@@ -10,3 +10,3 @@ function submit() {" },
      { kind: "context", text: " const form = useForm();", number: 10 },
      { kind: "del", text: "-form.onKeyDown(submit);", number: 11 },
      { kind: "add", text: "+form.onSubmit(submit);", number: 11 },
      { kind: "context", text: "    done();", number: 12 },
      { kind: "note", text: "\\ No newline at end of file" },
    ]);
    expect(parsed).toMatchObject({ total: 6, truncated: false, clipped: false });
  });

  it("reads a new file's patch, which starts at its hunk", () => {
    expect(parseDiff("@@ -0,0 +1,2 @@\n+one\n+two\n").lines.map((line) => line.number)).toEqual([undefined, 1, 2]);
  });

  it("keeps a large diff to the line limit and cuts very long lines", () => {
    const body = Array.from({ length: 50 }, (_, index) => `+line ${index}`).join("\n");
    const parsed = parseDiff(`@@ -0,0 +1,50 @@\n${body}\n+${"x".repeat(30)}\n`, { lines: 10, chars: 12 });
    expect(parsed.lines).toHaveLength(10);
    expect(parsed).toMatchObject({ total: 52, truncated: true });
    const long = parseDiff(`@@ -0,0 +1 @@\n+${"x".repeat(30)}\n`, { lines: 10, chars: 12 });
    expect(long.lines[1]?.text).toBe(`+${"x".repeat(11)}…`);
    expect(long.clipped).toBe(true);
  });
});
